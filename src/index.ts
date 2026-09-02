import { createHash } from "node:crypto";
import { contentText, StringEnum } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_CONFIG, loadConfig, resolveLaneConfig } from "./config.js";
import {
  activateIntentWorkflowForSession,
  detectIntentWorkflow,
  shouldCarryPreviousCheckpointForIntent,
} from "./intent-workflow.js";
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
  protectLaneAnchor,
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
  loadUserArtifactCatalog,
  maxUserArtifactOrdinal,
  previousUserArtifactState,
  readCatalogUserArtifact,
  reconcileDurableUserReferences,
  referencedArtifactIds,
  renderArtifactCandidates,
  resolveLegacyArtifactProvenance,
  resolveUserArtifactSessionSources,
  searchUserArtifactCatalog,
  storeUserArtifact,
  userArtifactHashes,
  userArtifactKey,
  userArtifactRecordsOnBranch,
  type DurableUserReference,
  type UserArtifactLocator,
  type UserArtifactRecord,
} from "./user-artifacts.js";


const UserArtifactToolParams = Type.Object({
  action: StringEnum(["list", "read", "search"] as const),
  id: Type.Optional(Type.String({ description: "Known durable source id such as U0001 (read)." })),
  sourceSessionId: Type.Optional(Type.String({ description: "Provenance session id shown beside a durable source; use when supplied or when the same U#### exists in multiple visible sessions." })),
  query: Type.Optional(Type.String({ description: "Case-insensitive text query over archived oversized human messages (search)." })),
  startChar: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for paged read." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Maximum exact characters returned by read; default 16000." })),
});

function formatArtifactCatalog(records: UserArtifactRecord[]): string {
  if (records.length === 0) return "No oversized human user sources are available on this branch or inherited fork lineage.";
  return records.map((record) => `- ${record.id} sourceSessionId=${record.sourceSessionId ?? "unknown"}: ${record.chars.toLocaleString()} chars; ${record.preview}`).join("\n");
}

function matchingArtifact(artifacts: UserArtifactRecord[], locator: UserArtifactLocator): UserArtifactRecord | undefined {
  return artifacts.find((artifact) => artifact.id === locator.id
    && (!locator.sourceSessionId || artifact.sourceSessionId === locator.sourceSessionId));
}

function uniqueArtifactCandidates(params: {
  artifacts: UserArtifactRecord[];
  previous: DurableUserReference[];
  knownArtifacts: UserArtifactLocator[];
  recalledIds: string[];
}): UserArtifactRecord[] {
  const known = new Set(params.knownArtifacts.map(userArtifactKey));
  const ordered: UserArtifactRecord[] = [];
  const seen = new Set<string>();
  const push = (record: UserArtifactRecord | undefined): void => {
    if (!record) return;
    const key = userArtifactKey(record);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(record);
  };

  for (const reference of [...params.previous].sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    return a.id.localeCompare(b.id);
  })) push(matchingArtifact(params.artifacts, reference));

  for (const artifact of [...params.artifacts]
    .filter((artifact) => !known.has(userArtifactKey(artifact)))
    .sort((a, b) => b.timestamp - a.timestamp)) push(artifact);

  for (const id of params.recalledIds) {
    for (const artifact of params.artifacts) if (artifact.id === id) push(artifact);
  }
  return ordered;
}

async function artifactSourcesForContext(ctx: ExtensionContext) {
  // ExtensionContext normally exposes these methods, but keep the archive usable
  // in lightweight/embedded Pi runtimes that only provide a session id.
  const manager = ctx.sessionManager as unknown as {
    getSessionId(): string;
    getSessionFile?: () => string | undefined;
    getHeader?: () => { parentSession?: string } | null;
  };
  const currentSessionFile = manager.getSessionFile?.();
  const parentSession = manager.getHeader?.()?.parentSession;
  return resolveUserArtifactSessionSources({
    currentSessionId: manager.getSessionId(),
    ...(currentSessionFile ? { currentSessionFile } : {}),
    ...(parentSession ? { parentSession } : {}),
  });
}

async function loadBranchArtifactContext(params: {
  ctx: ExtensionContext;
  branchEntries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  thresholdChars: number;
  previewChars: number;
}): Promise<{
  branchArtifacts: UserArtifactRecord[];
  previousReferences: DurableUserReference[];
  knownArtifacts: UserArtifactLocator[];
  previousKnownArtifacts: UserArtifactLocator[];
}> {
  const sources = await artifactSourcesForContext(params.ctx);
  const inherited = await loadUserArtifactCatalog(sources.slice(1));
  await backfillUserArtifacts({
    sessionId: params.ctx.sessionManager.getSessionId(),
    branchEntries: params.branchEntries,
    thresholdChars: params.thresholdChars,
    previewChars: params.previewChars,
    skipSha256: userArtifactHashes(inherited),
    minNextId: maxUserArtifactOrdinal(inherited) + 1,
  });
  const artifacts = await loadUserArtifactCatalog(sources);
  const previous = previousUserArtifactState(params.branchEntries);
  const normalized = resolveLegacyArtifactProvenance({
    artifacts,
    references: previous.references,
    knownArtifacts: previous.knownArtifacts,
    knownIds: previous.knownIds,
    ...(previous.checkpointTimestamp !== undefined ? { checkpointTimestamp: previous.checkpointTimestamp } : {}),
  });
  const rawBranchArtifacts = userArtifactRecordsOnBranch(artifacts, params.branchEntries);
  const known = new Map<string, UserArtifactLocator>();
  for (const locator of normalized.knownArtifacts) {
    const record = matchingArtifact(artifacts, locator);
    if (record?.sourceSessionId) known.set(userArtifactKey(record), { id: record.id, sourceSessionId: record.sourceSessionId });
  }
  for (const record of rawBranchArtifacts) {
    if (record.sourceSessionId) known.set(userArtifactKey(record), { id: record.id, sourceSessionId: record.sourceSessionId });
  }
  const knownArtifacts = [...known.values()];
  const previousKnownArtifacts = normalized.knownArtifacts.flatMap((locator) => {
    const record = matchingArtifact(artifacts, locator);
    return record?.sourceSessionId ? [{ id: record.id, sourceSessionId: record.sourceSessionId }] : [];
  });
  const knownKeys = new Set(knownArtifacts.map(userArtifactKey));
  return {
    branchArtifacts: artifacts.filter((artifact) => knownKeys.has(userArtifactKey(artifact))),
    previousReferences: normalized.references.filter((reference) => knownKeys.has(userArtifactKey(reference))),
    knownArtifacts,
    previousKnownArtifacts,
  };
}

async function preserveIncomingUserArtifact(params: {
  ctx: ExtensionContext;
  text: string;
  timestamp: number;
  thresholdChars: number;
  previewChars: number;
}): Promise<void> {
  const sources = await artifactSourcesForContext(params.ctx);
  const inherited = await loadUserArtifactCatalog(sources.slice(1));
  const sha256 = createHash("sha256").update(params.text).digest("hex");
  if (userArtifactHashes(inherited).has(sha256)) return;
  await storeUserArtifact({
    sessionId: params.ctx.sessionManager.getSessionId(),
    text: params.text,
    timestamp: params.timestamp,
    thresholdChars: params.thresholdChars,
    previewChars: params.previewChars,
    minNextId: maxUserArtifactOrdinal(inherited) + 1,
  });
}

function artifactWasRendered(text: string, artifact: UserArtifactRecord): boolean {
  return text.includes(artifact.id)
    && Boolean(artifact.sourceSessionId && text.includes(`sourceSessionId=${artifact.sourceSessionId}`));
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
    description: "Recover exact oversized human user messages preserved outside normal context, including sources inherited from a forked parent session. Actions: list, search, read.",
    promptSnippet: "Recover exact oversized human plans/specs saved across compactions and forked parent sessions",
    promptGuidelines: [
      "When a checkpoint marks a U#### source as governing, read that exact source before planning, delegating, editing, or implementing work governed by it; the checkpoint summary is not a substitute for the exact source.",
      "Use both id and sourceSessionId when they are shown. Supporting/log sources need retrieval only when exact evidence or wording matters.",
      "Search archived sources instead of assuming compaction lost an older oversized user message.",
    ],
    parameters: UserArtifactToolParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let config;
      try {
        ({ config } = await loadConfig(ctx));
      } catch (error) {
        return { content: [{ type: "text", text: `user_artifact configuration error: ${formatError(error)}` }], isError: true, details: { action: params.action } };
      }
      let artifactContext;
      try {
        artifactContext = await loadBranchArtifactContext({
          ctx,
          branchEntries: ctx.sessionManager.getBranch(),
          thresholdChars: config.userArtifactThresholdChars,
          previewChars: config.userArtifactPreviewChars,
        });
      } catch (error) {
        return { content: [{ type: "text", text: `user_artifact archive unavailable: ${formatError(error)}` }], isError: true, details: { action: params.action } };
      }
      const visible = artifactContext.branchArtifacts;
      if (params.action === "list") {
        const records = [...visible].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
        return { content: [{ type: "text", text: formatArtifactCatalog(records) }], details: { action: "list", count: records.length, records } };
      }
      if (params.action === "search") {
        if (!params.query?.trim()) {
          return { content: [{ type: "text", text: "user_artifact search requires query." }], isError: true, details: { action: "search" } };
        }
        const allowedKeys = new Set(visible.map(userArtifactKey));
        const sources = await artifactSourcesForContext(ctx);
        const catalog = await loadUserArtifactCatalog(sources);
        const records = await searchUserArtifactCatalog(catalog, params.query, 20, allowedKeys);
        return {
          content: [{ type: "text", text: records.length ? formatArtifactCatalog(records) : `No oversized human user source matched: ${params.query}` }],
          details: { action: "search", query: params.query, records },
        };
      }

      if (!params.id?.trim()) {
        return { content: [{ type: "text", text: "user_artifact read requires id (for example U0001)." }], isError: true, details: { action: "read" } };
      }
      const requestedId = params.id.trim();
      const requestedSource = params.sourceSessionId?.trim();
      const matches = visible.filter((artifact) => artifact.id === requestedId
        && (!requestedSource || artifact.sourceSessionId === requestedSource));
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `User artifact ${requestedId}${requestedSource ? ` from sourceSessionId=${requestedSource}` : ""} is not available on the current session branch or inherited fork lineage.` }], isError: true, details: { action: "read", id: requestedId, sourceSessionId: requestedSource } };
      }
      if (matches.length > 1 && !requestedSource) {
        const sources = matches.map((artifact) => artifact.sourceSessionId ?? "unknown");
        return { content: [{ type: "text", text: `User artifact ${requestedId} is ambiguous across visible fork sources. Retry with sourceSessionId. Visible sources: ${sources.join(", ")}` }], isError: true, details: { action: "read", id: requestedId, sources } };
      }
      const found = await readCatalogUserArtifact(matches[0]!);
      if (!found) {
        return { content: [{ type: "text", text: `User artifact ${requestedId} could not be read from its preserved source session.` }], isError: true, details: { action: "read", id: requestedId, sourceSessionId: matches[0]?.sourceSessionId } };
      }
      const startChar = Math.min(params.startChar ?? 0, found.text.length);
      const maxChars = Math.min(params.maxChars ?? 16_000, 50_000);
      const endChar = Math.min(found.text.length, startChar + maxChars);
      const slice = found.text.slice(startChar, endChar);
      const sourceLabel = `${found.record.id} sourceSessionId=${found.record.sourceSessionId ?? "unknown"}`;
      const trailer = endChar < found.text.length
        ? `\n\n[${sourceLabel}: showing chars ${startChar.toLocaleString()}-${endChar.toLocaleString()} of ${found.text.length.toLocaleString()}; continue with startChar=${endChar}]`
        : `\n\n[${sourceLabel}: end of exact source; ${found.text.length.toLocaleString()} chars total]`;
      return {
        content: [{ type: "text", text: `${slice}${trailer}` }],
        details: { action: "read", id: found.record.id, sourceSessionId: found.record.sourceSessionId, startChar, endChar, totalChars: found.text.length, sha256: found.record.sha256 },
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
          await preserveIncomingUserArtifact({
            ctx,
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
      intentWorkflowChars: (intentWorkflow.active || intentWorkflow.reason === "pending-reconciliation") ? config.intentWorkflowChars : 0,
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
    const previousSummary = shouldCarryPreviousCheckpointForIntent(event.branchEntries, intentWorkflow)
      ? boundary.previousSummary
      : undefined;
    const allDiscarded = boundary.messagesToSummarize;
    if (allDiscarded.length === 0) return;

    const fileState = collectFileState(event, allDiscarded);
    const userMessages = collectUserMessageLedger(
      event.branchEntries,
      boundary.firstKeptEntryId,
      config.userMessageChars,
    );

    let branchArtifacts: UserArtifactRecord[] = [];
    let knownArtifacts: UserArtifactLocator[] = [];
    let previousKnownArtifacts: UserArtifactLocator[] = [];
    let previousBranchReferences: DurableUserReference[] = [];
    try {
      const artifactContext = await loadBranchArtifactContext({
        ctx,
        branchEntries: event.branchEntries,
        thresholdChars: config.userArtifactThresholdChars,
        previewChars: config.userArtifactPreviewChars,
      });
      branchArtifacts = artifactContext.branchArtifacts;
      knownArtifacts = artifactContext.knownArtifacts;
      previousKnownArtifacts = artifactContext.previousKnownArtifacts;
      previousBranchReferences = artifactContext.previousReferences;
    } catch (error) {
      // Artifact persistence is additive protection. A sidecar/parent-lineage I/O
      // failure must not make the primary compaction path unusable.
      ctx.ui.notify(`Oversized user-source archive unavailable: ${formatError(error)}`, "warning");
    }
    const knownArtifactIds = [...new Set(knownArtifacts.map((artifact) => artifact.id))];

    const executionView = serializeExecutionView(
      allDiscarded,
      config.toolResultChars,
      config.thinkingChars,
    );
    const artifactCandidates = uniqueArtifactCandidates({
      artifacts: branchArtifacts,
      previous: previousBranchReferences,
      knownArtifacts: previousKnownArtifacts,
      recalledIds: referencedArtifactIds(executionView),
    });
    const artifactCandidateText = renderArtifactCandidates({
      artifacts: artifactCandidates,
      previous: previousBranchReferences,
      maxChars: config.userArtifactCandidateChars,
    });
    const exposedArtifactCandidates = artifactCandidates.filter((artifact) => artifactWasRendered(artifactCandidateText, artifact));
    const exposedArtifactKeys = new Set(exposedArtifactCandidates.map(userArtifactKey));

    const deterministicWithoutGit: DeterministicState = {
      ...fileState,
      userMessages,
      durableUserReferences: previousBranchReferences,
      userArtifacts: branchArtifacts,
      knownUserArtifacts: knownArtifacts,
      knownUserArtifactIds: knownArtifactIds,
      ...(intentWorkflow.active ? { intentWorkflow } : {}),
      ...(!intentWorkflow.active && intentWorkflow.reason === "pending-reconciliation" && intentWorkflow.workstream && intentWorkflow.generation && intentWorkflow.intentPath
        ? {
            pendingIntentReconciliation: {
              workstream: intentWorkflow.workstream,
              generation: intentWorkflow.generation,
              intentPath: intentWorkflow.intentPath,
            },
          }
        : {}),
    };
    const intentPrompt = buildLanePrompt({
      lane: "intent",
      lanePrompt: intentWorkflow.active ? promptSet.workflowImplementation : promptSet.intent,
      serializedConversation: intentWorkflow.active ? executionView : serializeIntentView(allDiscarded),
      previousSummary,
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
      previousSummary,
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
      ? `intent-workflow=${intentWorkflow.workstream}@${intentWorkflow.generation}`
      : intentWorkflow.reason === "pending-reconciliation"
        ? `intent-workflow=${intentWorkflow.workstream ?? "unknown"}@${intentWorkflow.generation ?? "?"} PENDING_RECONCILIATION (old contract/checkpoint suppressed)`
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
      const [rawIntent, rawExecution, git] = await Promise.all([
        runTrackedLane("intent", intentPrompt),
        runTrackedLane("execution", executionPrompt),
        config.includeGitState ? collectGitState(ctx.cwd) : Promise.resolve(undefined),
      ]);
      const intent = protectLaneAnchor(rawIntent, intentWorkflow.active ? "implementation" : "intent");
      const execution = protectLaneAnchor(rawExecution, intentWorkflow.active ? "evidence" : "execution");

      progress.merging();
      const evaluatedReferences = reconcileDurableUserReferences({
        candidates: exposedArtifactCandidates,
        previous: previousBranchReferences.filter((reference) => exposedArtifactKeys.has(userArtifactKey(reference))),
        llmText: intent.text,
      });
      // A reference that could not fit into this compaction's candidate prompt is
      // not counted as an omission; preserve its lifecycle until the LLM actually
      // has a chance to evaluate it.
      const unevaluatedPrevious = previousBranchReferences.filter((reference) => !exposedArtifactKeys.has(userArtifactKey(reference)));
      const referenceMap = new Map<string, DurableUserReference>();
      for (const reference of [...unevaluatedPrevious, ...evaluatedReferences]) referenceMap.set(userArtifactKey(reference), reference);
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
            ? `intent workflow: ACTIVE workstream=${intentWorkflow.workstream} generation=${intentWorkflow.generation} plan=${Boolean(intentWorkflow.plan)} intentTruncated=${intentWorkflow.intentTruncated} planTruncated=${intentWorkflow.planTruncated}`
            : intentWorkflow.reason === "pending-reconciliation"
              ? `intent workflow: PENDING_RECONCILIATION workstream=${intentWorkflow.workstream ?? "unknown"} generation=${intentWorkflow.generation ?? "?"}; old intent contract and previous checkpoint are suppressed until confirmed`
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
