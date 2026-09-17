import assert from "node:assert/strict";
import test from "node:test";

import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { emptyUsageForTests } from "../src/core.js";
import { prepareWholeTurnCompactionWithUnderfillRecovery } from "../src/retention.js";

type CompactionInput = Pick<SessionBeforeCompactEvent, "preparation" | "branchEntries">;
type CompactionMessage = Extract<CompactionInput["branchEntries"][number], { type: "message" }>["message"];

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

function messageEntry(id: string, message: CompactionMessage) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

function toolCallEntry(id: string, toolCallId: string, path: string) {
  return messageEntry(id, {
    ...assistant(""),
    content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path } }],
  });
}

function toolResultEntry(id: string, toolCallId: string, chars: number) {
  return messageEntry(id, {
    role: "toolResult" as const,
    toolCallId,
    toolName: "read",
    content: [{ type: "text" as const, text: "x".repeat(chars) }],
    isError: false,
    timestamp: Date.now(),
  });
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
    toolCallEntry("tool-call", "tc1", "large.log"),
    toolResultEntry("tool-result", "tc1", 140_000),
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

test("whole-turn underfill splits the preceding oversized turn instead of retaining only tiny new turns", () => {
  const branchEntries: CompactionInput["branchEntries"] = [
    messageEntry("old-user", user("older request")),
    messageEntry("old-assistant", assistant("older response")),
    messageEntry("giant-user", user("investigate the build failure thoroughly")),
    toolCallEntry("tool-call-a", "tc-a", "first-large.log"),
    toolResultEntry("tool-result-a", "tc-a", 60_000),
    toolCallEntry("tool-call-b", "tc-b", "second-large.log"),
    toolResultEntry("tool-result-b", "tc-b", 60_000),
    messageEntry("giant-final", assistant("The investigation is complete and the clean upgrade path is preferred.")),
    messageEntry("decision-user", user("I decided on the upgrade; split the work into three PRs and create a plan.")),
    messageEntry("decision-assistant", assistant("Understood.")),
    messageEntry("dot-user", user(".")),
    messageEntry("final", assistant("Continuing with the plan.")),
  ];

  const result = prepareWholeTurnCompactionWithUnderfillRecovery(
    compactionEvent(branchEntries, 20_000),
    20_000,
    40_000,
  );

  assert.equal(result.boundaryMode, "split-turn");
  assert.ok(result.estimatedRetainedTokens >= 10_000, result.estimatedRetainedTokens.toString());
  assert.ok(result.estimatedRetainedTokens <= 40_000, result.estimatedRetainedTokens.toString());
  assert.notEqual(result.firstKeptEntryId, "decision-user");
  assert.notEqual(result.firstKeptEntryId, "dot-user");
});

test("underfill recovery still refuses a raw suffix above the post-compact ceiling", () => {
  const branchEntries: CompactionInput["branchEntries"] = [
    messageEntry("old-user", user("older request")),
    messageEntry("old-assistant", assistant("older response")),
    messageEntry("recent-user", user("inspect the enormous result")),
    toolCallEntry("tool-call", "tc1", "enormous.log"),
    toolResultEntry("tool-result", "tc1", 240_000),
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
