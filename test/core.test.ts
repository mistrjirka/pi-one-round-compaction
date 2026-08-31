import assert from "node:assert/strict";
import test from "node:test";

import {
  collectFileState,
  deterministicMerge,
  emptyUsageForTests,
  extractRecentUserContext,
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

test("whole-turn retention keeps an oversized newest turn intact when older history can still be compacted", () => {
  const entries = [
    messageEntry("u1", user("old request")),
    messageEntry("a1", assistant("old response")),
    messageEntry("u2", user(`huge-${"x".repeat(399)}`)),
    messageEntry("a2", assistant(`huge-${"x".repeat(399)}`)),
  ];
  const result = prepareWholeTurnCompaction(compactionEvent(entries, 50, "a2"));
  assert.equal(result.boundaryMode, "whole-turn");
  assert.equal(result.firstKeptEntryId, "u2");
  assert.equal(result.retainedTurns, 1);
  assert.ok(result.estimatedRetainedTokens > 50);
  assert.equal(result.isSplitTurn, false);
});

test("single-turn pathological case falls back to Pi's split boundary so compaction can make progress", () => {
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
  assert.equal(result.boundaryMode, "pi-fallback");
  assert.equal(result.firstKeptEntryId, "a1");
  assert.equal(result.isSplitTurn, true);
  assert.equal(result.messagesToSummarize.length, 1);
});

test("file state scans the actual discarded messages when our boundary differs from Pi's", () => {
  const toolMessage = {
    ...assistant(""),
    content: [
      { type: "toolCall" as const, id: "tc1", name: "edit", arguments: { path: "extra-prefix.ts" } },
    ],
  };
  const preparation = {
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  };
  const result = collectFileState({ preparation, branchEntries: [] } as never, [toolMessage] as never);
  assert.deepEqual(result.modifiedFiles, ["extra-prefix.ts"]);
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
    recentUserContext: ["Do not touch UI"],
    readFiles: [],
    modifiedFiles: ["api/a.ts"],
  };
  const text = deterministicMerge({ intent, execution, deterministic, isSplitTurn: false });
  assert.match(text, /# Compaction Checkpoint/);
  assert.match(text, /## Task Semantics/);
  assert.match(text, /## Execution State/);
  assert.match(text, /Do not touch UI/);
  assert.match(text, /api\/a\.ts/);
});

test("model references allow slashes only after provider delimiter", () => {
  assert.deepEqual(parseModelReference("opencode-go/muse-spark-1.2-contributor"), {
    provider: "opencode-go",
    modelId: "muse-spark-1.2-contributor",
  });
  assert.equal(parseModelReference("broken"), undefined);
});
