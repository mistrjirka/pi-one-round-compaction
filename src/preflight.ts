import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

export interface PreflightProjection {
  currentTokens: number;
  incomingTokens: number;
  projectedTokens: number;
  contextWindow: number;
}

export function estimateIncomingPromptTokens(text: string, images?: ImageContent[]): number {
  return estimateTokens({
    role: "user",
    content: [
      { type: "text", text },
      ...(images ?? []),
    ],
    timestamp: Date.now(),
  });
}

export function getPreflightProjection(
  ctx: Pick<ExtensionContext, "getContextUsage">,
  text: string,
  images?: ImageContent[],
): PreflightProjection | undefined {
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return undefined;
  const incomingTokens = estimateIncomingPromptTokens(text, images);
  return {
    currentTokens: usage.tokens,
    incomingTokens,
    projectedTokens: usage.tokens + incomingTokens,
    contextWindow: usage.contextWindow,
  };
}

export function projectionExceedsContext(projection: PreflightProjection): boolean {
  return projection.projectedTokens > projection.contextWindow;
}
