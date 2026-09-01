import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backfillUserArtifacts,
  loadUserArtifactManifest,
  previousUserArtifactState,
  readUserArtifact,
  reconcileDurableUserReferences,
  renderArtifactCandidates,
  searchUserArtifacts,
  storeUserArtifact,
  userArtifactIdsOnBranch,
  type UserArtifactRecord,
} from "../src/user-artifacts.js";

function userEntry(id: string, text: string, timestamp: number) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user" as const, content: text, timestamp },
  };
}

async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-artifacts-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn(agentDir);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

test("oversized human messages are stored exactly and deduplicated per session", async () => {
  await withAgentDir(async () => {
    const text = `  Original implementation plan\n${"x".repeat(9_000)}\n  `;
    const first = await storeUserArtifact({
      sessionId: "s1",
      text,
      timestamp: 10,
      thresholdChars: 8_000,
      previewChars: 120,
    });
    const duplicate = await storeUserArtifact({
      sessionId: "s1",
      text,
      timestamp: 20,
      thresholdChars: 8_000,
      previewChars: 120,
    });
    assert.equal(first?.id, "U0001");
    assert.equal(duplicate?.id, "U0001");
    const manifest = await loadUserArtifactManifest("s1");
    assert.equal(manifest.artifacts.length, 1);
    const recovered = await readUserArtifact("s1", "U0001");
    assert.equal(recovered?.text, text);
    assert.equal(recovered?.record.chars, text.length);
    assert.match(recovered?.record.preview ?? "", /^Original implementation plan/);
  });
});

test("artifact backfill and branch membership only use native human user messages", async () => {
  await withAgentDir(async () => {
    const plan = `PLAN-A\n${"a".repeat(8_500)}`;
    const other = `PLAN-B\n${"b".repeat(8_500)}`;
    const branch = [
      userEntry("u1", plan, 1),
      {
        type: "custom_message" as const,
        id: "custom",
        parentId: "u1",
        timestamp: new Date(2).toISOString(),
        customType: "pi-subagents",
        content: `Background task completed: ${"z".repeat(9_000)}`,
        display: true,
      },
    ];
    await backfillUserArtifacts({
      sessionId: "s2",
      branchEntries: branch as never,
      thresholdChars: 8_000,
      previewChars: 100,
    });
    await storeUserArtifact({
      sessionId: "s2",
      text: other,
      timestamp: 3,
      thresholdChars: 8_000,
      previewChars: 100,
    });
    const manifest = await loadUserArtifactManifest("s2");
    assert.equal(manifest.artifacts.length, 2);
    assert.deepEqual(userArtifactIdsOnBranch(manifest.artifacts, branch as never), ["U0001"]);
    const scoped = await searchUserArtifacts("s2", "PLAN", 20, new Set(["U0001"]));
    assert.deepEqual(scoped.map((record) => record.id), ["U0001"]);
  });
});

test("LLM references survive one omission, archive on the second, and can be revived", () => {
  const artifact: UserArtifactRecord = {
    id: "U0001",
    sha256: "a".repeat(64),
    timestamp: 1,
    chars: 50_000,
    preview: "Original RabbitMQ implementation plan",
    file: "U0001-a.md",
  };

  const active = reconcileDurableUserReferences({
    candidates: [artifact],
    previous: [],
    llmText: "- U0001 — original implementation plan; exact wording: user_artifact read U0001",
  });
  assert.equal(active[0]?.state, "active");
  assert.equal(active[0]?.misses, 0);
  assert.match(active[0]?.semanticNote ?? "", /implementation plan/);

  const cooling = reconcileDurableUserReferences({ candidates: [artifact], previous: active, llmText: "No relevant durable source." });
  assert.deepEqual(cooling.map(({ id, state, misses }) => ({ id, state, misses })), [
    { id: "U0001", state: "cooling", misses: 1 },
  ]);

  const archived = reconcileDurableUserReferences({ candidates: [artifact], previous: cooling, llmText: "Still irrelevant." });
  assert.deepEqual(archived, []);

  const revived = reconcileDurableUserReferences({
    candidates: [artifact],
    previous: [],
    llmText: "- U0001 — the user returned to the original plan; retrieve with user_artifact",
  });
  assert.equal(revived[0]?.state, "active");
});

test("candidate rendering gives the LLM semantic lifecycle instructions and retrieval contract", () => {
  const artifact: UserArtifactRecord = {
    id: "U0007",
    sha256: "7".repeat(64),
    timestamp: 7,
    chars: 26_141,
    preview: "Fix final RabbitMQ / Verification Review correctness gaps",
    file: "U0007.md",
  };
  const text = renderArtifactCandidates({ artifacts: [artifact], previous: [], maxChars: 4_000 });
  assert.match(text, /Semantically decide/);
  assert.match(text, /U0007/);
  assert.match(text, /user_artifact/);
  assert.match(text, /two consecutive compactions/);
});

test("v4 compaction details persist branch-local artifact lifecycle across compactions", () => {
  const entries = [{
    type: "compaction" as const,
    id: "c1",
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "checkpoint",
    firstKeptEntryId: "u2",
    tokensBefore: 100,
    details: {
      plugin: "pi-one-round-compaction",
      version: 4,
      knownUserArtifactIds: ["U0001", "U0002"],
      durableUserReferences: [
        { id: "U0001", state: "active", misses: 0, semanticNote: "plan" },
        { id: "U0002", state: "cooling", misses: 1 },
      ],
    },
  }];
  const state = previousUserArtifactState(entries as never);
  assert.deepEqual(state.knownIds, ["U0001", "U0002"]);
  assert.deepEqual(state.references.map(({ id, state: status, misses }) => ({ id, status, misses })), [
    { id: "U0001", status: "active", misses: 0 },
    { id: "U0002", status: "cooling", misses: 1 },
  ]);
});
