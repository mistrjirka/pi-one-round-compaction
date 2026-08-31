import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveLaneConfig } from "./config.js";
import { activateIntentWorkflowForSession, detectIntentWorkflow } from "./intent-workflow.js";
import { loadPromptSet } from "./prompt-loader.js";
import {
  buildLanePrompt,
  collectFileState,
  collectGitState,
  collectUserMessageLedger,
  combineUsage,
  computeEffectiveRecentTokenBudget,
  fitCheckpointToTarget,
  makeOneRoundDetails,
  prepareWholeTurnCompaction,
  runLane,
  serializeExecutionView,
  serializeIntentView,
  type DeterministicRenderBudgets,
  type DeterministicState,
  type LaneName,
  type OneRoundDetails,
} from "./core.js";
import { createProgressReporter } from "./progress.js";
import { getPreflightProjection, projectionExceedsContext } from "./preflight.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactAndWait(ctx: ExtensionContext): Promise<CompactionResult> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      onComplete: resolve,
      onError: reject,
    });
  });
}

export default function oneRoundCompaction(pi: ExtensionAPI): void {
  const extensionLoadedAtMs = Date.now();

  // Pi 0.84.x checks native threshold compaction before it adds a newly submitted
  // user prompt. With reserveTokens=0, a session can therefore be below the model
  // limit at that check and cross the limit only after the new prompt is appended.
  // Close that gap without inventing a reserve: project the incoming prompt itself.
  pi.on("input", async (event, ctx) => {
    if (!ctx.isIdle()) return;

    // Fast path: ordinary prompts do not touch plugin config files at all.
    const projection = getPreflightProjection(ctx, event.text, event.images);
    if (!projection || !projectionExceedsContext(projection)) return;

    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    try {
      loaded = await loadConfig(ctx);
    } catch (error) {
      ctx.ui.notify(`One-round compaction config error: ${formatError(error)}`, "error");
      return { action: "handled" };
    }
    if (!loaded.config.enabled || !loaded.config.preflightAutoCompact) return;

    ctx.ui.notify(
      `One-round preflight: projected ${projection.projectedTokens.toLocaleString()} / ${projection.contextWindow.toLocaleString()} tokens; compacting before request`,
      "info",
    );

    try {
      const result = await compactAndWait(ctx);
      if (
        result.estimatedTokensAfter !== undefined &&
        result.estimatedTokensAfter + projection.incomingTokens > projection.contextWindow
      ) {
        ctx.ui.notify(
          `Prompt not sent: even after compaction the projected context is ${(result.estimatedTokensAfter + projection.incomingTokens).toLocaleString()} / ${projection.contextWindow.toLocaleString()} tokens`,
          "error",
        );
        return { action: "handled" };
      }
      return;
    } catch (error) {
      ctx.ui.notify(
        `Prompt not sent because required preflight compaction failed: ${formatError(error)}`,
        "error",
      );
      return { action: "handled" };
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    let promptSet: Awaited<ReturnType<typeof loadPromptSet>>;
    let intentWorkflow: Awaited<ReturnType<typeof detectIntentWorkflow>>;
    try {
      [loaded, promptSet, intentWorkflow] = await Promise.all([
        loadConfig(ctx),
        loadPromptSet(ctx),
        detectIntentWorkflow(ctx.cwd),
      ]);
    } catch (error) {
      ctx.ui.notify(`One-round compaction configuration/prompt error: ${formatError(error)}`, "error");
      return;
    }

    intentWorkflow = activateIntentWorkflowForSession(
      intentWorkflow,
      event.branchEntries,
      extensionLoadedAtMs,
    );

    const { config } = loaded;
    if (!config.enabled) return;

    const intentLaneConfig = resolveLaneConfig(config, "intent");
    const executionLaneConfig = resolveLaneConfig(config, "execution");
    const maxRenderBudgets: DeterministicRenderBudgets = {
      intentWorkflowChars: intentWorkflow.active ? config.intentWorkflowChars : 0,
      gitStateChars: config.includeGitState ? config.gitStateChars : 0,
      editedFilesChars: config.editedFilesChars,
      readFilesChars: config.readFilesChars,
      userMessagesChars: config.recentControlChars,
    };
    const deterministicReserveChars = Object.values(maxRenderBudgets).reduce((sum, value) => sum + value, 0);
    const effectiveRecentTokenBudget = computeEffectiveRecentTokenBudget({
      targetPostCompactTokens: config.targetPostCompactTokens,
      keepRecentTokens: event.preparation.settings.keepRecentTokens,
      // Reserve the configured maximum lane outputs up front. Actual outputs are
      // normally much smaller; target fitting after the calls gives the unused
      // room back to deterministic state rather than risking raw-context dominance.
      laneOutputReserveTokens: intentLaneConfig.maxOutputTokens + executionLaneConfig.maxOutputTokens,
      deterministicReserveChars,
    });

    const boundary = prepareWholeTurnCompaction(event, effectiveRecentTokenBudget);
    const allDiscarded = boundary.messagesToSummarize;
    if (allDiscarded.length === 0) return;

    const fileState = collectFileState(event, allDiscarded);
    const userMessages = collectUserMessageLedger(
      event.branchEntries,
      boundary.firstKeptEntryId,
      config.userMessageChars,
    );
    const deterministicWithoutGit: DeterministicState = {
      ...fileState,
      userMessages,
      ...(intentWorkflow.active ? { intentWorkflow } : {}),
    };

    const executionView = serializeExecutionView(
      allDiscarded,
      config.toolResultChars,
      config.thinkingChars,
    );
    const intentPrompt = buildLanePrompt({
      lane: "intent",
      lanePrompt: intentWorkflow.active ? promptSet.workflowImplementation : promptSet.intent,
      serializedConversation: intentWorkflow.active ? executionView : serializeIntentView(allDiscarded),
      previousSummary: boundary.previousSummary,
      customInstructions: event.customInstructions,
      deterministic: deterministicWithoutGit,
      renderBudgets: maxRenderBudgets,
      isSplitTurn: boundary.isSplitTurn,
    });
    const executionPrompt = buildLanePrompt({
      lane: "execution",
      lanePrompt: intentWorkflow.active ? promptSet.workflowEvidence : promptSet.execution,
      serializedConversation: executionView,
      previousSummary: boundary.previousSummary,
      customInstructions: event.customInstructions,
      deterministic: deterministicWithoutGit,
      renderBudgets: maxRenderBudgets,
      isSplitTurn: boundary.isSplitTurn,
    });

    const progress = createProgressReporter({
      pi,
      ctx,
      mode: intentWorkflow.active ? "workflow" : "normal",
      reason: event.reason,
      retainedTurns: boundary.retainedTurns,
      estimatedRetainedTokens: boundary.estimatedRetainedTokens,
      keepRecentTokens: event.preparation.settings.keepRecentTokens,
      targetPostCompactTokens: config.targetPostCompactTokens,
      effectiveRecentTokenBudget,
      boundaryMode: boundary.boundaryMode,
      ...(intentWorkflow.active
        ? {
            intentWorkflow: {
              workstream: intentWorkflow.workstream,
              hasPlan: Boolean(intentWorkflow.plan),
            },
          }
        : {}),
      roles: intentWorkflow.active
        ? { intent: "implementation", execution: "evidence" }
        : { intent: "intent", execution: "execution" },
    });

    const started = performance.now();
    const workflowLabel = intentWorkflow.active
      ? `intent-workflow=${intentWorkflow.workstream}`
      : `intent-workflow=not detected (${intentWorkflow.reason})`;
    ctx.ui.notify(
      `One-round compaction: 2 parallel lanes; ${workflowLabel}; target ${config.targetPostCompactTokens.toLocaleString()} tokens; raw recent budget ${effectiveRecentTokenBudget.toLocaleString()} (Pi keepRecentTokens ${event.preparation.settings.keepRecentTokens.toLocaleString()}); retaining ~${boundary.estimatedRetainedTokens.toLocaleString()} tokens (${boundary.boundaryMode})`,
      "info",
    );

    const runTrackedLane = async (lane: LaneName, prompt: string) => {
      progress.laneStart(lane);
      try {
        const result = await runLane({
          lane,
          config: lane === "intent" ? intentLaneConfig : executionLaneConfig,
          prompt,
          systemPrompt: promptSet.system,
          ctx,
          signal: event.signal,
          onTextDelta: (delta) => progress.laneDelta(lane, delta),
        });
        progress.laneDone(lane, result.text);
        return result;
      } catch (error) {
        progress.laneError(lane, formatError(error));
        throw error;
      }
    };

    try {
      // Exactly one LLM round: neither lane consumes the other lane's output.
      // Git inspection is deterministic and runs concurrently with both calls.
      const [intent, execution, git] = await Promise.all([
        runTrackedLane("intent", intentPrompt),
        runTrackedLane("execution", executionPrompt),
        config.includeGitState ? collectGitState(ctx.cwd) : Promise.resolve(undefined),
      ]);

      progress.merging();
      const deterministic: DeterministicState = {
        ...deterministicWithoutGit,
        ...(git ? { git } : {}),
      };
      const wallTimeMs = Math.round(performance.now() - started);
      const fitted = fitCheckpointToTarget({
        intent,
        execution,
        deterministic,
        maxRenderBudgets,
        isSplitTurn: boundary.isSplitTurn,
        estimatedRetainedTokens: boundary.estimatedRetainedTokens,
        targetPostCompactTokens: config.targetPostCompactTokens,
      });
      const summary = fitted.summary;
      const estimatedTokensAfter = fitted.estimatedTokensAfter;
      const details = makeOneRoundDetails({
        laneResults: [intent, execution],
        wallTimeMs,
        keepRecentTokens: event.preparation.settings.keepRecentTokens,
        effectiveRecentTokenBudget,
        targetPostCompactTokens: config.targetPostCompactTokens,
        estimatedTokensAfter,
        targetExceeded: fitted.targetExceeded,
        renderBudgets: fitted.renderBudgets,
        boundaryMode: boundary.boundaryMode,
        retainedTurns: boundary.retainedTurns,
        estimatedRetainedTokens: boundary.estimatedRetainedTokens,
        isSplitTurn: boundary.isSplitTurn,
        deterministic,
      });

      if (fitted.targetExceeded) {
        ctx.ui.notify(
          `One-round target ${config.targetPostCompactTokens.toLocaleString()} could not be met without clipping LLM summaries; preserving them intact at ~${estimatedTokensAfter.toLocaleString()} tokens`,
          "warning",
        );
      }

      const usage = combineUsage([intent.usage, execution.usage]);
      progress.complete();
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
      if (event.signal.aborted) {
        progress.abort();
        return;
      }
      const message = `One-round compaction failed: ${formatError(error)}`;
      progress.fail(message);
      if (config.fallbackToNative) {
        ctx.ui.notify(`${message}. Falling back to Pi native compaction.`, "warning");
        return;
      }
      ctx.ui.notify(message, "error");
      return { cancel: true };
    } finally {
      progress.clear();
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const details = event.compactionEntry.details as OneRoundDetails | undefined;
    if (!details || details.plugin !== "pi-one-round-compaction") return;
    const laneText = details.lanes
      .map((lane) => `${lane.lane} ${lane.durationMs}ms`)
      .join(", ");
    ctx.ui.notify(
      `One-round compacted in ${details.wallTimeMs}ms (${laneText}); estimated ${details.estimatedTokensAfter.toLocaleString()} tokens after compaction (target ${details.targetPostCompactTokens.toLocaleString()}); raw suffix ~${details.estimatedRetainedTokens.toLocaleString()} / budget ${details.effectiveRecentTokenBudget.toLocaleString()} (${details.boundaryMode})`,
      "info",
    );
  });

  pi.registerCommand("one-round-compaction", {
    description: "Show one-round compaction configuration",
    handler: async (_args, ctx) => {
      try {
        const [{ config, globalPath, projectPath }, promptSet, detectedIntentWorkflow] = await Promise.all([
          loadConfig(ctx),
          loadPromptSet(ctx),
          detectIntentWorkflow(ctx.cwd),
        ]);
        const intentWorkflow = activateIntentWorkflowForSession(
          detectedIntentWorkflow,
          ctx.sessionManager.getBranch(),
          extensionLoadedAtMs,
        );
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
          `recentControlChars: ${config.recentControlChars} (total rendered cumulative user-ledger budget)`,
          `userMessageChars: ${config.userMessageChars} (per compacted user message)`,
          `targetPostCompactTokens: ${config.targetPostCompactTokens} (soft target; LLM summaries are never clipped)`,
          `intentWorkflowChars: ${config.intentWorkflowChars}`,
          `gitStateChars: ${config.gitStateChars}`,
          `editedFilesChars: ${config.editedFilesChars}`,
          `readFilesChars: ${config.readFilesChars}`,
          `preflightAutoCompact: ${config.preflightAutoCompact} (projects each idle user prompt against the active model context window)`,
          intentWorkflow.active
            ? `intent workflow: ACTIVE workstream=${intentWorkflow.workstream} plan=${Boolean(intentWorkflow.plan)} intentTruncated=${intentWorkflow.intentTruncated} planTruncated=${intentWorkflow.planTruncated}`
            : `intent workflow: not detected (${intentWorkflow.reason}); using normal intent+execution lanes`,
          intentWorkflow.active
            ? `prompts: system=${promptSet.sources.system}; implementation=${promptSet.sources.workflowImplementation}; evidence=${promptSet.sources.workflowEvidence}`
            : `prompts: system=${promptSet.sources.system}; intent=${promptSet.sources.intent}; execution=${promptSet.sources.execution}`,
          "recent-turn budget: balanced against targetPostCompactTokens; oversized newest turns split at safe message boundaries instead of surviving verbatim",
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
