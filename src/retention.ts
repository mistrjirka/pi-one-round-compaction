import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import {
  prepareWholeTurnCompaction,
  type WholeTurnPreparation,
} from "./core.js";

/**
 * Keep the normal conservative recent-context budget, but recover pathological
 * split-turn underfill when the nearest provider-safe boundary lands after one
 * oversized tool/result group. The retry uses the configured soft post-compact
 * target as a hard raw-suffix ceiling, so genuinely huge turns are still
 * summarized instead of surviving verbatim.
 */
export function prepareWholeTurnCompactionWithUnderfillRecovery(
  event: Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">,
  recentTokenBudget: number = event.preparation.settings.keepRecentTokens,
  splitUnderfillCeilingTokens: number = recentTokenBudget,
): WholeTurnPreparation {
  const normal = prepareWholeTurnCompaction(event, recentTokenBudget);
  const target = Math.max(1, recentTokenBudget);
  const ceiling = Math.max(target, splitUnderfillCeilingTokens);

  if (
    normal.boundaryMode !== "split-turn"
    || normal.estimatedRetainedTokens * 2 >= target
    || ceiling <= target
  ) {
    return normal;
  }

  const expanded = prepareWholeTurnCompaction(event, ceiling);
  if (
    expanded.estimatedRetainedTokens <= normal.estimatedRetainedTokens
    || expanded.estimatedRetainedTokens > ceiling
  ) {
    return normal;
  }

  return expanded;
}
