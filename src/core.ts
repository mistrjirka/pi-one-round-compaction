import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  contentText,
  type AssistantMessage,
  type Message,
  type Model,
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

export interface DeterministicState {
  git?: GitState;
  readFiles: string[];
  modifiedFiles: string[];
  recentUserContext: string[];
  intentWorkflow?: ActiveIntentWorkflow;
}

export interface OneRoundDetails {
  plugin: "pi-one-round-compaction";
  version: 2;
  lanes: Array<{
    lane: LaneName;
    model: string;
    thinkingLevel: ThinkingLevel;
    durationMs: number;
    usage: Usage;
  }>;
  wallTimeMs: number;
  keepRecentTokens: number;
  boundaryMode: "whole-turn" | "pi-fallback";
  retainedTurns: number;
  estimatedRetainedTokens: number;
  isSplitTurn: boolean;
  readFiles: string[];
  modifiedFiles: string[];
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
  boundaryMode: "whole-turn" | "pi-fallback";
  isSplitTurn: boolean;
}

type PromptBuildInput = {
  lane: LaneName;
  lanePrompt: string;
  serializedConversation: string;
  previousSummary: string | undefined;
  customInstructions: string | undefined;
  deterministic: DeterministicState;
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
    // Keep the beginning because accepted plans/constraints are commonly stated first.
    selected.push(`${text.slice(0, remaining)}\n[… user message truncated]`);
    used = maxChars;
    break;
  }
  return selected.reverse();
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
 * Keep the newest complete turns whose estimated total fits keepRecentTokens.
 * Unlike Pi's native cut point, this never intentionally cuts inside a turn.
 * The newest turn is always retained even when it alone exceeds the budget.
 * When a useful whole-turn prefix cannot be formed, fall back to Pi's prepared
 * boundary so overflow recovery still has a way to make progress.
 */
export function prepareWholeTurnCompaction(event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">): WholeTurnPreparation {
  const entries = event.branchEntries;
  const boundaryStart = previousCompactionBoundary(entries);
  const turnStarts: number[] = [];

  for (let i = boundaryStart; i < entries.length; i++) {
    const messages = entryMessagesForCompaction(entries[i]!);
    if (messages.some(isTurnStartMessage)) turnStarts.push(i);
  }

  if (turnStarts.length > 0) {
    let selectedTurn = turnStarts.length - 1;
    let retainedTokens = estimateEntryRangeTokens(entries, turnStarts[selectedTurn]!, entries.length);

    for (let turn = selectedTurn - 1; turn >= 0; turn--) {
      const start = turnStarts[turn]!;
      const end = turnStarts[turn + 1]!;
      const turnTokens = estimateEntryRangeTokens(entries, start, end);
      if (retainedTokens + turnTokens > event.preparation.settings.keepRecentTokens) break;
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
  }

  const fallbackMessages = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  const fallbackFirstIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  const retainedTokens = fallbackFirstIndex >= 0
    ? estimateEntryRangeTokens(entries, fallbackFirstIndex, entries.length)
    : event.preparation.settings.keepRecentTokens;
  const retainedTurns = fallbackFirstIndex >= 0
    ? turnStarts.filter((start) => start >= fallbackFirstIndex).length
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

export function collectFileState(
  event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">,
  actualDiscardedMessages: CompactionMessage[] = [],
): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const read = new Set(event.preparation.fileOps.read);
  const modified = new Set([
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);

  // Our whole-turn cut can differ from Pi's native preparation cut. Scan the
  // messages we actually discard so a path in that delta cannot disappear from
  // cumulative file state.
  for (const message of convertToLlm(actualDiscardedMessages)) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !isObject(part.arguments)) continue;
      const filePath = typeof part.arguments.path === "string" ? part.arguments.path : undefined;
      if (!filePath) continue;
      if (part.name === "read") read.add(filePath);
      if (part.name === "write" || part.name === "edit") modified.add(filePath);
    }
  }

  // Pi intentionally does not trust extension-generated details when preparing
  // later compactions. Restore our/native-compatible file lists ourselves so
  // repeated compactions remain cumulative.
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
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
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

export async function collectGitState(cwd: string): Promise<GitState | undefined> {
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const [branch, head, statusText] = await Promise.all([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["rev-parse", "--short=12", "HEAD"]),
      runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    const allDirty = statusText ? statusText.split("\n").filter(Boolean) : [];
    const dirty = allDirty.slice(0, 200);
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

function renderDeterministicState(state: DeterministicState): string {
  const sections: string[] = [];

  if (state.git) {
    const lines = [
      `root: ${state.git.root}`,
      `branch: ${state.git.branch}`,
      `HEAD: ${state.git.head}`,
      "working tree:",
      ...(state.git.dirty.length > 0 ? state.git.dirty : ["(clean)"]),
    ];
    if (state.git.truncated) lines.push("[… additional dirty paths omitted]");
    sections.push(`### Git state\n\`\`\`text\n${lines.join("\n")}\n\`\`\``);
  }

  if (state.modifiedFiles.length > 0 || state.readFiles.length > 0) {
    const fileLines = [
      ...(state.modifiedFiles.length > 0
        ? ["Modified:", ...state.modifiedFiles.map((file) => `- ${file}`)]
        : []),
      ...(state.readFiles.length > 0
        ? ["Read-only/relevant:", ...state.readFiles.map((file) => `- ${file}`)]
        : []),
    ];
    sections.push(`### Pi tracked files\n${fileLines.join("\n")}`);
  }

  if (state.recentUserContext.length > 0) {
    const quoted = state.recentUserContext
      .map((text, index) => `#### User message ${index + 1}\n\n${text}`)
      .join("\n\n");
    sections.push(`### Recent user requirements from the summarized prefix\n${quoted}`);
  }

  return sections.join("\n\n");
}

export function buildLanePrompt(input: PromptBuildInput): string {
  const sections: string[] = [input.lanePrompt.trim()];

  if (input.customInstructions?.trim()) {
    sections.push(`## Explicit compaction focus\n${input.customInstructions.trim()}`);
  }

  if (input.previousSummary?.trim()) {
    sections.push(
      `## Previous checkpoint (fallible historical state)\nUse only still-valid information. Newer evidence overrides it.\n\n${input.previousSummary.trim()}`,
    );
  }

  if (input.deterministic.intentWorkflow) {
    sections.push(
      `## Active intent-workflow ledger\nThis durable ledger is re-read from disk for every compaction. It is context, not authority over newer explicit user instructions. Do not rewrite its task semantics unless the lane prompt explicitly asks for that.\n\n${renderIntentWorkflow(input.deterministic.intentWorkflow)}`,
    );
  }

  const deterministic = renderDeterministicState(input.deterministic);
  if (deterministic) {
    sections.push(`## Deterministic repository/user evidence\nThis block is authoritative where it states direct facts. Newer explicit user messages override older ledger/context state.\n\n${deterministic}`);
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
}): Promise<LaneResult> {
  const reference = parseModelReference(params.config.model);
  if (!reference) throw new Error(`Invalid model reference '${params.config.model}'; expected provider/model`);
  const model = params.ctx.modelRegistry.find(reference.provider, reference.modelId);
  if (!model) throw new Error(`Model not found: ${params.config.model}`);

  const reasoningEffort = reasoningEffortFor(model, params.config.thinkingLevel);
  const started = performance.now();
  const options: Record<string, unknown> = {
    maxTokens: Math.min(params.config.maxOutputTokens, model.maxTokens || params.config.maxOutputTokens),
    signal: params.signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
  };
  if (reasoningEffort) options.reasoningEffort = reasoningEffort;

  const response = await params.ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: params.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: params.prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    options,
  );

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
  isSplitTurn: boolean;
}): string {
  const deterministic = renderDeterministicState(params.deterministic);
  const workflow = params.deterministic.intentWorkflow;

  if (workflow) {
    return [
      "# Compaction Checkpoint",
      "",
      "## Durable Intent Workflow",
      renderIntentWorkflow(workflow),
      "",
      "## Implementation State",
      params.intent.text.trim(),
      "",
      "## Verification / Evidence State",
      params.execution.text.trim(),
      ...(deterministic ? ["", "## Deterministic Repository / Recent User State", deterministic] : []),
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

export function makeOneRoundDetails(params: {
  laneResults: LaneResult[];
  wallTimeMs: number;
  keepRecentTokens: number;
  boundaryMode: "whole-turn" | "pi-fallback";
  retainedTurns: number;
  estimatedRetainedTokens: number;
  isSplitTurn: boolean;
  deterministic: DeterministicState;
}): OneRoundDetails {
  return {
    plugin: "pi-one-round-compaction",
    version: 2,
    lanes: params.laneResults.map((result) => ({
      lane: result.lane,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      durationMs: result.durationMs,
      usage: result.usage,
    })),
    wallTimeMs: params.wallTimeMs,
    keepRecentTokens: params.keepRecentTokens,
    boundaryMode: params.boundaryMode,
    retainedTurns: params.retainedTurns,
    estimatedRetainedTokens: params.estimatedRetainedTokens,
    isSplitTurn: params.isSplitTurn,
    readFiles: params.deterministic.readFiles,
    modifiedFiles: params.deterministic.modifiedFiles,
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
