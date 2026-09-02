import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  activateIntentWorkflowForSession,
  detectIntentWorkflow,
  extractIntentContract,
  shouldCarryPreviousCheckpointForIntent,
} from "../src/intent-workflow.js";

const execFileAsync = promisify(execFile);

function projectKey(root: string): string {
  const slug = path.basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

async function makeRepo(prefix: string): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  return realpath(repo);
}

test("autodetect stays off when the project has no active intent ledger", async () => {
  const repo = await makeRepo("pi-intent-off-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-off-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const result = await detectIntentWorkflow(repo);
    assert.deepEqual(result, { active: false, reason: "no-active-ledger" });
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("autodetect activates only a valid current ledger for the exact project", async () => {
  const repo = await makeRepo("pi-intent-on-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-on-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "strict-tools-qdrant");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "strict-tools-qdrant"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), `# Current intent

Implement strict AI review tools and Qdrant indexes.

# Navigation context

- Active branch: fix/strict-review-tools-qdrant-indexes
- Explicitly excluded neighboring systems or paths.

# Direct user quotes

- 2026-08-31 UTC — “Do not change Review Agents UI.”

# Interpretation corrections

- Add only when a prior interpretation materially affected ownership, scope, architecture, safety, or validation.

# Accepted behavior

- Every emitted AI Review function tool uses strict provider schemas.

# Hard constraints

- No paid LLM calls.

# Boundaries

- Review Agents UI is excluded.

# Accepted decisions

- Verify payload indexes before alias activation.

# Acceptance checks

- [ ] Focused schema tests pass.

# Open questions

- None.

# Evolution history

## 2026-08-30 UTC

- Old lifecycle investigation that should not enter compaction.
`);
    await writeFile(path.join(intentDir, "plan.md"), "1. Strict tools\n2. Qdrant indexes\n3. Validation\n");

    const result = await detectIntentWorkflow(repo);
    assert.equal(result.active, true);
    if (!result.active) return;
    assert.equal(result.workstream, "strict-tools-qdrant");
    assert.equal(result.generation, 1);
    assert.match(result.intentContract, /Implement strict AI review tools/);
    assert.match(result.intentContract, /Do not change Review Agents UI/);
    assert.match(result.intentContract, /Verify payload indexes before alias activation/);
    assert.doesNotMatch(result.intentContract, /Old lifecycle investigation/);
    assert.doesNotMatch(result.intentContract, /Explicitly excluded neighboring systems or paths\./);
    assert.match(result.plan ?? "", /Qdrant indexes/);

    const staleForThisSession = activateIntentWorkflowForSession(
      result,
      [],
      result.lastTouchedAtMs + 10_000,
    );
    assert.deepEqual(staleForThisSession, { active: false, reason: "not-used-in-session" });

    const continuedAfterPriorCompaction = activateIntentWorkflowForSession(
      result,
      [{
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: "prior",
        firstKeptEntryId: "x",
        tokensBefore: 1,
        details: {
          plugin: "pi-one-round-compaction",
          intentWorkflow: { active: true, workstream: "strict-tools-qdrant" },
        },
      }] as never,
      result.lastTouchedAtMs + 10_000,
    );
    assert.equal(continuedAfterPriorCompaction.active, true);
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("a filesystem touch alone never binds the project-global current workstream to this session", async () => {
  const repo = await makeRepo("pi-intent-mtime-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-mtime-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "other-session-task");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "other-session-task"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nWork selected by another concurrent session.\n");

    const detected = await detectIntentWorkflow(repo);
    assert.equal(detected.active, true);
    if (!detected.active) return;
    const activated = activateIntentWorkflowForSession(detected, [], detected.lastTouchedAtMs - 10_000);
    assert.deepEqual(activated, { active: false, reason: "not-used-in-session" });
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("newest workflow checkpoint wins over an older matching workstream", async () => {
  const repo = await makeRepo("pi-intent-newest-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-newest-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "issue-993");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "issue-993"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nIssue 993.\n");
    const detected = await detectIntentWorkflow(repo);
    assert.equal(detected.active, true);
    if (!detected.active) return;
    const entries = [
      {
        type: "compaction", id: "old", parentId: null, timestamp: new Date().toISOString(), summary: "old",
        firstKeptEntryId: "x", tokensBefore: 1,
        details: { plugin: "pi-one-round-compaction", intentWorkflow: { active: true, workstream: "issue-993", generation: 1 } },
      },
      {
        type: "compaction", id: "new", parentId: null, timestamp: new Date().toISOString(), summary: "new",
        firstKeptEntryId: "y", tokensBefore: 1,
        details: { plugin: "pi-one-round-compaction", intentWorkflow: { active: true, workstream: "different-task", generation: 1 } },
      },
    ] as never;
    assert.deepEqual(
      activateIntentWorkflowForSession(detected, entries, 0),
      { active: false, reason: "not-used-in-session" },
    );
    assert.equal(shouldCarryPreviousCheckpointForIntent(entries, { active: false, reason: "not-used-in-session" }), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("normal previous checkpoints still carry when no intent workflow is active", () => {
  const entries = [{
    type: "compaction", id: "normal", parentId: null, timestamp: new Date().toISOString(), summary: "normal",
    firstKeptEntryId: "x", tokensBefore: 1,
    details: { plugin: "pi-one-round-compaction", intentWorkflow: { active: false } },
  }] as never;
  assert.equal(shouldCarryPreviousCheckpointForIntent(entries, { active: false, reason: "no-active-ledger" }), true);
});

test("pending reconciliation suppresses the old durable contract and previous checkpoint generation", async () => {
  const repo = await makeRepo("pi-intent-pending-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-pending-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "issue-993-summary");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "issue-993-summary"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nOld contract that must not be injected while reconciling.\n");
    await writeFile(path.join(intentDir, "intent-state.json"), JSON.stringify({
      schemaVersion: 1,
      status: "pending_reconciliation",
      generation: 2,
    }));

    const pending = await detectIntentWorkflow(repo);
    assert.deepEqual(pending, {
      active: false,
      reason: "pending-reconciliation",
      workstream: "issue-993-summary",
      generation: 2,
      intentPath: path.join(intentDir, "intent.md"),
    });
    assert.equal(shouldCarryPreviousCheckpointForIntent([], pending), false);

    await writeFile(path.join(intentDir, "intent-state.json"), JSON.stringify({
      schemaVersion: 1,
      status: "active",
      generation: 2,
    }));
    const active = await detectIntentWorkflow(repo);
    assert.equal(active.active, true);
    if (!active.active) return;
    assert.equal(active.generation, 2);

    const oldGenerationEntry = [{
      type: "compaction",
      id: "c-old",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "old generation checkpoint",
      firstKeptEntryId: "x",
      tokensBefore: 1,
      details: {
        plugin: "pi-one-round-compaction",
        intentWorkflow: { active: true, workstream: "issue-993-summary", generation: 1 },
      },
    }] as never;
    assert.equal(shouldCarryPreviousCheckpointForIntent(oldGenerationEntry, active), false);
    const staleActivation = activateIntentWorkflowForSession(active, oldGenerationEntry, active.lastTouchedAtMs + 10_000);
    assert.deepEqual(staleActivation, { active: false, reason: "not-used-in-session" });

    const currentGenerationEntry = [{
      type: "compaction",
      id: "c-new",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "generation 2 checkpoint",
      firstKeptEntryId: "x",
      tokensBefore: 1,
      details: {
        plugin: "pi-one-round-compaction",
        intentWorkflow: { active: true, workstream: "issue-993-summary", generation: 2 },
      },
    }] as never;
    assert.equal(shouldCarryPreviousCheckpointForIntent(currentGenerationEntry, active), true);
    assert.equal(activateIntentWorkflowForSession(active, currentGenerationEntry, active.lastTouchedAtMs + 10_000).active, true);
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("a stale project-root binding is not treated as active intent", async () => {
  const repo = await makeRepo("pi-intent-stale-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-stale-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "stale");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), "/definitely/not/this/project\n");
    await symlink(path.join("intents", "stale"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nWrong project\n");

    const result = await detectIntentWorkflow(repo);
    assert.deepEqual(result, { active: false, reason: "stale-project-root" });
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("intent contract requires a current intent and excludes evolution history", () => {
  assert.equal(extractIntentContract("# Evolution history\n\nold"), undefined);
  const extracted = extractIntentContract("# Current intent\n\nNow\n\n# Evolution history\n\nOld transcript");
  assert.ok(extracted);
  assert.match(extracted.text, /# Current intent/);
  assert.doesNotMatch(extracted.text, /Old transcript/);
});
