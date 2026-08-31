import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveLaneConfig } from "./config.js";
import { loadPromptSet } from "./prompt-loader.js";
import {
  buildLanePrompt,
  collectFileState,
  collectGitState,
  combineUsage,
  deterministicMerge,
  extractRecentUserContext,
  makeOneRoundDetails,
  prepareWholeTurnCompaction,
  runLane,
  serializeExecutionView,
  serializeIntentView,
  type DeterministicState,
  type OneRoundDetails,
} from "./core.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function oneRoundCompaction(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    let promptSet: Awaited<ReturnType<typeof loadPromptSet>>;
    try {
      [loaded, promptSet] = await Promise.all([loadConfig(ctx), loadPromptSet(ctx)]);
    } catch (error) {
      ctx.ui.notify(`One-round compaction configuration/prompt error: ${formatError(error)}`, "error");
      return;
    }

    const { config } = loaded;
    if (!config.enabled) return;

    const boundary = prepareWholeTurnCompaction(event);
    const allDiscarded = boundary.messagesToSummarize;
    if (allDiscarded.length === 0) return;

    const fileState = collectFileState(event, allDiscarded);
    const recentUserContext = extractRecentUserContext(allDiscarded, config.recentControlChars);
    const deterministicWithoutGit: DeterministicState = {
      ...fileState,
      recentUserContext,
    };

    const intentPrompt = buildLanePrompt({
      lane: "intent",
      lanePrompt: promptSet.intent,
      serializedConversation: serializeIntentView(allDiscarded),
      previousSummary: boundary.previousSummary,
      customInstructions: event.customInstructions,
      deterministic: deterministicWithoutGit,
      isSplitTurn: boundary.isSplitTurn,
    });
    const executionPrompt = buildLanePrompt({
      lane: "execution",
      lanePrompt: promptSet.execution,
      serializedConversation: serializeExecutionView(
        allDiscarded,
        config.toolResultChars,
        config.thinkingChars,
      ),
      previousSummary: boundary.previousSummary,
      customInstructions: event.customInstructions,
      deterministic: deterministicWithoutGit,
      isSplitTurn: boundary.isSplitTurn,
    });

    const started = performance.now();
    ctx.ui.notify(
      `One-round compaction: 2 parallel lanes; keeping ${boundary.retainedTurns} complete recent turn(s) (~${boundary.estimatedRetainedTokens.toLocaleString()} tokens, budget ${event.preparation.settings.keepRecentTokens.toLocaleString()})`,
      "info",
    );

    try {
      // Exactly one LLM round: neither lane consumes the other lane's output.
      // Git inspection is deterministic and runs concurrently with both calls.
      const [intent, execution, git] = await Promise.all([
        runLane({
          lane: "intent",
          config: resolveLaneConfig(config, "intent"),
          prompt: intentPrompt,
          systemPrompt: promptSet.system,
          ctx,
          signal: event.signal,
        }),
        runLane({
          lane: "execution",
          config: resolveLaneConfig(config, "execution"),
          prompt: executionPrompt,
          systemPrompt: promptSet.system,
          ctx,
          signal: event.signal,
        }),
        config.includeGitState ? collectGitState(ctx.cwd) : Promise.resolve(undefined),
      ]);

      const deterministic: DeterministicState = {
        ...deterministicWithoutGit,
        ...(git ? { git } : {}),
      };
      const wallTimeMs = Math.round(performance.now() - started);
      const summary = deterministicMerge({
        intent,
        execution,
        deterministic,
        isSplitTurn: boundary.isSplitTurn,
      });
      const details = makeOneRoundDetails({
        laneResults: [intent, execution],
        wallTimeMs,
        keepRecentTokens: event.preparation.settings.keepRecentTokens,
        boundaryMode: boundary.boundaryMode,
        retainedTurns: boundary.retainedTurns,
        estimatedRetainedTokens: boundary.estimatedRetainedTokens,
        isSplitTurn: boundary.isSplitTurn,
        deterministic,
      });

      const usage = combineUsage([intent.usage, execution.usage]);
      const estimatedTokensAfter = boundary.estimatedRetainedTokens + Math.ceil(summary.length / 4);
      return {
        compaction: {
          summary,
          firstKeptEntryId: boundary.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          estimatedTokensAfter,
          ...(usage ? { usage } : {}),
          details,
        },
      };
    } catch (error) {
      if (event.signal.aborted) return;
      const message = `One-round compaction failed: ${formatError(error)}`;
      if (config.fallbackToNative) {
        ctx.ui.notify(`${message}. Falling back to Pi native compaction.`, "warning");
        return;
      }
      ctx.ui.notify(message, "error");
      return { cancel: true };
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const details = event.compactionEntry.details as OneRoundDetails | undefined;
    if (!details || details.plugin !== "pi-one-round-compaction") return;
    const laneText = details.lanes
      .map((lane) => `${lane.lane} ${lane.durationMs}ms`)
      .join(", ");
    ctx.ui.notify(
      `One-round compacted in ${details.wallTimeMs}ms (${laneText}); kept ${details.retainedTurns} complete recent turn(s) (~${details.estimatedRetainedTokens.toLocaleString()} tokens, budget ${details.keepRecentTokens.toLocaleString()}, ${details.boundaryMode})`,
      "info",
    );
  });

  pi.registerCommand("one-round-compaction", {
    description: "Show one-round compaction configuration",
    handler: async (_args, ctx) => {
      try {
        const [{ config, globalPath, projectPath }, promptSet] = await Promise.all([
          loadConfig(ctx),
          loadPromptSet(ctx),
        ]);
        const intent = resolveLaneConfig(config, "intent");
        const execution = resolveLaneConfig(config, "execution");
        const lines = [
          `enabled: ${config.enabled}`,
          `global config: ${globalPath}`,
          ...(projectPath ? [`project override: ${projectPath}`] : []),
          `intent: ${intent.model} thinking=${intent.thinkingLevel} maxOutput=${intent.maxOutputTokens}`,
          `execution: ${execution.model} thinking=${execution.thinkingLevel} maxOutput=${execution.maxOutputTokens}`,
          `toolResultChars: ${config.toolResultChars}`,
          `thinkingChars: ${config.thinkingChars}`,
          `recentControlChars: ${config.recentControlChars}`,
          `prompts: system=${promptSet.sources.system}; intent=${promptSet.sources.intent}; execution=${promptSet.sources.execution}`,
          "recent-turn budget: Pi's compaction.keepRecentTokens setting; this plugin keeps the newest complete turns that fit",
          `fallbackToNative: ${config.fallbackToNative} (false guarantees no sequential LLM fallback)`,
          "LLM topology: 2 calls in parallel, deterministic merge, no LLM follow-up/finalizer",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`One-round compaction config error: ${formatError(error)}`, "error");
      }
    },
  });
}
