import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type MethodAwareContext = ExtensionContext & {
  getCompactionMethod?: () => "cache-aware" | "extension";
};

/** Keep legacy hosts working while newer hosts select one compaction method explicitly. */
export function isOneRoundSelected(
  ctx: ExtensionContext,
  event?: { method?: string },
): boolean {
  const method = event?.method ?? (ctx as MethodAwareContext).getCompactionMethod?.();
  return method === undefined || method === "extension";
}
