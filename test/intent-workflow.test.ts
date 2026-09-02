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
  previousSummaryMatchesIntent,
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
        summary: "prior generation-1 checkpoint without an explicit generation marker",
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

test("pending reconciliation is discoverable without an active current pointer", async () => {
  const repo = await makeRepo("pi-intent-pending-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-pending-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "issue-993-review");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "issue-993-review"), path.join(projectWork, "pending"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nOld Lite Review contract\n\n# Hard constraints\n\n- Do not alter backend persistence.\n");
    await writeFile(path.join(intentDir, "state.json"), JSON.stringify({
      version: 1,
      generation: 2,
      status: "pending_reconciliation",
      contractSha256: "old",
      pendingFromContractSha256: "old",
    }));

    const result = await detectIntentWorkflow(repo);
    assert.equal(result.active, false);
    if (result.active || result.reason !== "pending-reconciliation") return;
    assert.equal(result.workstream, "issue-993-review");
    assert.equal(result.generation, 2);
    assert.equal(previousSummaryMatchesIntent(
      "# Compaction Checkpoint\n\n## Durable Intent Workflow\nActive workstream: `issue-993-review`\nIntent generation: 1\n\n# Hard constraints\nDo not alter backend persistence.",
      result,
    ), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("simultaneous current and pending pointers fail closed", async () => {
  const repo = await makeRepo("pi-intent-conflict-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-conflict-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "issue-993-review");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "issue-993-review"), path.join(projectWork, "current"));
    await symlink(path.join("intents", "issue-993-review"), path.join(projectWork, "pending"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nReview\n");
    const result = await detectIntentWorkflow(repo);
    assert.deepEqual(result, { active: false, reason: "invalid-intent-state" });
  } finally {
    if (previous === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = previous;
  }
});

test("previous workflow checkpoint is reused only for the same workstream generation", async () => {
  const repo = await makeRepo("pi-intent-generation-");
  const workHome = await mkdtemp(path.join(os.tmpdir(), "pi-work-generation-"));
  const previous = process.env.PI_WORK_HOME;
  process.env.PI_WORK_HOME = workHome;
  try {
    const projectWork = path.join(workHome, "projects", projectKey(repo));
    const intentDir = path.join(projectWork, "intents", "issue-993-review");
    await mkdir(intentDir, { recursive: true });
    await writeFile(path.join(projectWork, "project-root.txt"), `${repo}\n`);
    await symlink(path.join("intents", "issue-993-review"), path.join(projectWork, "current"));
    await writeFile(path.join(intentDir, "intent.md"), "# Current intent\n\nHierarchical AI Review summary\n");
    await writeFile(path.join(intentDir, "state.json"), JSON.stringify({
      version: 1,
      generation: 3,
      status: "active",
      contractSha256: "new",
    }));

    const result = await detectIntentWorkflow(repo);
    assert.equal(result.active, true);
    if (!result.active) return;
    const current = "# Compaction Checkpoint\n\n## Durable Intent Workflow\nActive workstream: `issue-993-review`\nIntent generation: 3\n";
    const oldGeneration = "# Compaction Checkpoint\n\n## Durable Intent Workflow\nActive workstream: `issue-993-review`\nIntent generation: 2\n";
    const otherWorkstream = "# Compaction Checkpoint\n\n## Durable Intent Workflow\nActive workstream: `other`\nIntent generation: 3\n";
    assert.equal(previousSummaryMatchesIntent(current, result), true);
    assert.equal(previousSummaryMatchesIntent(oldGeneration, result), false);
    assert.equal(previousSummaryMatchesIntent(otherWorkstream, result), false);
    assert.equal(previousSummaryMatchesIntent("# Compaction Checkpoint\n\n## Execution State\nold normal task", result), false);

    const oldSessionBinding = activateIntentWorkflowForSession(
      result,
      [{
        type: "compaction",
        id: "old-generation",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: oldGeneration,
        firstKeptEntryId: "x",
        tokensBefore: 1,
        details: { intentWorkflow: { active: true, workstream: "issue-993-review" } },
      }] as never,
      result.lastTouchedAtMs + 10_000,
    );
    assert.deepEqual(oldSessionBinding, { active: false, reason: "not-used-in-session" });

    const currentSessionBinding = activateIntentWorkflowForSession(
      result,
      [{
        type: "compaction",
        id: "current-generation",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: current,
        firstKeptEntryId: "x",
        tokensBefore: 1,
        details: { intentWorkflow: { active: true, workstream: "issue-993-review" } },
      }] as never,
      result.lastTouchedAtMs + 10_000,
    );
    assert.equal(currentSessionBinding.active, true);
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
