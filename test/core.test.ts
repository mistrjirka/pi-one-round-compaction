import assert from "node:assert/strict";
import test from "node:test";

import {
  collectFileState,
  collectUserMessageLedger,
  compactPreviousSummaryForPrompt,
  computeEffectiveRecentTokenBudget,
  computeLaneOutputTokenBudget,
  deterministicMerge,
  emptyUsageForTests,
  extractRecentUserContext,
  fitCheckpointToTarget,
  parseModelReference,
  prepareWholeTurnCompaction,
  protectLaneAnchor,
  serializeExecutionView,
  type DeterministicState,
  type LaneResult,
} from "../src/core.js";

function user(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "test",
    model: "test",
    usage: emptyUsageForTests(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function messageEntry(id: string, message: ReturnType<typeof user> | ReturnType<typeof assistant>) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

function compactionEvent(branchEntries: unknown[], keepRecentTokens: number, nativeFirstKeptEntryId: string) {
  return {
    branchEntries,
    preparation: {
      firstKeptEntryId: nativeFirstKeptEntryId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      previousSummary: undefined,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens },
    },
  } as never;
}

test("execution view labels and truncates extension messages as evidence rather than user input", () => {
  const messages = [{
    role: "custom" as const,
    customType: "pi-subagents",
    content: `Background task completed: ${"x".repeat(500)}`,
    display: true,
    timestamp: Date.now(),
  }];
  const text = serializeExecutionView(messages as never, 80, 0);
  assert.match(text, /^\[Extension message: pi-subagents\]: Background task completed:/);
  assert.match(text, /chars omitted/);
  assert.ok(text.length < 180);
});

test("execution view gives final subagent notification more room than transcript/status evidence", () => {
  const messages = [
    {
      role: "custom" as const,
      customType: "subagent-notify",
      content: `Background task completed: workflow\n${"child-evidence ".repeat(500)}\nWorkflow run: wf-final`,
      display: true,
      timestamp: Date.now(),
    },
    {
      role: "toolResult" as const,
      toolCallId: "transcript",
      toolName: "subagent",
      content: [{ type: "text" as const, text: `Transcript target: run-1\n${"overlap ".repeat(1000)}\nTAIL` }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  const text = serializeExecutionView(messages as never, 2_000, 0);
  const notifyStart = text.indexOf("[Extension message: subagent-notify]");
  const transcriptStart = text.indexOf("[Tool result: subagent]");
  assert.ok(notifyStart >= 0 && transcriptStart > notifyStart);
  const notify = text.slice(notifyStart, transcriptStart);
  const transcript = text.slice(transcriptStart);
  assert.ok(notify.length > 6_000, notify.length.toString());
  assert.ok(transcript.length < 2_200, transcript.length.toString());
  assert.match(notify, /Workflow run: wf-final/);
});

test("execution view preserves both ends of long subagent completion messages", () => {
  const messages = [{
    role: "custom" as const,
    customType: "pi-subagents",
    content: `Background task completed: workflow\n${"middle-detail ".repeat(400)}\nWorkflow run: wf-123\nChild runs: backend=run-backend-456 frontend=run-front-789`,
    display: true,
    timestamp: Date.now(),
  }];
  const text = serializeExecutionView(messages as never, 500, 0);
  assert.match(text, /Background task completed/);
  assert.match(text, /Workflow run: wf-123/);
  assert.match(text, /run-backend-456/);
  assert.match(text, /chars omitted from middle/);
  assert.ok(text.length < 650);
});

test("execution view truncates tool results", () => {
  const messages = [
    user("Do it"),
    {
      role: "toolResult" as const,
      toolCallId: "1",
      toolName: "read",
      content: [{ type: "text" as const, text: "x".repeat(100) }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  const text = serializeExecutionView(messages, 20, 0);
  assert.match(text, /20 more|80 chars omitted|chars omitted/);
  assert.ok(text.length < 100);
});

test("execution view gives dense structural results more room than raw reads", () => {
  const dense = "DENSE-END" + "x".repeat(4_500);
  const raw = "RAW-END" + "y".repeat(4_500);
  const messages = [
    {
      role: "toolResult" as const,
      toolCallId: "1",
      toolName: "codegraph_explore",
      content: [{ type: "text" as const, text: dense }],
      isError: false,
      timestamp: Date.now(),
    },
    {
      role: "toolResult" as const,
      toolCallId: "2",
      toolName: "read",
      content: [{ type: "text" as const, text: raw }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  const text = serializeExecutionView(messages, 2_000, 0);
  assert.match(text, /\[Tool result: codegraph_explore\]/);
  assert.match(text, /\[Tool result: read\]/);
  const denseBlock = text.slice(text.indexOf("[Tool result: codegraph_explore]"), text.indexOf("[Tool result: read]"));
  const rawBlock = text.slice(text.indexOf("[Tool result: read]"));
  assert.ok(denseBlock.length > 4_000, denseBlock.length.toString());
  assert.ok(rawBlock.length < 2_200, rawBlock.length.toString());
});

test("execution view replaces exact user_artifact body with a durable locator", () => {
  const messages = [{
    role: "toolResult" as const,
    toolCallId: "artifact-1",
    toolName: "user_artifact",
    content: [{ type: "text" as const, text: `EXACT SECRET PLAN ${"z".repeat(20_000)}` }],
    details: {
      action: "read",
      id: "U0007",
      sourceSessionId: "parent-session",
      startChar: 0,
      endChar: 20_018,
      totalChars: 20_018,
    },
    isError: false,
    timestamp: Date.now(),
  }];
  const text = serializeExecutionView(messages as never, 2_000, 0);
  assert.match(text, /\[Tool result: user_artifact\]/);
  assert.match(text, /id=U0007/);
  assert.match(text, /sourceSessionId=parent-session/);
  assert.match(text, /exact source remains recoverable/);
  assert.doesNotMatch(text, /EXACT SECRET PLAN/);
  assert.ok(text.length < 400);
});

test("recent user context walks backward under a character budget", () => {
  const messages = [user("old"), assistant("x"), user("newest-plan")];
  assert.deepEqual(extractRecentUserContext(messages, 20), ["old", "newest-plan"]);
  assert.deepEqual(extractRecentUserContext(messages, 5), ["newes\n[… user message truncated]"]);
});

test("whole-turn retention keeps the newest complete turns that fit the token budget", () => {
  const entries = [
    messageEntry("u1", user(`u1-${"x".repeat(117)}`)),
    messageEntry("a1", assistant(`a1-${"x".repeat(117)}`)),
    messageEntry("u2", user(`u2-${"x".repeat(117)}`)),
    messageEntry("a2", assistant(`a2-${"x".repeat(117)}`)),
    messageEntry("u3", user(`u3-${"x".repeat(117)}`)),
    messageEntry("a3", assistant(`a3-${"x".repeat(117)}`)),
  ];

  const oneTurn = prepareWholeTurnCompaction(compactionEvent(entries, 70, "a3"));
  assert.equal(oneTurn.boundaryMode, "whole-turn");
  assert.equal(oneTurn.firstKeptEntryId, "u3");
  assert.equal(oneTurn.retainedTurns, 1);
  assert.ok(oneTurn.estimatedRetainedTokens <= 70);
  assert.equal(oneTurn.isSplitTurn, false);

  const twoTurns = prepareWholeTurnCompaction(compactionEvent(entries, 130, "a3"));
  assert.equal(twoTurns.firstKeptEntryId, "u2");
  assert.equal(twoTurns.retainedTurns, 2);
  assert.ok(twoTurns.estimatedRetainedTokens <= 130);
});

test("oversized newest turn is split at a safe message boundary instead of surviving verbatim", () => {
  const entries = [
    messageEntry("u1", user("old request")),
    messageEntry("a1", assistant("old response")),
    messageEntry("u2", user(`huge-${"x".repeat(399)}`)),
    messageEntry("a2", assistant(`huge-${"x".repeat(399)}`)),
  ];
  const result = prepareWholeTurnCompaction(compactionEvent(entries, 50, "a2"));
  assert.equal(result.boundaryMode, "split-turn");
  assert.equal(result.firstKeptEntryId, "a2");
  assert.equal(result.isSplitTurn, true);
  assert.ok(result.messagesToSummarize.length >= 3);
  // A single assistant message can itself exceed the target, but the whole giant
  // user+assistant turn is no longer retained.
  assert.ok(result.estimatedRetainedTokens < 150);
});

test("tool-heavy oversized turn retains only a bounded provider-safe suffix", () => {
  const entries: unknown[] = [
    messageEntry("u1", user("older")),
    messageEntry("a1", assistant("older response")),
    messageEntry("u2", user("run the long tool workflow")),
  ];
  for (let i = 0; i < 10; i++) {
    entries.push({
      type: "message",
      id: `at${i}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        ...assistant(""),
        content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
      },
    });
    entries.push({
      type: "message",
      id: `tr${i}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: `tc${i}`,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(40_000) }],
        isError: false,
        timestamp: Date.now(),
      },
    });
  }
  const result = prepareWholeTurnCompaction(compactionEvent(entries, 20_000, "at9"));
  assert.equal(result.boundaryMode, "split-turn");
  assert.equal(result.isSplitTurn, true);
  assert.ok(result.estimatedRetainedTokens <= 20_000);
  assert.ok(result.estimatedRetainedTokens >= 9_000);
});

test("single-turn pathological case uses the plugin split boundary so compaction can make progress", () => {
  const first = user(`huge-${"x".repeat(399)}`);
  const second = assistant(`huge-${"x".repeat(399)}`);
  const event = {
    branchEntries: [messageEntry("u1", first), messageEntry("a1", second)],
    preparation: {
      firstKeptEntryId: "a1",
      messagesToSummarize: [],
      turnPrefixMessages: [first],
      isSplitTurn: true,
      tokensBefore: 300,
      previousSummary: undefined,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 50 },
    },
  } as never;
  const result = prepareWholeTurnCompaction(event);
  assert.equal(result.boundaryMode, "split-turn");
  assert.equal(result.firstKeptEntryId, "a1");
  assert.equal(result.isSplitTurn, true);
  assert.equal(result.messagesToSummarize.length, 1);
});

test("file state renders trace edits by most recent tool touch", () => {
  const toolMessage = {
    ...assistant(""),
    content: [
      { type: "toolCall" as const, id: "tc1", name: "edit", arguments: { path: "a.ts" } },
      { type: "toolCall" as const, id: "tc2", name: "read", arguments: { path: "read-only.ts" } },
      { type: "toolCall" as const, id: "tc3", name: "readSeek_edit", arguments: { path: "b.ts" } },
      { type: "toolCall" as const, id: "tc4", name: "edit", arguments: { path: "a.ts" } },
    ],
  };
  const preparation = {
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  };
  const result = collectFileState({ preparation, branchEntries: [] } as never, [toolMessage] as never);
  assert.deepEqual(result.modifiedFiles, ["a.ts", "b.ts"]);
  assert.deepEqual(result.traceEditedFiles, ["a.ts", "b.ts"]);
  assert.deepEqual(result.traceReadFiles, ["read-only.ts"]);
});

test("file state restores previous extension details cumulatively", () => {
  const preparation = {
    fileOps: {
      read: new Set(["new-read.ts"]),
      written: new Set<string>(),
      edited: new Set(["new-edit.ts"]),
    },
  };
  const branchEntries = [
    {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "old",
      firstKeptEntryId: "x",
      tokensBefore: 1,
      details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-edit.ts"] },
    },
  ];
  const result = collectFileState({ preparation, branchEntries } as never);
  assert.deepEqual(result.modifiedFiles, ["new-edit.ts", "old-edit.ts"]);
  assert.deepEqual(result.readFiles, ["new-read.ts", "old-read.ts"]);
});

test("deterministic merge keeps lane domains separate and appends state", () => {
  const usage = emptyUsageForTests();
  const audit: LaneResult = {
    lane: "audit",
    text: "## Active Obligations\n- Ship strict tools",
    usage,
    model: "p/m",
    thinkingLevel: "low",
    durationMs: 10,
  };
  const execution: LaneResult = {
    lane: "execution",
    text: "## Done\n- inventory",
    usage,
    model: "p/m",
    thinkingLevel: "low",
    durationMs: 11,
  };
  const deterministic: DeterministicState = {
    userMessages: [{ timestamp: 1, text: "Do not touch UI", originalChars: 15, trimmed: false }],
    readFiles: [],
    modifiedFiles: ["api/a.ts"],
    traceReadFiles: [],
    traceEditedFiles: ["api/a.ts"],
  };
  const text = deterministicMerge({
    audit,
    execution,
    deterministic,
    renderBudgets: {
      gitStateChars: 0,
      editedFilesChars: 2000,
      readFilesChars: 0,
      userMessagesChars: 2000,
      userArtifactReferencesChars: 0,
    },
    isSplitTurn: false,
  });
  assert.match(text, /# Compaction Checkpoint/);
  assert.match(text, /## Work-State Audit/);
  assert.match(text, /## Execution State/);
  assert.match(text, /Do not touch UI/);
  assert.match(text, /api\/a\.ts/);
});

test("post-compaction raw budget reserves deterministic and structural checkpoint room", () => {
  assert.equal(computeEffectiveRecentTokenBudget({
    targetPostCompactTokens: 40_000,
    keepRecentTokens: 32_000,
    deterministicReserveChars: 35_000,
  }), 30_250);
});

test("lane output budget is derived from the current checkpoint room", () => {
  assert.equal(computeLaneOutputTokenBudget({
    targetPostCompactTokens: 40_000,
    estimatedRetainedTokens: 20_000,
  }), 19_000);
  assert.equal(computeLaneOutputTokenBudget({
    targetPostCompactTokens: 40_000,
    estimatedRetainedTokens: 32_000,
  }), 7_000);
});

test("cumulative user ledger spans earlier compaction boundaries and caps each message", () => {
  const long = "z".repeat(1_500);
  const entries = [
    messageEntry("u1", user(long)),
    messageEntry("a1", assistant("first")),
    {
      type: "compaction" as const,
      id: "c1",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      summary: "prior",
      firstKeptEntryId: "u2",
      tokensBefore: 1,
    },
    messageEntry("u2", user("second request")),
    messageEntry("a2", assistant("second")),
    messageEntry("u3", user("kept raw")),
  ];
  const ledger = collectUserMessageLedger(entries as never, "u3", 900);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]?.originalChars, 1_500);
  assert.equal(ledger[0]?.trimmed, true);
  assert.ok((ledger[0]?.text.length ?? 0) <= 900);
  assert.match(ledger[0]?.text ?? "", /TRIMMED: original 1,500 chars/);
  assert.equal(ledger[1]?.text, "second request");
});

test("cumulative user ledger ignores legacy v3 details and reconstructs genuine raw users", () => {
  const timestamp = Date.now();
  const original = "q".repeat(1_200);
  const rawUser = { role: "user" as const, content: original, timestamp };
  const cappedMarker = "\n[TRIMMED: original 1,200 chars]";
  const capped = `${original.slice(0, 900 - cappedMarker.length)}${cappedMarker}`;
  const entries = [
    messageEntry("u1", rawUser),
    messageEntry("a1", assistant("done")),
    {
      type: "compaction" as const,
      id: "c1",
      parentId: "a1",
      timestamp: new Date(timestamp + 1).toISOString(),
      summary: "prior",
      firstKeptEntryId: "u2",
      tokensBefore: 1,
      details: {
        plugin: "pi-one-round-compaction",
        version: 3,
        userMessages: [{ timestamp, text: capped, originalChars: 1_200, trimmed: true }],
      },
    },
    messageEntry("u2", user("new compacted request")),
    messageEntry("a2", assistant("done 2")),
    messageEntry("u3", user("kept")),
  ];
  const ledger = collectUserMessageLedger(entries as never, "u3", 900);
  assert.equal(ledger.length, 2);
  assert.equal(ledger.filter((entry) => entry.originalChars === 1_200).length, 1);
  assert.match(ledger[0]?.text ?? "", /TRIMMED: original 1,200 chars/);
});

test("cumulative user ledger excludes custom/subagent notifications converted to LLM user role", () => {
  const timestamp = Date.now();
  const entries = [
    messageEntry("u1", { role: "user" as const, content: "real human request", timestamp }),
    {
      type: "custom_message" as const,
      id: "cm1",
      parentId: "u1",
      timestamp: new Date(timestamp + 1).toISOString(),
      customType: "pi-subagents",
      content: "Background task completed: implementer\nSubagent progress update.",
      display: true,
    },
    messageEntry("a1", assistant("done")),
    messageEntry("u2", user("kept raw")),
  ];
  const ledger = collectUserMessageLedger(entries as never, "u2", 900);
  assert.deepEqual(ledger.map((entry) => entry.text), ["real human request"]);
  assert.doesNotMatch(ledger.map((entry) => entry.text).join("\n"), /Background task|Subagent progress/);
});

test("previous checkpoint carry-forward keeps audit obligations and drops execution state", () => {
  const prior = `# Compaction Checkpoint

## Work-State Audit
## Active Obligations
- FETCHER-VALIDATION remains OPEN.

## Obligation Status
- FETCHER-VALIDATION — OPEN; accepted earlier and no completion evidence exists.

## Decisions That Still Matter
- The user already approved this work.

## Contradictions / Unsupported Claims
- A prior completion claim omitted FETCHER-VALIDATION.

## Do-Not-Repeat Knowledge
- Do not ask for approval again.

## Important Unknowns
- None

## Execution State
## Continuation Anchor
- Run focused validation.

## Done
- notification cleanup

## Deterministic State
HEAD: stale`;
  const audit = compactPreviousSummaryForPrompt(prior, "audit", 2_000);
  const execution = compactPreviousSummaryForPrompt(prior, "execution", 2_000);
  assert.match(audit ?? "", /FETCHER-VALIDATION/);
  assert.match(audit ?? "", /already approved/);
  assert.doesNotMatch(audit ?? "", /notification cleanup/);
  assert.match(execution ?? "", /Run focused validation/);
  assert.doesNotMatch(execution ?? "", /FETCHER-VALIDATION/);
  assert.doesNotMatch(execution ?? "", /HEAD: stale/);
});

test("v5 task-semantics checkpoint is translated into neutral audit migration evidence", () => {
  const prior = `# Compaction Checkpoint

## Task Semantics
## Current Objective
- Finish PR #59.

## Accepted Plan / Scope
- Fix the pool race and validation.

## User Priorities / Decision State
- Already approved; do not ask again.

## Constraints / Exclusions / User Corrections
- Do not touch unrelated formatting.

## Execution State
## Continuation Anchor
- Run the focused tests.

## Remaining / Immediate Next Actions
1. Run tests.`;

  const audit = compactPreviousSummaryForPrompt(prior, "audit", 4_000);
  const execution = compactPreviousSummaryForPrompt(prior, "execution", 4_000);
  assert.match(audit ?? "", /Previous checkpoint migration evidence/);
  assert.match(audit ?? "", /Fix the pool race and validation/);
  assert.match(audit ?? "", /Already approved; do not ask again/);
  assert.doesNotMatch(audit ?? "", /^## Task Semantics$/m);
  assert.doesNotMatch(audit ?? "", /Run the focused tests/);
  assert.match(execution ?? "", /Run the focused tests/);
});

test("native Pi checkpoint is split into audit and execution migration evidence", () => {
  const prior = `## Goal
- Publish the formatting cleanup PR.

## Constraints & Preferences
- Formatting/config only; no behavior changes.

## Progress
### Done
- Oxfmt passes.
### In Progress
- Regression tests.

## Key Decisions
- Keep Oxfmt as the canonical formatter.

## Next Steps
1. Finish targeted tests.
2. Push the PR.

## Critical Context
- Branch chore/format-baseline.`;

  const audit = compactPreviousSummaryForPrompt(prior, "audit", 4_000);
  const execution = compactPreviousSummaryForPrompt(prior, "execution", 4_000);
  assert.match(audit ?? "", /Publish the formatting cleanup PR/);
  assert.match(audit ?? "", /Formatting\/config only/);
  assert.match(audit ?? "", /canonical formatter/);
  assert.doesNotMatch(audit ?? "", /Finish targeted tests/);
  assert.match(execution ?? "", /Oxfmt passes/);
  assert.match(execution ?? "", /Finish targeted tests/);
  assert.match(execution ?? "", /chore\/format-baseline/);
  assert.doesNotMatch(execution ?? "", /canonical formatter/);
});

test("unknown previous summary shape is not replayed wholesale", () => {
  const prior = "## Random Legacy Wrapper\nThis should not become authoritative context.";
  assert.equal(compactPreviousSummaryForPrompt(prior, "audit"), undefined);
  assert.equal(compactPreviousSummaryForPrompt(prior, "execution"), undefined);
});

test("previous audit carry-forward prioritizes contradictions and active obligations over long history", () => {
  const prior = `# Compaction Checkpoint

## Work-State Audit
## Active Obligations
- SERVICE-GETTER remains OPEN.

## Obligation Status
- SERVICE-GETTER — OPEN.

## Decisions That Still Matter
- Approved earlier.

## Contradictions / Unsupported Claims
- COMPLETE is unsupported because SERVICE-GETTER disappeared without completion evidence.

## Do-Not-Repeat Knowledge
${"old-history ".repeat(1800)}

## Important Unknowns
- None

## Execution State
## Done
- unrelated`;
  const carried = compactPreviousSummaryForPrompt(prior, "audit", 2_000);
  assert.match(carried ?? "", /SERVICE-GETTER/);
  assert.match(carried ?? "", /COMPLETE is unsupported/);
  const contradiction = (carried ?? "").indexOf("COMPLETE is unsupported");
  const oldHistory = (carried ?? "").indexOf("old-history");
  assert.ok(oldHistory === -1 || contradiction < oldHistory);
});

test("previous execution carry-forward protects next action from long history", () => {
  const prior = `# Compaction Checkpoint

## Work-State Audit
## Active Obligations
- implementation

## Execution State
## Done
${"old-history ".repeat(1800)}

## Current Code / Repository State
${"current-state ".repeat(400)}

## Adjustments / Discoveries
- Do not retry the failed fallback writer.

## Remaining / Immediate Next Actions
- DELETE-LEGACY-CONSOLIDATION is the immediate next action.
- Then run the focused verification suite.

## Verification State
- tests pending

## Deterministic State
HEAD: fresh`;
  const carried = compactPreviousSummaryForPrompt(prior, "execution", 4_000);
  assert.match(carried ?? "", /DELETE-LEGACY-CONSOLIDATION/);
  assert.match(carried ?? "", /Do not retry the failed fallback writer/);
  const nextActionIndex = (carried ?? "").indexOf("DELETE-LEGACY-CONSOLIDATION");
  const oldHistoryIndex = (carried ?? "").indexOf("old-history");
  assert.ok(oldHistoryIndex === -1 || nextActionIndex < oldHistoryIndex);
  assert.ok((carried?.length ?? 0) <= 4_100);
});

test("target fitting preserves both LLM summaries and balances deterministic categories", () => {
  const usage = emptyUsageForTests();
  const audit: LaneResult = {
    lane: "audit", text: `## Active Obligations\n${"A".repeat(2500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
  };
  const execution: LaneResult = {
    lane: "execution", text: `## Verification State\n${"E".repeat(2500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
  };
  const deterministic: DeterministicState = {
    readFiles: [],
    modifiedFiles: ["a.ts"],
    traceReadFiles: ["r.ts"],
    traceEditedFiles: ["a.ts"],
    userMessages: Array.from({ length: 8 }, (_, i) => ({
      timestamp: i,
      text: `user-${i}-${"u".repeat(500)}`,
      originalChars: 507,
      trimmed: false,
    })),
    git: { root: "/repo", branch: "main", head: "abc", dirty: [" M a.ts"], truncated: false },
  };
  const fitted = fitCheckpointToTarget({
    audit,
    execution,
    deterministic,
    maxRenderBudgets: {
      gitStateChars: 4000,
      editedFilesChars: 6000,
      readFilesChars: 1000,
      userMessagesChars: 16000,
      userArtifactReferencesChars: 0,
    },
    isSplitTurn: false,
    estimatedRetainedTokens: 6_000,
    targetPostCompactTokens: 9_000,
  });
  assert.ok(fitted.summary.includes(audit.text));
  assert.ok(fitted.summary.includes(execution.text));
  assert.match(fitted.summary, /Git state/);
  assert.match(fitted.summary, /Files edited\/written/);
  assert.match(fitted.summary, /Cumulative compacted user-message ledger/);
  assert.equal(fitted.targetExceeded, false);
  assert.ok(fitted.estimatedTokensAfter <= 9_000);
});

test("40k target collapses a roughly 150k-token tool-heavy turn without clipping lane summaries", () => {
  const entries: unknown[] = [
    messageEntry("u1", user("older request")),
    messageEntry("a1", assistant("older answer")),
    messageEntry("u2", user("perform the long implementation")),
  ];
  for (let i = 0; i < 15; i++) {
    entries.push({
      type: "message",
      id: `tool-call-${i}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        ...assistant(""),
        content: [{ type: "toolCall", id: `tc-long-${i}`, name: "read", arguments: { path: `src/f${i}.ts` } }],
      },
    });
    entries.push({
      type: "message",
      id: `tool-result-${i}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: `tc-long-${i}`,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(40_000) }],
        isError: false,
        timestamp: Date.now(),
      },
    });
  }

  const boundary = prepareWholeTurnCompaction(compactionEvent(entries, 20_000, "tool-call-14"), 20_000);
  assert.equal(boundary.boundaryMode, "split-turn");
  assert.ok(boundary.estimatedRetainedTokens <= 20_000);

  const usage = emptyUsageForTests();
  const audit: LaneResult = {
    lane: "audit", text: `## Active Obligations\n${"A".repeat(5_500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
  };
  const execution: LaneResult = {
    lane: "execution", text: `## Verification State\n${"E".repeat(5_500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
  };
  const deterministic: DeterministicState = {
    readFiles: [],
    modifiedFiles: ["src/f14.ts"],
    traceReadFiles: ["src/f14.ts", "src/f13.ts"],
    traceEditedFiles: ["src/changed.ts"],
    userMessages: Array.from({ length: 12 }, (_, i) => ({
      timestamp: i,
      text: `request-${i}-${"u".repeat(400)}`,
      originalChars: 412,
      trimmed: false,
    })),
    git: { root: "/repo", branch: "main", head: "abcdef123456", dirty: [" M src/changed.ts"], truncated: false },
  };
  const fitted = fitCheckpointToTarget({
    audit,
    execution,
    deterministic,
    maxRenderBudgets: {
      gitStateChars: 4_000,
      editedFilesChars: 6_000,
      readFilesChars: 1_000,
      userMessagesChars: 16_000,
      userArtifactReferencesChars: 0,
    },
    isSplitTurn: boundary.isSplitTurn,
    estimatedRetainedTokens: boundary.estimatedRetainedTokens,
    targetPostCompactTokens: 40_000,
  });
  assert.ok(fitted.summary.includes(audit.text));
  assert.ok(fitted.summary.includes(execution.text));
  assert.ok(fitted.estimatedTokensAfter <= 40_000);
  assert.equal(fitted.targetExceeded, false);
});

test("missing continuation heading is deterministically recovered from remaining actions", () => {
  const usage = emptyUsageForTests();
  const protectedResult = protectLaneAnchor({
    lane: "execution",
    text: "## Done\n- lots of history\n\n## Remaining / Immediate Next Actions\n- Resume run run-123 and verify lifecycle transition.",
    usage,
    model: "p/m",
    thinkingLevel: "low",
    durationMs: 1,
  }, "execution");
  assert.match(protectedResult.text, /^## Continuation Anchor\n- Resume run run-123/m);
});

test("audit lane does not invent a continuation anchor", () => {
  const usage = emptyUsageForTests();
  const result = protectLaneAnchor({
    lane: "audit",
    text: "## Active Obligations\n- verification remains OPEN",
    usage,
    model: "p/m",
    thinkingLevel: "low",
    durationMs: 1,
  }, "audit");
  assert.doesNotMatch(result.text, /Continuation Anchor/);
});

test("model references allow slashes only after provider delimiter", () => {
  assert.deepEqual(parseModelReference("opencode-go/muse-spark-1.2-contributor"), {
    provider: "opencode-go",
    modelId: "muse-spark-1.2-contributor",
  });
  assert.equal(parseModelReference("broken"), undefined);
});
