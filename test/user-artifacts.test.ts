import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backfillUserArtifacts,
  loadUserArtifactCatalog,
  loadUserArtifactManifest,
  maxUserArtifactOrdinal,
  previousUserArtifactState,
  readCatalogUserArtifact,
  readUserArtifact,
  reconcileDurableUserReferences,
  renderArtifactCandidates,
  renderDurableUserReferences,
  resolveLegacyArtifactProvenance,
  resolveUserArtifactSessionSources,
  searchUserArtifactCatalog,
  searchUserArtifacts,
  storeUserArtifact,
  userArtifactHashes,
  userArtifactIdsOnBranch,
  userArtifactRecordsOnBranch,
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
    llmText: "- U0001 | kind=plan | authority=governing | note=original implementation plan",
  });
  assert.equal(active[0]?.state, "active");
  assert.equal(active[0]?.misses, 0);
  assert.equal(active[0]?.kind, "plan");
  assert.equal(active[0]?.authority, "governing");
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

test("governing sources render a read-before-work checkpoint while supporting sources remain on-demand", () => {
  const artifacts: UserArtifactRecord[] = [
    { id: "U0001", sha256: "1".repeat(64), timestamp: 1, chars: 9_000, preview: "Implementation plan", file: "U0001.md", sourceSessionId: "parent" },
    { id: "U0002", sha256: "2".repeat(64), timestamp: 2, chars: 10_000, preview: "Runtime log", file: "U0002.md", sourceSessionId: "parent" },
  ];
  const text = renderDurableUserReferences({
    artifacts,
    references: [
      { id: "U0001", sourceSessionId: "parent", state: "active", misses: 0, kind: "plan", authority: "governing", semanticNote: "current implementation plan" },
      { id: "U0002", sourceSessionId: "parent", state: "active", misses: 0, kind: "log", authority: "supporting", semanticNote: "diagnostic log" },
    ],
    maxChars: 4_000,
  });
  assert.match(text, /Governing exact user sources/);
  assert.match(text, /READ BEFORE GOVERNED WORK/);
  assert.match(text, /checkpoint summary is not a substitute/i);
  assert.match(text, /U0001 \[active, plan, governing\]/);
  assert.match(text, /Recoverable oversized user sources/);
  assert.match(text, /U0002 \[active, log, supporting\]/);
});

test("fork lineage exposes exact parent artifacts without copying them into the child manifest", async () => {
  await withAgentDir(async (agentDir) => {
    const sessions = path.join(agentDir, "sessions");
    await mkdir(sessions, { recursive: true });
    const parentFile = path.join(sessions, "parent.jsonl");
    const childFile = path.join(sessions, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: new Date().toISOString(), cwd: "/repo" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: "/repo", parentSession: parentFile })}\n`, "utf8");

    const plan = `PARENT PLAN\n${"p".repeat(8_500)}`;
    await storeUserArtifact({ sessionId: "parent-session", text: plan, timestamp: 1, thresholdChars: 8_000, previewChars: 120 });
    const sources = await resolveUserArtifactSessionSources({
      currentSessionId: "child-session",
      currentSessionFile: childFile,
      parentSession: parentFile,
    });
    assert.deepEqual(sources.map(({ sessionId, inherited }) => ({ sessionId, inherited })), [
      { sessionId: "child-session", inherited: false },
      { sessionId: "parent-session", inherited: true },
    ]);

    const catalog = await loadUserArtifactCatalog(sources);
    const branch = [userEntry("u1", plan, 1)];
    const visible = userArtifactRecordsOnBranch(catalog, branch as never);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.id, "U0001");
    assert.equal(visible[0]?.sourceSessionId, "parent-session");
    assert.equal(visible[0]?.inherited, true);
    const exact = await readCatalogUserArtifact(visible[0]!);
    assert.equal(exact?.text, plan);
    assert.equal((await loadUserArtifactManifest("child-session")).artifacts.length, 0);
  });
});



test("catalog search is newest-first across visible lineage", async () => {
  await withAgentDir(async () => {
    const older = `MATCHING OLDER PLAN\n${"o".repeat(8_500)}`;
    const newer = `MATCHING NEWER PLAN\n${"n".repeat(8_500)}`;
    await storeUserArtifact({ sessionId: "parent", text: older, timestamp: 100, thresholdChars: 8_000, previewChars: 120 });
    await storeUserArtifact({ sessionId: "child", text: newer, timestamp: 200, thresholdChars: 8_000, previewChars: 120 });
    const catalog = await loadUserArtifactCatalog([
      { sessionId: "child", inherited: false },
      { sessionId: "parent", inherited: true },
    ]);
    const matches = await searchUserArtifactCatalog(catalog, "MATCHING", 20);
    assert.deepEqual(matches.map((record) => record.sourceSessionId), ["child", "parent"]);
  });
});

test("LLM classification may omit provenance only when the U id is unambiguous", () => {
  const unique: UserArtifactRecord = {
    id: "U0009",
    sha256: "9".repeat(64),
    timestamp: 1,
    chars: 9_000,
    preview: "governing plan",
    file: "U0009.md",
    sourceSessionId: "parent",
  };
  const accepted = reconcileDurableUserReferences({
    candidates: [unique],
    previous: [],
    llmText: "- U0009 | kind=plan | authority=governing | note=current plan",
  });
  assert.equal(accepted[0]?.authority, "governing");
  assert.equal(accepted[0]?.sourceSessionId, "parent");

  const ambiguous: UserArtifactRecord[] = [
    unique,
    { ...unique, sha256: "8".repeat(64), sourceSessionId: "child" },
  ];
  const rejected = reconcileDurableUserReferences({
    candidates: ambiguous,
    previous: [],
    llmText: "- U0009 | kind=plan | authority=governing | note=ambiguous",
  });
  assert.deepEqual(rejected.map(({ sourceSessionId, state, authority }) => ({ sourceSessionId, state, authority })), [
    { sourceSessionId: "parent", state: "cooling", authority: undefined },
    { sourceSessionId: "child", state: "cooling", authority: undefined },
  ]);

  const explicit = reconcileDurableUserReferences({
    candidates: ambiguous,
    previous: [],
    llmText: "- U0009 | sourceSessionId=parent | kind=plan | authority=governing | note=parent plan",
  });
  assert.deepEqual(explicit.map(({ sourceSessionId, state, authority }) => ({ sourceSessionId, state, authority })), [
    { sourceSessionId: "parent", state: "active", authority: "governing" },
    { sourceSessionId: "child", state: "cooling", authority: undefined },
  ]);
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


test("fork-local artifacts allocate above inherited ids and do not duplicate inherited exact text", async () => {
  await withAgentDir(async (agentDir) => {
    const sessions = path.join(agentDir, "sessions");
    await mkdir(sessions, { recursive: true });
    const parentFile = path.join(sessions, "parent.jsonl");
    const childFile = path.join(sessions, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: new Date().toISOString(), cwd: "/repo" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: "/repo", parentSession: parentFile })}\n`, "utf8");

    const parentPlan = `PARENT PLAN\n${"p".repeat(8_500)}`;
    const childPlan = `CHILD PLAN\n${"c".repeat(8_500)}`;
    await storeUserArtifact({ sessionId: "parent-session", text: parentPlan, timestamp: 1, thresholdChars: 8_000, previewChars: 120 });
    const sources = await resolveUserArtifactSessionSources({ currentSessionId: "child-session", currentSessionFile: childFile, parentSession: parentFile });
    const inherited = await loadUserArtifactCatalog(sources.slice(1));
    await backfillUserArtifacts({
      sessionId: "child-session",
      branchEntries: [userEntry("u1", parentPlan, 1), userEntry("u2", childPlan, 2)] as never,
      thresholdChars: 8_000,
      previewChars: 120,
      skipSha256: userArtifactHashes(inherited),
      minNextId: maxUserArtifactOrdinal(inherited) + 1,
    });
    const childManifest = await loadUserArtifactManifest("child-session");
    assert.deepEqual(childManifest.artifacts.map(({ id, preview }) => ({ id, preview: preview.slice(0, 10) })), [
      { id: "U0002", preview: "CHILD PLAN" },
    ]);
  });
});

test("v5 compaction details preserve provenance and governing classification", () => {
  const entries = [{
    type: "compaction" as const,
    id: "c5",
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "checkpoint",
    firstKeptEntryId: "u2",
    tokensBefore: 100,
    details: {
      plugin: "pi-one-round-compaction",
      version: 5,
      knownUserArtifactIds: ["U0006"],
      knownUserArtifacts: [{ id: "U0006", sourceSessionId: "parent-session" }],
      durableUserReferences: [{
        id: "U0006",
        sourceSessionId: "parent-session",
        state: "active",
        misses: 0,
        kind: "plan",
        authority: "governing",
        semanticNote: "canonical preparation plan",
      }],
    },
  }];
  const state = previousUserArtifactState(entries as never);
  assert.deepEqual(state.knownArtifacts, [{ id: "U0006", sourceSessionId: "parent-session" }]);
  assert.deepEqual(state.references, [{
    id: "U0006",
    sourceSessionId: "parent-session",
    state: "active",
    misses: 0,
    kind: "plan",
    authority: "governing",
    semanticNote: "canonical preparation plan",
  }]);
});

test("v4 provenance migration ignores same-id child artifacts created after the checkpoint", () => {
  const migrated = resolveLegacyArtifactProvenance({
    artifacts: [
      { id: "U0001", sha256: "c".repeat(64), timestamp: 200, chars: 9_000, preview: "child", file: "child.md", sourceSessionId: "child-session" },
      { id: "U0001", sha256: "p".repeat(64), timestamp: 100, chars: 9_000, preview: "parent", file: "parent.md", sourceSessionId: "parent-session" },
    ],
    references: [{ id: "U0001", state: "active", misses: 0, semanticNote: "legacy plan" }],
    knownArtifacts: [{ id: "U0001" }],
    knownIds: ["U0001"],
    checkpointTimestamp: 150,
  });
  assert.equal(migrated.references[0]?.sourceSessionId, "parent-session");
  assert.equal(migrated.knownArtifacts[0]?.sourceSessionId, "parent-session");
});
