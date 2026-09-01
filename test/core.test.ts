import assert from "node:assert/strict";
import test from "node:test";

import {
  collectFileState,
  collectUserMessageLedger,
  compactPreviousSummaryForPrompt,
  computeEffectiveRecentTokenBudget,
  deterministicMerge,
  emptyUsageForTests,
  extractRecentUserContext,
  fitCheckpointToTarget,
  parseModelReference,
  prepareWholeTurnCompaction,
  serializeExecutionView,
  serializeIntentView,
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

test("intent view omits tool results and keeps user semantics", () => {
  const messages = [
    user("Implement the accepted plan, but do not change UI."),
    assistant("I will inspect the backend."),
    {
      role: "toolResult" as const,
      toolCallId: "1",
      toolName: "read",
      content: [{ type: "text" as const, text: "huge implementation detail" }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  const text = serializeIntentView(messages);
  assert.match(text, /Implement the accepted plan/);
  assert.doesNotMatch(text, /huge implementation detail/);
});

test("intent view excludes synthetic extension messages even though Pi maps them to LLM user role", () => {
  const messages = [
    user("real user requirement"),
    {
      role: "custom" as const,
      customType: "pi-subagents",
      content: "Background task completed: synthetic status",
      display: true,
      timestamp: Date.now(),
    },
    assistant("working"),
  ];
  const text = serializeIntentView(messages as never);
  assert.match(text, /real user requirement/);
  assert.doesNotMatch(text, /Background task completed/);
});

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
  const intent: LaneResult = {
    lane: "intent",
    text: "## Current Objective\nShip strict tools",
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
    intent,
    execution,
    deterministic,
    renderBudgets: {
      intentWorkflowChars: 0,
      gitStateChars: 0,
      editedFilesChars: 2000,
      readFilesChars: 0,
      userMessagesChars: 2000,
      userArtifactReferencesChars: 0,
    },
    isSplitTurn: false,
  });
  assert.match(text, /# Compaction Checkpoint/);
  assert.match(text, /## Task Semantics/);
  assert.match(text, /## Execution State/);
  assert.match(text, /Do not touch UI/);
  assert.match(text, /api\/a\.ts/);
});

test("post-compaction target reserves room for summaries and deterministic categories", () => {
  assert.equal(computeEffectiveRecentTokenBudget({
    targetPostCompactTokens: 40_000,
    keepRecentTokens: 32_000,
    laneOutputReserveTokens: 9_216,
    deterministicReserveChars: 35_000,
  }), 21_034);
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

test("previous checkpoint prompt carry-forward drops stale deterministic copies", () => {
  const prior = `# Compaction Checkpoint

## Durable Intent Workflow
old git-like durable state

## Implementation State
## Done
- useful prior implementation

## Verification / Evidence State
## Verification State
- tests pass

## Deterministic Repository / User State
HEAD: stale
user: stale`;
  const implementation = compactPreviousSummaryForPrompt(prior, "intent", true);
  const evidence = compactPreviousSummaryForPrompt(prior, "execution", true);
  assert.match(implementation ?? "", /useful prior implementation/);
  assert.doesNotMatch(implementation ?? "", /tests pass/);
  assert.match(evidence ?? "", /tests pass/);
  assert.doesNotMatch(evidence ?? "", /useful prior implementation/);
  assert.doesNotMatch(implementation ?? "", /old git-like durable state/);
  assert.doesNotMatch(evidence ?? "", /HEAD: stale/);
});

test("target fitting preserves both LLM summaries and balances deterministic categories", () => {
  const usage = emptyUsageForTests();
  const intent: LaneResult = {
    lane: "intent", text: `## Done\n${"I".repeat(2500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
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
    intent,
    execution,
    deterministic,
    maxRenderBudgets: {
      intentWorkflowChars: 0,
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
  assert.ok(fitted.summary.includes(intent.text));
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
  const intent: LaneResult = {
    lane: "intent", text: `## Done\n${"I".repeat(5_500)}`, usage, model: "p/m", thinkingLevel: "low", durationMs: 1,
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
    intent,
    execution,
    deterministic,
    maxRenderBudgets: {
      intentWorkflowChars: 0,
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
  assert.ok(fitted.summary.includes(intent.text));
  assert.ok(fitted.summary.includes(execution.text));
  assert.ok(fitted.estimatedTokensAfter <= 40_000);
  assert.equal(fitted.targetExceeded, false);
});

test("model references allow slashes only after provider delimiter", () => {
  assert.deepEqual(parseModelReference("opencode-go/muse-spark-1.2-contributor"), {
    provider: "opencode-go",
    modelId: "muse-spark-1.2-contributor",
  });
  assert.equal(parseModelReference("broken"), undefined);
});
