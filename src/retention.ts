import {
  estimateTokens,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  prepareWholeTurnCompaction,
  type WholeTurnPreparation,
} from "./core.js";

type CompactionMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

const TURN_START_ROLES = new Set<string>([
  "user",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

const CUT_POINT_ROLES = new Set<string>([
  "user",
  "assistant",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

function entryMessagesForCompaction(entry: SessionEntry): CompactionMessage[] {
  if (entry.type === "compaction") return [];
  return sessionEntryToContextMessages(entry);
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

function isTurnStartEntry(entry: SessionEntry): boolean {
  return entryMessagesForCompaction(entry).some((message) => TURN_START_ROLES.has(message.role));
}

function isCutPointEntry(entry: SessionEntry): boolean {
  return entryMessagesForCompaction(entry).some((message) => CUT_POINT_ROLES.has(message.role));
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (isTurnStartEntry(entries[i]!)) return i;
  }
  return -1;
}

/**
 * Build the richest provider-safe raw suffix at a requested token budget.
 * Unlike the normal whole-turn selector, this can cut inside an older oversized
 * turn even when one or more tiny newer turns fit comfortably in the budget.
 */
function prepareBudgetedUnderfillSplit(
  entries: SessionEntry[],
  recentTokenBudget: number,
  previousSummary: string | undefined,
): WholeTurnPreparation | undefined {
  const boundaryStart = previousCompactionBoundary(entries);
  const cutPoints: number[] = [];
  for (let i = boundaryStart; i < entries.length; i++) {
    if (isCutPointEntry(entries[i]!)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return undefined;

  const target = Math.max(1, recentTokenBudget);
  let thresholdIndex = boundaryStart;
  let accumulated = 0;
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

function betterBoundedCandidate(
  current: WholeTurnPreparation,
  candidate: WholeTurnPreparation | undefined,
  ceiling: number,
): WholeTurnPreparation {
  if (!candidate) return current;
  if (candidate.estimatedRetainedTokens <= current.estimatedRetainedTokens) return current;
  if (candidate.estimatedRetainedTokens > ceiling) return current;
  return candidate;
}

/**
 * Keep the normal conservative recent-context budget, but recover pathological
 * underfill at provider-safe boundaries. This covers both cases seen in real
 * traces: a newest oversized turn whose safe split lands too late, and tiny
 * newest complete turns preceded by an oversized tool-heavy turn.
 *
 * The first recovery pass tries to fill the normal raw recent budget. If a safe
 * boundary still leaves less than half of that budget, a second pass may use the
 * configured soft post-compact target as a hard raw-suffix ceiling. Genuinely
 * huge turns therefore remain summarized rather than surviving verbatim.
 */
export function prepareWholeTurnCompactionWithUnderfillRecovery(
  event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">,
  recentTokenBudget: number = event.preparation.settings.keepRecentTokens,
  underfillCeilingTokens: number = recentTokenBudget,
): WholeTurnPreparation {
  const target = Math.max(1, recentTokenBudget);
  const ceiling = Math.max(target, underfillCeilingTokens);
  let selected = prepareWholeTurnCompaction(event, target);

  if (selected.estimatedRetainedTokens * 2 >= target) return selected;

  selected = betterBoundedCandidate(
    selected,
    prepareBudgetedUnderfillSplit(event.branchEntries, target, event.preparation.previousSummary),
    target,
  );
  if (selected.estimatedRetainedTokens * 2 >= target || ceiling <= target) return selected;

  return betterBoundedCandidate(
    selected,
    prepareBudgetedUnderfillSplit(event.branchEntries, ceiling, event.preparation.previousSummary),
    ceiling,
  );
}
