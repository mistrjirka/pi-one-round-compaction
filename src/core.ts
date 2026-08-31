import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  contentText,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  sessionEntryToContextMessages,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { OneRoundCompactionConfig, ThinkingLevel } from "./config.js";
import { renderIntentWorkflow, type ActiveIntentWorkflow } from "./intent-workflow.js";
import { SPLIT_TURN_NOTE } from "./prompts.js";

const execFileAsync = promisify(execFile);

export type LaneName = "intent" | "execution";

export interface LaneResolvedConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
}

export interface LaneResult {
  lane: LaneName;
  text: string;
  usage: Usage;
  model: string;
  thinkingLevel: ThinkingLevel;
  durationMs: number;
}

export interface GitState {
  root: string;
  branch: string;
  head: string;
  dirty: string[];
  truncated: boolean;
}

export interface UserMessageLedgerEntry {
  timestamp: number;
  text: string;
  originalChars: number;
  trimmed: boolean;
}

export interface DeterministicRenderBudgets {
  intentWorkflowChars: number;
  gitStateChars: number;
  editedFilesChars: number;
  readFilesChars: number;
  userMessagesChars: number;
}

export interface DeterministicState {
  git?: GitState;
  /** Cumulative Pi-compatible file metadata retained in details for recovery/diagnostics. */
  readFiles: string[];
  modifiedFiles: string[];
  /** Trace-local paths ordered newest touch first; these are what the checkpoint renders. */
  traceReadFiles: string[];
  traceEditedFiles: string[];
  /** Cumulative user ledger up to the current compaction boundary. */
  userMessages: UserMessageLedgerEntry[];
  intentWorkflow?: ActiveIntentWorkflow;
}

export interface OneRoundDetails {
  plugin: "pi-one-round-compaction";
  version: 3;
  lanes: Array<{
    lane: LaneName;
    model: string;
    thinkingLevel: ThinkingLevel;
    durationMs: number;
    usage: Usage;
  }>;
  wallTimeMs: number;
  keepRecentTokens: number;
  boundaryMode: "whole-turn" | "split-turn" | "pi-fallback";
  retainedTurns: number;
  estimatedRetainedTokens: number;
  targetPostCompactTokens: number;
  effectiveRecentTokenBudget: number;
  estimatedTokensAfter: number;
  targetExceeded: boolean;
  isSplitTurn: boolean;
  readFiles: string[];
  modifiedFiles: string[];
  traceReadFiles: string[];
  traceEditedFiles: string[];
  userMessages: UserMessageLedgerEntry[];
  renderBudgets: DeterministicRenderBudgets;
  git?: GitState;
  intentWorkflow: {
    active: boolean;
    workstream?: string;
    hasPlan?: boolean;
    intentTruncated?: boolean;
    planTruncated?: boolean;
  };
}

type CompactionMessage = Parameters<typeof convertToLlm>[0][number];

export interface WholeTurnPreparation {
  messagesToSummarize: CompactionMessage[];
  firstKeptEntryId: string;
  previousSummary: string | undefined;
  retainedTurns: number;
  estimatedRetainedTokens: number;
  boundaryMode: "whole-turn" | "split-turn" | "pi-fallback";
  isSplitTurn: boolean;
}

type PromptBuildInput = {
  lane: LaneName;
  lanePrompt: string;
  serializedConversation: string;
  previousSummary: string | undefined;
  customInstructions: string | undefined;
  deterministic: DeterministicState;
  renderBudgets: DeterministicRenderBudgets;
  isSplitTurn: boolean;
};

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} chars omitted]`;
}

function serializeToolCallArguments(value: unknown, maxChars = 3000): string {
  try {
    return clip(JSON.stringify(value), maxChars);
  } catch {
    return "[unserializable arguments]";
  }
}

/**
 * High-signal view for the task-semantics lane: user text and concise assistant
 * conclusions, with tool output and hidden reasoning omitted.
 */
export function serializeIntentView(messages: Parameters<typeof convertToLlm>[0]): string {
  const llmMessages = convertToLlm(messages);
  const parts: string[] = [];

  for (const message of llmMessages) {
    if (message.role === "user") {
      const text = contentText(message.content, "").trim();
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (message.role === "assistant") {
      const text = contentText(message.content, "").trim();
      if (text) parts.push(`[Assistant]: ${clip(text, 3500)}`);
      const tools = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.name);
      if (tools.length > 0) parts.push(`[Assistant tools]: ${tools.join(", ")}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Execution-oriented view. Tool outputs are capped and old hidden reasoning is
 * omitted by default; both controls are configurable.
 */
export function serializeExecutionView(
  messages: Parameters<typeof convertToLlm>[0],
  toolResultChars: number,
  thinkingChars: number,
): string {
  const llmMessages = convertToLlm(messages);
  const parts: string[] = [];

  for (const message of llmMessages) {
    if (message.role === "user") {
      const text = contentText(message.content, "").trim();
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (message.role === "assistant") {
      const assistantParts: string[] = [];
      const text = contentText(message.content, "").trim();
      if (text) assistantParts.push(`[Assistant]: ${text}`);

      if (thinkingChars > 0) {
        const thinking = message.content
          .filter((part) => part.type === "thinking")
          .map((part) => part.thinking)
          .join("\n")
          .trim();
        if (thinking) assistantParts.push(`[Assistant thinking]: ${clip(thinking, thinkingChars)}`);
      }

      const toolCalls = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => `${part.name}(${serializeToolCallArguments(part.arguments)})`);
      if (toolCalls.length > 0) assistantParts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);

      if (assistantParts.length > 0) parts.push(assistantParts.join("\n"));
      continue;
    }

    if (message.role === "toolResult") {
      const text = contentText(message.content, "").trim();
      if (text) parts.push(`[Tool result]: ${clip(text, toolResultChars)}`);
    }
  }

  return parts.join("\n\n");
}

export function extractRecentUserContext(
  messages: Parameters<typeof convertToLlm>[0],
  maxChars: number,
): string[] {
  if (maxChars <= 0) return [];
  const users = convertToLlm(messages)
    .filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    .map((message) => contentText(message.content, "").trim())
    .filter(Boolean);

  const selected: string[] = [];
  let used = 0;
  for (let i = users.length - 1; i >= 0; i--) {
    const text = users[i]!;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (text.length <= remaining) {
      selected.push(text);
      used += text.length;
      continue;
    }
    selected.push(`${text.slice(0, remaining)}\n[… user message truncated]`);
    break;
  }
  return selected.reverse();
}

function stripUserTrimMarker(text: string): string {
  return text.replace(/\n\[TRIMMED: original [^\]]+ chars\]$/, "");
}

function capUserMessage(
  text: string,
  maxChars: number,
  knownOriginalChars: number = text.length,
): Pick<UserMessageLedgerEntry, "text" | "originalChars" | "trimmed"> {
  const source = stripUserTrimMarker(text);
  const originalChars = Math.max(knownOriginalChars, source.length);
  if (originalChars <= maxChars && source.length <= maxChars) {
    return { text: source, originalChars, trimmed: false };
  }
  const marker = `\n[TRIMMED: original ${originalChars.toLocaleString()} chars]`;
  const head = Math.max(0, maxChars - marker.length);
  return {
    text: `${source.slice(0, head)}${marker}`,
    originalChars,
    trimmed: true,
  };
}

/**
 * Build a cumulative exact-user-message ledger from the whole persisted branch,
 * stopping at the raw suffix that will remain after this compaction. Every
 * message is individually bounded so one giant prompt cannot dominate the
 * deterministic checkpoint.
 */
export function collectUserMessageLedger(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
  perMessageChars: number,
): UserMessageLedgerEntry[] {
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  const end = firstKeptIndex >= 0 ? firstKeptIndex : branchEntries.length;
  const ledger: UserMessageLedgerEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: UserMessageLedgerEntry): void => {
    const identityPrefix = stripUserTrimMarker(entry.text).slice(0, 160);
    const key = `${entry.timestamp}\u0000${entry.originalChars}\u0000${identityPrefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    ledger.push(entry);
  };

  // Details v3 carries the cumulative ledger explicitly. This protects history
  // even if a future Pi SessionManager stops exposing pre-compaction raw entries.
  for (let i = 0; i < end; i++) {
    const entry = branchEntries[i]!;
    if (entry.type !== "compaction" || !isObject(entry.details)) continue;
    const prior = entry.details.userMessages;
    if (!Array.isArray(prior)) continue;
    for (const value of prior) {
      if (!isObject(value)) continue;
      if (typeof value.text !== "string" || typeof value.originalChars !== "number") continue;
      const timestamp = typeof value.timestamp === "number" ? value.timestamp : Date.parse(entry.timestamp) || 0;
      const capped = capUserMessage(value.text, perMessageChars, value.originalChars);
      add({
        timestamp,
        ...capped,
        trimmed: value.trimmed === true || capped.trimmed,
      });
    }
  }

  // Also reconstruct from the persisted raw branch. Current Pi keeps those entries,
  // so this is exact and works when upgrading from details v1/v2.
  for (let i = 0; i < end; i++) {
    const entry = branchEntries[i]!;
    const fallbackTimestamp = Date.parse(entry.timestamp) || 0;
    for (const message of convertToLlm(entryMessagesForCompaction(entry))) {
      if (message.role !== "user") continue;
      const text = contentText(message.content, "").trim();
      if (!text) continue;
      const capped = capUserMessage(text, perMessageChars);
      add({
        timestamp: typeof message.timestamp === "number" ? message.timestamp : fallbackTimestamp,
        ...capped,
      });
    }
  }

  return ledger.sort((a, b) => a.timestamp - b.timestamp);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isTurnStartMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case "user":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    case "assistant":
    case "toolResult":
      return false;
  }
  return false;
}

function entryMessagesForCompaction(entry: SessionEntry): CompactionMessage[] {
  if (entry.type === "compaction") return [];
  return sessionEntryToContextMessages(entry) as CompactionMessage[];
}

function estimateEntryRangeTokens(entries: SessionEntry[], start: number, end: number): number {
  let tokens = 0;
  for (let i = start; i < end; i++) {
    for (const message of entryMessagesForCompaction(entries[i]!)) tokens += estimateTokens(message);
  }
  return tokens;
}

function collectEntryRangeMessages(entries: SessionEntry[], start: number, end: number): CompactionMessage[] {
  const messages: CompactionMessage[] = [];
  for (let i = start; i < end; i++) messages.push(...entryMessagesForCompaction(entries[i]!));
  return messages;
}

function previousCompactionBoundary(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "compaction") continue;
    const firstKeptIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    return firstKeptIndex >= 0 ? firstKeptIndex : i + 1;
  }
  return 0;
}

/**
 * Reserve enough room for both LLM lane outputs and bounded deterministic state,
 * then spend the remainder on raw recent context. The floor keeps compaction from
 * becoming context-starved; the target is therefore soft when the configured target
 * is unrealistically small.
 */
export function computeEffectiveRecentTokenBudget(params: {
  targetPostCompactTokens: number;
  keepRecentTokens: number;
  laneOutputReserveTokens: number;
  deterministicReserveChars: number;
  overheadReserveTokens?: number;
  minimumRecentTokens?: number;
}): number {
  const keep = Math.max(0, params.keepRecentTokens);
  if (keep === 0) return 0;
  const overhead = params.overheadReserveTokens ?? 1_000;
  const minimum = Math.min(keep, params.minimumRecentTokens ?? 6_000);
  const deterministicTokens = Math.ceil(Math.max(0, params.deterministicReserveChars) / 4);
  const available = params.targetPostCompactTokens
    - Math.max(0, params.laneOutputReserveTokens)
    - deterministicTokens
    - overhead;
  return Math.min(keep, Math.max(minimum, available));
}

function isCutPointMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case "user":
    case "assistant":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    case "toolResult":
      return false;
  }
  return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
  return entryMessagesForCompaction(entry).some(isTurnStartMessage);
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (isTurnStartEntry(entries[i]!)) return i;
  }
  return -1;
}

/**
 * Pi's public preparation is based on its configured keepRecentTokens. When our
 * post-compaction target needs a smaller raw suffix, reproduce the same safe
 * message-boundary rule with the effective budget. Tool results are never orphaned
 * from their preceding assistant tool call.
 */
function prepareBudgetedSplit(
  entries: SessionEntry[],
  boundaryStart: number,
  recentTokenBudget: number,
  previousSummary: string | undefined,
): WholeTurnPreparation | undefined {
  const cutPoints: number[] = [];
  for (let i = boundaryStart; i < entries.length; i++) {
    if (entryMessagesForCompaction(entries[i]!).some(isCutPointMessage)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return undefined;

  let thresholdIndex = boundaryStart;
  let accumulated = 0;
  const target = Math.max(1, recentTokenBudget);
  for (let i = entries.length - 1; i >= boundaryStart; i--) {
    accumulated += estimateEntryRangeTokens(entries, i, i + 1);
    if (accumulated >= target) {
      thresholdIndex = i;
      break;
    }
  }

  let cutIndex = cutPoints[cutPoints.length - 1]!;
  for (const candidate of cutPoints) {
    if (candidate >= thresholdIndex) {
      cutIndex = candidate;
      break;
    }
  }

  const startsTurn = isTurnStartEntry(entries[cutIndex]!);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, boundaryStart);
  const isSplitTurn = !startsTurn && turnStartIndex >= boundaryStart;
  const historyEnd = isSplitTurn ? turnStartIndex : cutIndex;
  const messagesToSummarize = collectEntryRangeMessages(entries, boundaryStart, historyEnd);
  if (isSplitTurn) {
    messagesToSummarize.push(...collectEntryRangeMessages(entries, turnStartIndex, cutIndex));
  }
  if (messagesToSummarize.length === 0) return undefined;

  const firstKept = entries[cutIndex];
  if (!firstKept?.id) return undefined;
  const retainedTokens = estimateEntryRangeTokens(entries, cutIndex, entries.length);
  let retainedTurns = 0;
  for (let i = cutIndex; i < entries.length; i++) {
    if (isTurnStartEntry(entries[i]!)) retainedTurns++;
  }

  return {
    messagesToSummarize,
    firstKeptEntryId: firstKept.id,
    previousSummary,
    retainedTurns,
    estimatedRetainedTokens: retainedTokens,
    boundaryMode: isSplitTurn ? "split-turn" : "whole-turn",
    isSplitTurn,
  };
}

/**
 * Keep the newest complete turns whose estimated total fits recentTokenBudget.
 * If the newest turn alone exceeds that budget, split the turn at a provider-safe
 * message boundary rather than retaining a 100k+ tool-heavy turn verbatim.
 */
export function prepareWholeTurnCompaction(
  event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">,
  recentTokenBudget: number = event.preparation.settings.keepRecentTokens,
): WholeTurnPreparation {
  const entries = event.branchEntries;
  const boundaryStart = previousCompactionBoundary(entries);
  const turnStarts: number[] = [];

  for (let i = boundaryStart; i < entries.length; i++) {
    if (isTurnStartEntry(entries[i]!)) turnStarts.push(i);
  }

  if (turnStarts.length > 0) {
    let selectedTurn = turnStarts.length - 1;
    let retainedTokens = estimateEntryRangeTokens(entries, turnStarts[selectedTurn]!, entries.length);

    if (retainedTokens <= recentTokenBudget) {
      for (let turn = selectedTurn - 1; turn >= 0; turn--) {
        const startIndex = turnStarts[turn]!;
        const endIndex = turnStarts[turn + 1]!;
        const turnTokens = estimateEntryRangeTokens(entries, startIndex, endIndex);
        if (retainedTokens + turnTokens > recentTokenBudget) break;
        retainedTokens += turnTokens;
        selectedTurn = turn;
      }

      const firstKeptIndex = turnStarts[selectedTurn]!;
      const messagesToSummarize = collectEntryRangeMessages(entries, boundaryStart, firstKeptIndex);
      const firstKept = entries[firstKeptIndex];
      if (messagesToSummarize.length > 0 && firstKept?.id) {
        return {
          messagesToSummarize,
          firstKeptEntryId: firstKept.id,
          previousSummary: event.preparation.previousSummary,
          retainedTurns: turnStarts.length - selectedTurn,
          estimatedRetainedTokens: retainedTokens,
          boundaryMode: "whole-turn",
          isSplitTurn: false,
        };
      }
    } else {
      const split = prepareBudgetedSplit(
        entries,
        boundaryStart,
        recentTokenBudget,
        event.preparation.previousSummary,
      );
      if (split) return split;
    }
  }

  // Last-resort compatibility path for unusual entry shapes that our public
  // boundary scan cannot classify. Pi already prepared a valid provider-safe cut.
  const fallbackMessages = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  const fallbackFirstIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  const retainedTokens = fallbackFirstIndex >= 0
    ? estimateEntryRangeTokens(entries, fallbackFirstIndex, entries.length)
    : event.preparation.settings.keepRecentTokens;
  const retainedTurns = fallbackFirstIndex >= 0
    ? turnStarts.filter((turnStart) => turnStart >= fallbackFirstIndex).length
    : 0;

  return {
    messagesToSummarize: fallbackMessages,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    previousSummary: event.preparation.previousSummary,
    retainedTurns,
    estimatedRetainedTokens: retainedTokens,
    boundaryMode: "pi-fallback",
    isSplitTurn: event.preparation.isSplitTurn,
  };
}

function classifyFileTool(name: string): "read" | "edit" | undefined {
  const normalized = name.toLowerCase();
  if (normalized === "edit" || normalized === "write" || normalized.endsWith("_edit") || normalized.endsWith("_write")) {
    return "edit";
  }
  if (normalized === "read" || normalized.endsWith("_read")) return "read";
  return undefined;
}

export function collectFileState(
  event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">,
  actualDiscardedMessages: CompactionMessage[] = [],
): {
  readFiles: string[];
  modifiedFiles: string[];
  traceReadFiles: string[];
  traceEditedFiles: string[];
} {
  const read = new Set(event.preparation.fileOps.read);
  const modified = new Set([
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);
  const traceRead = new Map<string, number>();
  const traceEdited = new Map<string, number>();
  let ordinal = 0;

  // Scan exactly the messages this compaction discards. The last observed touch
  // wins so rendered file state is ordered by recency rather than alphabetically.
  for (const message of convertToLlm(actualDiscardedMessages)) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !isObject(part.arguments)) continue;
      const filePath = typeof part.arguments.path === "string" ? part.arguments.path : undefined;
      if (!filePath) continue;
      const effect = classifyFileTool(part.name);
      if (effect === "read") {
        read.add(filePath);
        traceRead.set(filePath, ordinal++);
      }
      if (effect === "edit") {
        modified.add(filePath);
        traceEdited.set(filePath, ordinal++);
      }
    }
  }

  // Keep Pi-compatible cumulative metadata in details for later recovery, but do
  // not render it as if every historical file was edited in this trace.
  for (let i = event.branchEntries.length - 1; i >= 0; i--) {
    const entry = event.branchEntries[i]!;
    if (entry.type !== "compaction") continue;
    if (isObject(entry.details)) {
      for (const file of strings(entry.details.readFiles)) read.add(file);
      for (const file of strings(entry.details.modifiedFiles)) modified.add(file);
    }
    break;
  }

  for (const file of modified) read.delete(file);
  for (const file of traceEdited.keys()) traceRead.delete(file);
  const newestFirst = (map: Map<string, number>) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);

  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
    traceReadFiles: newestFirst(traceRead),
    traceEditedFiles: newestFirst(traceEdited),
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2500,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trim();
}

function dirtyLinePath(line: string): string | undefined {
  const raw = line.length > 3 ? line.slice(3).trim() : "";
  if (!raw) return undefined;
  const destination = raw.includes(" -> ") ? raw.slice(raw.lastIndexOf(" -> ") + 4) : raw;
  // Quoted porcelain paths can contain C-style escapes. Leave those in stable Git
  // order rather than pretending we can map them reliably to an fs timestamp.
  if (destination.startsWith('"') && destination.endsWith('"')) return undefined;
  return destination;
}

export async function collectGitState(cwd: string): Promise<GitState | undefined> {
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const [branch, head, statusText] = await Promise.all([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["rev-parse", "--short=12", "HEAD"]),
      runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    const allDirty = statusText ? statusText.split("\n").filter(Boolean) : [];
    const ranked = await Promise.all(allDirty.map(async (line, index) => {
      const relative = dirtyLinePath(line);
      if (!relative) return { line, mtimeMs: 0, index };
      try {
        const info = await stat(path.join(root, relative));
        return { line, mtimeMs: info.mtimeMs, index };
      } catch {
        // Deleted/renamed-away paths have no current mtime. Keep their Git order
        // after paths for which a current modification time exists.
        return { line, mtimeMs: 0, index };
      }
    }));
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs || b.index - a.index);
    const dirty = ranked.slice(0, 200).map((item) => item.line);
    return {
      root,
      branch: branch || "(detached)",
      head,
      dirty,
      truncated: allDirty.length > dirty.length,
    };
  } catch {
    return undefined;
  }
}

function clipAtLineBoundary(text: string, maxChars: number, marker: string): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - marker.length - 1);
  const prefix = text.slice(0, room);
  const boundary = prefix.lastIndexOf("\n");
  const kept = boundary > Math.floor(room * 0.55) ? prefix.slice(0, boundary) : prefix;
  return `${kept}\n${marker}`;
}

function renderPathList(title: string, paths: string[], maxChars: number): string {
  if (maxChars <= 0 || paths.length === 0) return "";
  const lines = [`### ${title}`];
  let used = lines[0]!.length;
  let included = 0;
  for (const file of paths) {
    const line = `- ${file}`;
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
    included++;
  }
  if (included < paths.length) {
    const marker = `[… ${paths.length - included} older path(s) omitted; full list retained in compaction details]`;
    if (used + 1 + marker.length <= maxChars) lines.push(marker);
  }
  return lines.join("\n");
}

function renderGitState(git: GitState, maxChars: number): string {
  if (maxChars <= 0) return "";
  const lines = [
    "### Git state",
    "```text",
    `root: ${git.root}`,
    `branch: ${git.branch}`,
    `HEAD: ${git.head}`,
    "working tree (most recently modified first when mtime is available):",
    ...(git.dirty.length > 0 ? git.dirty : ["(clean)"]),
    ...(git.truncated ? ["[… additional dirty paths omitted]"] : []),
    "```",
  ];
  return clipAtLineBoundary(
    lines.join("\n"),
    maxChars,
    "[… git state clipped; full structured state retained in compaction details]",
  );
}

function renderUserMessageBody(entry: UserMessageLedgerEntry, bodyChars: number): string {
  if (bodyChars <= 0) return "";
  const compact = entry.text.replace(/\s*\n\s*/g, " ↵ ");
  if (compact.length <= bodyChars) return compact;
  const marker = ` … [VIEW TRIMMED: original ${entry.originalChars.toLocaleString()} chars]`;
  if (marker.length >= bodyChars) return `${compact.slice(0, Math.max(0, bodyChars - 1))}…`;
  return `${compact.slice(0, bodyChars - marker.length).trimEnd()}${marker}`;
}

function renderUserMessageLedger(entries: UserMessageLedgerEntry[], maxChars: number): string {
  if (maxChars <= 0 || entries.length === 0) return "";
  const heading = `### Cumulative compacted user-message ledger (${entries.length} message(s))`;
  if (heading.length >= maxChars) return heading.slice(0, maxChars);

  // Use one compact numbered line per message. This keeps every historical user
  // message represented under ordinary budgets instead of spending dozens of
  // structural characters on a heading for each message. The complete per-message
  // capped text remains in structured details.
  const prefixes = entries.map((_, index) => `${index + 1}. `);
  const structural = heading.length + 1 + prefixes.reduce((sum, prefix) => sum + prefix.length + 1, 0);
  if (structural >= maxChars) {
    return clipAtLineBoundary(
      `${heading}\n[${entries.length} message records retained in compaction details]`,
      maxChars,
      "[… user ledger metadata clipped]",
    );
  }

  const availableBodies = maxChars - structural;
  const bodyChars = Math.min(900, Math.max(1, Math.floor(availableBodies / entries.length)));
  const lines = entries.map((entry, index) => `${prefixes[index]}${renderUserMessageBody(entry, bodyChars)}`);
  return [heading, ...lines].join("\n");
}

function renderDeterministicState(
  state: DeterministicState,
  budgets: DeterministicRenderBudgets,
): string {
  const sections: string[] = [];
  if (state.git) {
    const git = renderGitState(state.git, budgets.gitStateChars);
    if (git) sections.push(git);
  }
  const edited = renderPathList(
    "Files edited/written in this compacted trace (most recent first)",
    state.traceEditedFiles,
    budgets.editedFilesChars,
  );
  if (edited) sections.push(edited);
  const read = renderPathList(
    "Files read in this compacted trace (most recent first)",
    state.traceReadFiles,
    budgets.readFilesChars,
  );
  if (read) sections.push(read);
  const users = renderUserMessageLedger(state.userMessages, budgets.userMessagesChars);
  if (users) sections.push(users);
  return sections.join("\n\n");
}

/**
 * Previous checkpoints contain stale copies of deterministic state. Feed only the
 * previous output owned by this same lane back into the next LLM request. Current
 * intent/Git/user/file state is reconstructed independently below.
 */
export function compactPreviousSummaryForPrompt(
  summary: string | undefined,
  lane: LaneName = "execution",
  workflowActive = false,
  maxChars = 12_000,
): string | undefined {
  const source = summary?.trim();
  if (!source) return undefined;

  const startMarker = workflowActive
    ? (lane === "intent" ? "## Implementation State" : "## Verification / Evidence State")
    : (lane === "intent" ? "## Task Semantics" : "## Execution State");
  const start = source.indexOf(startMarker);
  if (start < 0) return clip(source, maxChars);

  const endMarkers = workflowActive
    ? lane === "intent"
      ? ["\n## Verification / Evidence State"]
      : ["\n## Deterministic Repository / Recent User State", "\n## Deterministic Repository / User State", "\n## Split-turn Context"]
    : lane === "intent"
      ? ["\n## Execution State"]
      : ["\n## Deterministic State", "\n## Split-turn Context"];

  let end = source.length;
  for (const marker of endMarkers) {
    const index = source.indexOf(marker, start + startMarker.length);
    if (index >= 0) end = Math.min(end, index);
  }
  return clip(source.slice(start, end).trim(), maxChars);
}

export function buildLanePrompt(input: PromptBuildInput): string {
  const sections: string[] = [input.lanePrompt.trim()];

  if (input.customInstructions?.trim()) {
    sections.push(`## Explicit compaction focus\n${input.customInstructions.trim()}`);
  }

  const previous = compactPreviousSummaryForPrompt(
    input.previousSummary,
    input.lane,
    Boolean(input.deterministic.intentWorkflow),
  );
  if (previous) {
    sections.push(
      `## Previous LLM checkpoint state (fallible historical state)\nOnly prior LLM continuation/evidence state is carried here. Fresh deterministic evidence below overrides it.\n\n${previous}`,
    );
  }

  if (input.deterministic.intentWorkflow) {
    sections.push(
      `## Active intent-workflow ledger\nThis ledger is re-read from disk for every compaction. It is context, not authority over newer explicit user instructions. The plan body is only a bounded excerpt; the final checkpoint stores its path rather than duplicating the full plan.\n\n${renderIntentWorkflow(input.deterministic.intentWorkflow, {
        maxChars: input.renderBudgets.intentWorkflowChars,
        includePlanBody: true,
        planChars: Math.min(2_500, Math.floor(input.renderBudgets.intentWorkflowChars * 0.35)),
      })}`,
    );
  }

  const deterministic = renderDeterministicState(input.deterministic, input.renderBudgets);
  if (deterministic) {
    sections.push(`## Fresh deterministic repository/user evidence\nThis block is authoritative where it states direct facts. Newer explicit user messages override older ledger/context state.\n\n${deterministic}`);
  }

  if (input.isSplitTurn) sections.push(`## Boundary note\n${SPLIT_TURN_NOTE}`);
  sections.push(`## Older conversation being compacted\n\n<conversation>\n${input.serializedConversation}\n</conversation>`);
  return sections.join("\n\n");
}

export function parseModelReference(reference: string): { provider: string; modelId: string } | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  const provider = reference.slice(0, slash).trim();
  const modelId = reference.slice(slash + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

function reasoningEffortFor(model: Model<any>, thinkingLevel: ThinkingLevel): string | undefined {
  if (thinkingLevel === "off" || !model.reasoning) return undefined;
  if (model.thinkingLevelMap && model.thinkingLevelMap[thinkingLevel] === null) {
    throw new Error(`${model.provider}/${model.id} does not support thinking level '${thinkingLevel}'`);
  }

  switch (model.api) {
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
    case "openai-completions":
      return thinkingLevel;
    default:
      return undefined;
  }
}

function assistantText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function runLane(params: {
  lane: LaneName;
  config: LaneResolvedConfig;
  prompt: string;
  systemPrompt: string;
  ctx: ExtensionContext;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<LaneResult> {
  const reference = parseModelReference(params.config.model);
  if (!reference) throw new Error(`Invalid model reference '${params.config.model}'; expected provider/model`);
  const model = params.ctx.modelRegistry.find(reference.provider, reference.modelId);
  if (!model) throw new Error(`Model not found: ${params.config.model}`);

  const reasoningEffort = reasoningEffortFor(model, params.config.thinkingLevel);
  const started = performance.now();
  const requestContext = {
    systemPrompt: params.systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: params.prompt }],
        timestamp: Date.now(),
      },
    ],
  };
  const baseOptions: ProviderStreamOptions = {
    maxTokens: Math.min(params.config.maxOutputTokens, model.maxTokens || params.config.maxOutputTokens),
    signal: params.signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };

  let response: AssistantMessage | undefined;
  const registryRuntime = params.ctx.modelRegistry as unknown as Record<string, unknown>;
  const canObserveStream =
    Boolean(params.onTextDelta) &&
    typeof registryRuntime.getProvider === "function" &&
    typeof registryRuntime.getApiKeyAndHeaders === "function";

  if (!canObserveStream) {
    // Streaming progress is optional. Older/alternate vanilla Pi hosts can use
    // the stable completion facade and still expose lane start/done/merge state.
    response = await params.ctx.modelRegistry.complete(model, requestContext, baseOptions);
  } else {
    // Current Pi's ModelRegistry exposes complete() but not stream(). Its public
    // provider/auth accessors let us invoke the same composed provider and observe
    // text deltas. ModelRuntime.complete() itself is stream(...).result().
    const provider = params.ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error(`Provider not found: ${model.provider}`);
    const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`${params.lane} lane auth failed: ${auth.error}`);

    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const options: ProviderStreamOptions = {
      ...baseOptions,
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      ...(auth.env !== undefined ? { env: auth.env } : {}),
    };

    const stream = provider.stream(requestModel, requestContext, options);
    for await (const event of stream) {
      if (event.type === "text_delta") {
        params.onTextDelta?.(event.delta);
        continue;
      }
      if (event.type === "done") {
        response = event.message;
        continue;
      }
      if (event.type === "error") {
        response = event.error;
      }
    }

    if (!response) throw new Error(`${params.lane} lane stream ended without a final response`);
  }
  if (params.signal.aborted || response.stopReason === "aborted") {
    throw new Error(`${params.lane} lane aborted`);
  }
  if (response.stopReason === "error") {
    throw new Error(`${params.lane} lane failed: ${response.errorMessage || "provider error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error(`${params.lane} lane hit maxOutputTokens; refusing to persist a partial checkpoint`);
  }
  if (response.content.some((part) => part.type === "toolCall")) {
    throw new Error(`${params.lane} lane attempted to call a tool`);
  }

  const text = assistantText(response);
  if (!text) throw new Error(`${params.lane} lane returned empty output`);

  return {
    lane: params.lane,
    text,
    usage: response.usage,
    model: `${model.provider}/${model.id}`,
    thinkingLevel: params.config.thinkingLevel,
    durationMs: Math.round(performance.now() - started),
  };
}

export function combineUsage(usages: Usage[]): Usage | undefined {
  const [first, ...rest] = usages;
  if (!first) return undefined;
  return rest.reduce<Usage>((sum, usage) => ({
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
    ...(sum.cacheWrite1h !== undefined || usage.cacheWrite1h !== undefined
      ? { cacheWrite1h: (sum.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }
      : {}),
    ...(sum.reasoning !== undefined || usage.reasoning !== undefined
      ? { reasoning: (sum.reasoning ?? 0) + (usage.reasoning ?? 0) }
      : {}),
    totalTokens: sum.totalTokens + usage.totalTokens,
    cost: {
      input: sum.cost.input + usage.cost.input,
      output: sum.cost.output + usage.cost.output,
      cacheRead: sum.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: sum.cost.cacheWrite + usage.cost.cacheWrite,
      total: sum.cost.total + usage.cost.total,
    },
  }), first);
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function deterministicMerge(params: {
  intent: LaneResult;
  execution: LaneResult;
  deterministic: DeterministicState;
  renderBudgets: DeterministicRenderBudgets;
  isSplitTurn: boolean;
}): string {
  const deterministic = renderDeterministicState(params.deterministic, params.renderBudgets);
  const workflow = params.deterministic.intentWorkflow;

  if (workflow) {
    return [
      "# Compaction Checkpoint",
      "",
      "## Durable Intent Workflow",
      renderIntentWorkflow(workflow, {
        maxChars: params.renderBudgets.intentWorkflowChars,
        includePlanBody: false,
      }),
      "",
      "## Implementation State",
      // LLM lane outputs are deliberately never clipped by deterministic target fitting.
      params.intent.text.trim(),
      "",
      "## Verification / Evidence State",
      params.execution.text.trim(),
      ...(deterministic ? ["", "## Deterministic Repository / User State", deterministic] : []),
      ...(params.isSplitTurn ? ["", "## Split-turn Context", SPLIT_TURN_NOTE] : []),
    ].join("\n");
  }

  return [
    "# Compaction Checkpoint",
    "",
    "## Task Semantics",
    params.intent.text.trim(),
    "",
    "## Execution State",
    params.execution.text.trim(),
    ...(deterministic ? ["", "## Deterministic State", deterministic] : []),
    ...(params.isSplitTurn ? ["", "## Split-turn Context", SPLIT_TURN_NOTE] : []),
  ].join("\n");
}

function budgetFloors(state: DeterministicState, max: DeterministicRenderBudgets): DeterministicRenderBudgets {
  return {
    intentWorkflowChars: state.intentWorkflow ? Math.min(max.intentWorkflowChars, 2_400) : 0,
    gitStateChars: state.git ? Math.min(max.gitStateChars, 800) : 0,
    editedFilesChars: state.traceEditedFiles.length > 0 ? Math.min(max.editedFilesChars, 1_200) : 0,
    readFilesChars: state.traceReadFiles.length > 0 ? Math.min(max.readFilesChars, 240) : 0,
    userMessagesChars: state.userMessages.length > 0 ? Math.min(max.userMessagesChars, 3_000) : 0,
  };
}

function interpolateBudgets(
  floors: DeterministicRenderBudgets,
  max: DeterministicRenderBudgets,
  fraction: number,
): DeterministicRenderBudgets {
  const pick = (floor: number, ceiling: number) => floor + Math.floor((ceiling - floor) * fraction);
  return {
    intentWorkflowChars: pick(floors.intentWorkflowChars, max.intentWorkflowChars),
    gitStateChars: pick(floors.gitStateChars, max.gitStateChars),
    editedFilesChars: pick(floors.editedFilesChars, max.editedFilesChars),
    readFilesChars: pick(floors.readFilesChars, max.readFilesChars),
    userMessagesChars: pick(floors.userMessagesChars, max.userMessagesChars),
  };
}

/**
 * Fit only deterministic sections to the requested post-compaction target.
 * Both LLM lane summaries are immutable/high-priority. If even the category
 * floors plus those summaries exceed the target, return them intact and report
 * targetExceeded rather than destroying the useful checkpoint.
 */
export function fitCheckpointToTarget(params: {
  intent: LaneResult;
  execution: LaneResult;
  deterministic: DeterministicState;
  maxRenderBudgets: DeterministicRenderBudgets;
  isSplitTurn: boolean;
  estimatedRetainedTokens: number;
  targetPostCompactTokens: number;
}): {
  summary: string;
  renderBudgets: DeterministicRenderBudgets;
  estimatedTokensAfter: number;
  targetExceeded: boolean;
} {
  const build = (renderBudgets: DeterministicRenderBudgets) => deterministicMerge({
    intent: params.intent,
    execution: params.execution,
    deterministic: params.deterministic,
    renderBudgets,
    isSplitTurn: params.isSplitTurn,
  });
  const estimateAfter = (summary: string) => params.estimatedRetainedTokens + Math.ceil(summary.length / 4);

  let renderBudgets = params.maxRenderBudgets;
  let summary = build(renderBudgets);
  let estimatedTokensAfter = estimateAfter(summary);
  if (estimatedTokensAfter <= params.targetPostCompactTokens) {
    return { summary, renderBudgets, estimatedTokensAfter, targetExceeded: false };
  }

  const floors = budgetFloors(params.deterministic, params.maxRenderBudgets);
  const floorSummary = build(floors);
  const floorEstimate = estimateAfter(floorSummary);
  if (floorEstimate > params.targetPostCompactTokens) {
    return {
      summary: floorSummary,
      renderBudgets: floors,
      estimatedTokensAfter: floorEstimate,
      targetExceeded: true,
    };
  }

  // Find the richest balanced deterministic rendering that still fits. Scaling
  // all categories together prevents Git, user history or file lists from
  // consuming the whole remainder of the target.
  let low = 0;
  let high = 1;
  let bestBudgets = floors;
  let bestSummary = floorSummary;
  let bestEstimate = floorEstimate;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const candidateBudgets = interpolateBudgets(floors, params.maxRenderBudgets, mid);
    const candidateSummary = build(candidateBudgets);
    const candidateEstimate = estimateAfter(candidateSummary);
    if (candidateEstimate <= params.targetPostCompactTokens) {
      low = mid;
      bestBudgets = candidateBudgets;
      bestSummary = candidateSummary;
      bestEstimate = candidateEstimate;
    } else {
      high = mid;
    }
  }
  return {
    summary: bestSummary,
    renderBudgets: bestBudgets,
    estimatedTokensAfter: bestEstimate,
    targetExceeded: false,
  };
}

export function makeOneRoundDetails(params: {
  laneResults: LaneResult[];
  wallTimeMs: number;
  keepRecentTokens: number;
  effectiveRecentTokenBudget: number;
  targetPostCompactTokens: number;
  estimatedTokensAfter: number;
  targetExceeded: boolean;
  renderBudgets: DeterministicRenderBudgets;
  boundaryMode: "whole-turn" | "split-turn" | "pi-fallback";
  retainedTurns: number;
  estimatedRetainedTokens: number;
  isSplitTurn: boolean;
  deterministic: DeterministicState;
}): OneRoundDetails {
  return {
    plugin: "pi-one-round-compaction",
    version: 3,
    lanes: params.laneResults.map((result) => ({
      lane: result.lane,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      durationMs: result.durationMs,
      usage: result.usage,
    })),
    wallTimeMs: params.wallTimeMs,
    keepRecentTokens: params.keepRecentTokens,
    effectiveRecentTokenBudget: params.effectiveRecentTokenBudget,
    targetPostCompactTokens: params.targetPostCompactTokens,
    estimatedTokensAfter: params.estimatedTokensAfter,
    targetExceeded: params.targetExceeded,
    renderBudgets: params.renderBudgets,
    boundaryMode: params.boundaryMode,
    retainedTurns: params.retainedTurns,
    estimatedRetainedTokens: params.estimatedRetainedTokens,
    isSplitTurn: params.isSplitTurn,
    readFiles: params.deterministic.readFiles,
    modifiedFiles: params.deterministic.modifiedFiles,
    traceReadFiles: params.deterministic.traceReadFiles,
    traceEditedFiles: params.deterministic.traceEditedFiles,
    userMessages: params.deterministic.userMessages,
    ...(params.deterministic.git ? { git: params.deterministic.git } : {}),
    intentWorkflow: params.deterministic.intentWorkflow
      ? {
          active: true,
          workstream: params.deterministic.intentWorkflow.workstream,
          hasPlan: Boolean(params.deterministic.intentWorkflow.plan),
          intentTruncated: params.deterministic.intentWorkflow.intentTruncated,
          planTruncated: params.deterministic.intentWorkflow.planTruncated,
        }
      : { active: false },
  };
}

export function emptyUsageForTests(): Usage {
  return zeroUsage();
}

export function findLatestPreviousSummary(branchEntries: SessionEntry[]): string | undefined {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i]!;
    if (entry.type === "compaction") return entry.summary;
  }
  return undefined;
}
