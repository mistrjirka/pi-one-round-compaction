import { contentText, StringEnum } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_CONFIG, loadConfig, resolveLaneConfig } from "./config.js";
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
import {
  backfillUserArtifacts,
  loadUserArtifactManifest,
  previousUserArtifactState,
  readUserArtifact,
  reconcileDurableUserReferences,
  referencedArtifactIds,
  renderArtifactCandidates,
  searchUserArtifacts,
  storeUserArtifact,
  userArtifactIdsOnBranch,
  type DurableUserReference,
  type UserArtifactRecord,
} from "./user-artifacts.js";


const UserArtifactToolParams = Type.Object({
  action: StringEnum(["list", "read", "search"] as const),
  id: Type.Optional(Type.String({ description: "Known durable source id such as U0001 (read)." })),
  query: Type.Optional(Type.String({ description: "Case-insensitive text query over archived oversized human messages (search)." })),
  startChar: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for paged read." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Maximum exact characters returned by read; default 16000." })),
});

function formatArtifactCatalog(records: UserArtifactRecord[]): string {
  if (records.length === 0) return "No oversized human user sources are stored for this session.";
  return records.map((record) => `- ${record.id}: ${record.chars.toLocaleString()} chars; ${record.preview}`).join("\n");
}

function uniqueArtifactCandidates(params: {
  artifacts: UserArtifactRecord[];
  previous: DurableUserReference[];
  knownIds: string[];
  recalledIds: string[];
}): UserArtifactRecord[] {
  const byId = new Map(params.artifacts.map((artifact) => [artifact.id, artifact]));
  const known = new Set(params.knownIds);
  const ordered: UserArtifactRecord[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    const record = byId.get(id);
    if (!record) return;
    seen.add(id);
    ordered.push(record);
  };

  // Existing active/cooling references get first claim on the prompt budget.
  for (const reference of [...params.previous].sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    return a.id.localeCompare(b.id);
  })) push(reference.id);

  // Then expose newly discovered exact human sources, newest first.
  for (const artifact of [...params.artifacts]
    .filter((artifact) => !known.has(artifact.id))
    .sort((a, b) => b.timestamp - a.timestamp)) push(artifact.id);

  // Explicit references observed in recent execution/tool evidence can revive an
  // archived source so the semantic lane can decide whether it matters again.
  for (const id of params.recalledIds) push(id);
  return ordered;
}

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

  pi.registerTool({
    name: "user_artifact",
    label: "User Artifact",
    description: "Recover exact oversized human user messages that compaction keeps outside normal context. Actions: list, search, read.",
    promptSnippet: "Recover exact oversized human plans/specs saved across compactions",
    promptGuidelines: [
      "Use user_artifact when a checkpoint references a U#### source or when exact wording from an older oversized user plan/spec may matter; search archived sources instead of assuming compaction lost them.",
    ],
    parameters: UserArtifactToolParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const manifest = await loadUserArtifactManifest(sessionId);
      const branchEntries = ctx.sessionManager.getBranch();
      const previousState = previousUserArtifactState(branchEntries);
      const branchIds = new Set([
        ...previousState.knownIds,
        ...userArtifactIdsOnBranch(manifest.artifacts, branchEntries),
      ]);
      if (params.action === "list") {
        const records = manifest.artifacts
          .filter((artifact) => branchIds.has(artifact.id))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 50);
        return {
          content: [{ type: "text", text: formatArtifactCatalog(records) }],
          details: { action: "list", count: records.length, records },
        };
      }
      if (params.action === "search") {
        if (!params.query?.trim()) {
          return { content: [{ type: "text", text: "user_artifact search requires query." }], isError: true, details: { action: "search" } };
        }
        const records = await searchUserArtifacts(sessionId, params.query, 20, branchIds);
        return {
          content: [{ type: "text", text: records.length ? formatArtifactCatalog(records) : `No oversized human user source matched: ${params.query}` }],
          details: { action: "search", query: params.query, records },
        };
      }

      if (!params.id?.trim()) {
        return { content: [{ type: "text", text: "user_artifact read requires id (for example U0001)." }], isError: true, details: { action: "read" } };
      }
      const requestedId = params.id.trim();
      if (!branchIds.has(requestedId)) {
        return { content: [{ type: "text", text: `User artifact ${requestedId} is not available on the current session branch.` }], isError: true, details: { action: "read", id: requestedId } };
      }
      const found = await readUserArtifact(sessionId, requestedId);
      if (!found) {
        return { content: [{ type: "text", text: `User artifact ${params.id.trim()} was not found in this session.` }], isError: true, details: { action: "read", id: params.id.trim() } };
      }
      const start = Math.min(params.startChar ?? 0, found.text.length);
      const maxChars = Math.min(params.maxChars ?? 16_000, 50_000);
      const end = Math.min(found.text.length, start + maxChars);
      const slice = found.text.slice(start, end);
      const trailer = end < found.text.length
        ? `\n\n[${found.record.id}: showing chars ${start.toLocaleString()}-${end.toLocaleString()} of ${found.text.length.toLocaleString()}; continue with startChar=${end}]`
        : `\n\n[${found.record.id}: end of exact source; ${found.text.length.toLocaleString()} chars total]`;
      return {
        content: [{ type: "text", text: `${slice}${trailer}` }],
        details: { action: "read", id: found.record.id, startChar: start, endChar: end, totalChars: found.text.length, sha256: found.record.sha256 },
      };
    },
  });

  // Pi 0.84.x checks native threshold compaction before it adds a newly submitted
  // user prompt. With reserveTokens=0, a session can therefore be below the model
  // limit at that check and cross the limit only after the new prompt is appended.
  // Close that gap without inventing a reserve: project the incoming prompt itself.
  pi.on("input", async (event, ctx) => {
    let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;

    // Preserve genuinely large human/RPC input before any preflight compaction can
    // run. Ordinary prompts keep the old fast path and do not touch plugin config.
    // Configured lower thresholds are still honored by exact branch backfill at the
    // next compaction; the default threshold is the eager-storage trigger.
    if (event.source !== "extension" && event.text.length >= DEFAULT_CONFIG.userArtifactThresholdChars) {
      try {
        loaded = await loadConfig(ctx);
        if (loaded.config.enabled) {
          await storeUserArtifact({
            sessionId: ctx.sessionManager.getSessionId(),
            text: event.text,
            timestamp: Date.now(),
            thresholdChars: loaded.config.userArtifactThresholdChars,
            previewChars: loaded.config.userArtifactPreviewChars,
          });
        }
      } catch (error) {
        ctx.ui.notify(`Could not preserve oversized user source: ${formatError(error)}`, "warning");
      }
    }

    if (!ctx.isIdle()) return;

    const projection = getPreflightProjection(ctx, event.text, event.images);
    if (!projection || !projectionExceedsContext(projection)) return;

    try {
      loaded ??= await loadConfig(ctx);
    } catch (error) {
      ctx.ui.notify(`One-round compaction config error: ${formatError(error)}`, "error");
      return { action: "handled" };
    }
    if (!loaded || !loaded.config.enabled || !loaded.config.preflightAutoCompact) return;

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

    const previousArtifactState = previousUserArtifactState(event.branchEntries);
    const hasDurableUserSources = previousArtifactState.knownIds.length > 0 || event.branchEntries.some((entry) =>
      entry.type === "message"
      && entry.message.role === "user"
      && contentText(entry.message.content, "").length >= config.userArtifactThresholdChars
    );

    const intentLaneConfig = resolveLaneConfig(config, "intent");
    const executionLaneConfig = resolveLaneConfig(config, "execution");
    const maxRenderBudgets: DeterministicRenderBudgets = {
      intentWorkflowChars: intentWorkflow.active ? config.intentWorkflowChars : 0,
      gitStateChars: config.includeGitState ? config.gitStateChars : 0,
      editedFilesChars: config.editedFilesChars,
      readFilesChars: config.readFilesChars,
      userMessagesChars: config.recentControlChars,
      userArtifactReferencesChars: hasDurableUserSources ? config.userArtifactReferenceChars : 0,
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

    const sessionId = ctx.sessionManager.getSessionId();
    let artifacts: UserArtifactRecord[] = [];
    try {
      await backfillUserArtifacts({
        sessionId,
        branchEntries: event.branchEntries,
        thresholdChars: config.userArtifactThresholdChars,
        previewChars: config.userArtifactPreviewChars,
      });
      artifacts = (await loadUserArtifactManifest(sessionId)).artifacts;
    } catch (error) {
      // Artifact persistence is additive protection. A sidecar I/O failure must not
      // make the primary compaction path unusable; details still carry known IDs.
      ctx.ui.notify(`Oversized user-source archive unavailable: ${formatError(error)}`, "warning");
    }
    const rawBranchArtifactIds = new Set(userArtifactIdsOnBranch(artifacts, event.branchEntries));
    const branchKnownIds = new Set([
      ...previousArtifactState.knownIds,
      ...rawBranchArtifactIds,
    ]);
    const branchArtifacts = artifacts.filter((artifact) => branchKnownIds.has(artifact.id));
    const knownArtifactIds = [...branchKnownIds];
    // Previous v4 state came from this exact branch and remains valid even if a
    // future Pi stops exposing some very old raw entries through getBranch().
    const previousBranchReferences = previousArtifactState.references;

    const executionView = serializeExecutionView(
      allDiscarded,
      config.toolResultChars,
      config.thinkingChars,
    );
    const artifactCandidates = uniqueArtifactCandidates({
      artifacts: branchArtifacts,
      previous: previousBranchReferences,
      knownIds: previousArtifactState.knownIds,
      recalledIds: referencedArtifactIds(executionView),
    });
    const artifactCandidateText = renderArtifactCandidates({
      artifacts: artifactCandidates,
      previous: previousBranchReferences,
      maxChars: config.userArtifactCandidateChars,
    });
    const exposedArtifactIds = new Set(referencedArtifactIds(artifactCandidateText));
    const exposedArtifactCandidates = artifactCandidates.filter((artifact) => exposedArtifactIds.has(artifact.id));

    const deterministicWithoutGit: DeterministicState = {
      ...fileState,
      userMessages,
      durableUserReferences: previousBranchReferences,
      userArtifacts: branchArtifacts,
      knownUserArtifactIds: knownArtifactIds,
      ...(intentWorkflow.active ? { intentWorkflow } : {}),
    };
    const intentPrompt = buildLanePrompt({
      lane: "intent",
      lanePrompt: intentWorkflow.active ? promptSet.workflowImplementation : promptSet.intent,
      serializedConversation: intentWorkflow.active ? executionView : serializeIntentView(allDiscarded),
      previousSummary: boundary.previousSummary,
      customInstructions: event.customInstructions,
      deterministic: deterministicWithoutGit,
      renderBudgets: maxRenderBudgets,
      isSplitTurn: boundary.isSplitTurn,
      ...(artifactCandidateText ? { userArtifactCandidates: artifactCandidateText } : {}),
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
      const evaluatedReferences = reconcileDurableUserReferences({
        candidates: exposedArtifactCandidates,
        previous: previousBranchReferences.filter((reference) => exposedArtifactIds.has(reference.id)),
        llmText: intent.text,
      });
      // A reference that could not fit into this compaction's candidate prompt is
      // not counted as an omission; preserve its lifecycle until the LLM actually
      // has a chance to evaluate it.
      const unevaluatedPrevious = previousBranchReferences.filter((reference) => !exposedArtifactIds.has(reference.id));
      const referenceMap = new Map<string, DurableUserReference>();
      for (const reference of [...unevaluatedPrevious, ...evaluatedReferences]) referenceMap.set(reference.id, reference);
      const durableUserReferences = [...referenceMap.values()];

      const deterministic: DeterministicState = {
        ...deterministicWithoutGit,
        durableUserReferences,
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
          `userMessageChars: ${config.userMessageChars} (per compacted HUMAN user message; synthetic extension/subagent messages excluded)`,
          `userArtifactThresholdChars: ${config.userArtifactThresholdChars} (exact oversized human source archive)`,
          `userArtifactPreviewChars: ${config.userArtifactPreviewChars}`,
          `userArtifactCandidateChars: ${config.userArtifactCandidateChars} (intent-lane semantic classification budget)`,
          `userArtifactReferenceChars: ${config.userArtifactReferenceChars} (checkpoint active/cooling reference budget)`,
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
