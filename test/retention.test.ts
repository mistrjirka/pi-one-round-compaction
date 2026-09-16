import assert from "node:assert/strict";
import test from "node:test";

import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { emptyUsageForTests } from "../src/core.js";
import { prepareWholeTurnCompactionWithUnderfillRecovery } from "../src/retention.js";

type CompactionInput = Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">;

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

function messageEntry(id: string, message: CompactionInput["branchEntries"][number] extends { type: "message"; message: infer M } ? M : never) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

function compactionEvent(branchEntries: CompactionInput["branchEntries"], keepRecentTokens: number): CompactionInput {
  return {
    branchEntries,
    preparation: {
      firstKeptEntryId: "final",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100_000,
      previousSummary: undefined,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens },
    },
  };
}

test("split-turn underfill retries up to the configured post-compact ceiling", () => {
  const branchEntries: CompactionInput["branchEntries"] = [
    messageEntry("old-user", user("older request")),
    messageEntry("old-assistant", assistant("older response")),
    messageEntry("recent-user", user("inspect the large result and tell me what matters")),
    {
      type: "message",
      id: "tool-call",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        ...assistant(""),
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "large.log" } }],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text" as const, text: "x".repeat(140_000) }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    messageEntry("final", assistant(`final answer ${"y".repeat(3_000)}`)),
  ];

  const result = prepareWholeTurnCompactionWithUnderfillRecovery(
    compactionEvent(branchEntries, 32_000),
    23_000,
    40_000,
  );

  assert.ok(result.estimatedRetainedTokens >= 23_000, result.estimatedRetainedTokens.toString());
  assert.ok(result.estimatedRetainedTokens <= 40_000, result.estimatedRetainedTokens.toString());
  assert.notEqual(result.firstKeptEntryId, "final");
});

test("underfill recovery still refuses a raw suffix above the post-compact ceiling", () => {
  const branchEntries: CompactionInput["branchEntries"] = [
    messageEntry("old-user", user("older request")),
    messageEntry("old-assistant", assistant("older response")),
    messageEntry("recent-user", user("inspect the enormous result")),
    {
      type: "message",
      id: "tool-call",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        ...assistant(""),
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "enormous.log" } }],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text" as const, text: "x".repeat(240_000) }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    messageEntry("final", assistant(`final answer ${"y".repeat(3_000)}`)),
  ];

  const result = prepareWholeTurnCompactionWithUnderfillRecovery(
    compactionEvent(branchEntries, 32_000),
    23_000,
    40_000,
  );

  assert.equal(result.firstKeptEntryId, "final");
  assert.ok(result.estimatedRetainedTokens < 23_000 / 2, result.estimatedRetainedTokens.toString());
});
