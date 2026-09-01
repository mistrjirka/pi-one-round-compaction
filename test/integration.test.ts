import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import oneRoundCompaction from "../src/index.js";
import { emptyUsageForTests } from "../src/core.js";
import { loadUserArtifactManifest, storeUserArtifact } from "../src/user-artifacts.js";

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

function entry(id: string, message: ReturnType<typeof user> | ReturnType<typeof assistant>) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

test("extension launches exactly two LLM lanes concurrently and deterministically merges them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-test-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const fakePi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
    };
    oneRoundCompaction(fakePi as never);

    const beforeCompact = handlers.get("session_before_compact")?.[0];
    assert.ok(beforeCompact);

    const model = {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      api: "openai-responses",
      provider: "opencode-go",
      baseUrl: "https://example.invalid",
      reasoning: true,
      thinkingLevelMap: { low: "low" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    };

    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => "test-session" },
      isProjectTrusted: () => false,
      ui: { notify() {} },
      modelRegistry: {
        find(provider: string, modelId: string) {
          return provider === model.provider && modelId === model.id ? model : undefined;
        },
        async complete(_model: unknown, request: { messages: Array<{ content: Array<{ text?: string }> }> }) {
          calls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight--;
          const prompt = request.messages[0]?.content[0]?.text ?? "";
          const text = prompt.includes("Current Objective")
            ? "## Current Objective\nCurrent plan\n\n## Accepted Plan / Scope\n- Do the work\n\n## Constraints / Exclusions / User Corrections\n- Do not touch UI"
            : "## Done\n- inspected\n\n## Current Code / Repository State\n- backend\n\n## Verification State\n- NOT RUN\n\n## Adjustments / Discoveries\n- none\n\n## Remaining / Immediate Next Actions\n1. implement";
          return {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: model.provider,
            model: model.id,
            usage: emptyUsageForTests(),
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    };

    const branchEntries = [
      entry("u1", user(`old-${"x".repeat(120)}`)),
      entry("a1", assistant(`old-${"x".repeat(120)}`)),
      entry("u2", user(`middle-${"x".repeat(120)}`)),
      entry("a2", assistant(`middle-${"x".repeat(120)}`)),
      entry("u3", user(`recent-${"x".repeat(120)}`)),
      entry("a3", assistant(`recent-${"x".repeat(120)}`)),
    ];
    const event = {
      branchEntries,
      preparation: {
        firstKeptEntryId: "a3",
        messagesToSummarize: [user("native prefix")],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 500,
        previousSummary: undefined,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 80 },
      },
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const result = await beforeCompact(event as never, fakeCtx as never) as {
      compaction?: { summary: string; details: { plugin: string; lanes: unknown[] }; estimatedTokensAfter?: number };
    };

    assert.equal(calls, 2);
    assert.equal(maxInFlight, 2);
    assert.equal(result.compaction?.details.plugin, "pi-one-round-compaction");
    assert.equal(result.compaction?.details.lanes.length, 2);
    assert.match(result.compaction?.summary ?? "", /## Task Semantics/);
    assert.match(result.compaction?.summary ?? "", /## Execution State/);
    assert.ok((result.compaction?.estimatedTokensAfter ?? 0) > 0);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("oversized human plan becomes an LLM-classified durable reference in the checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-artifact-integration-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const fakePi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
    };
    oneRoundCompaction(fakePi as never);
    const beforeCompact = handlers.get("session_before_compact")?.[0];
    assert.ok(beforeCompact);

    const model = {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      api: "openai-responses",
      provider: "opencode-go",
      baseUrl: "https://example.invalid",
      reasoning: true,
      thinkingLevelMap: { low: "low" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    };
    const seenPrompts: string[] = [];
    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => "artifact-session", getSessionFile: () => undefined, getHeader: () => null },
      isProjectTrusted: () => false,
      ui: { notify() {} },
      modelRegistry: {
        find(provider: string, modelId: string) {
          return provider === model.provider && modelId === model.id ? model : undefined;
        },
        async complete(_model: unknown, request: { messages: Array<{ content: Array<{ text?: string }> }> }) {
          const prompt = request.messages[0]?.content[0]?.text ?? "";
          seenPrompts.push(prompt);
          const text = prompt.includes("Oversized human user-source candidates")
            ? "## Current Objective\nImplement the current plan\n\n## Accepted Plan / Scope\n- Follow the user plan\n\n## Constraints / Exclusions / User Corrections\n- Preserve scope\n\n## Durable User Sources\n- U0001 | sourceSessionId=artifact-session | kind=plan | authority=governing | note=original implementation plan"
            : "## Done\n- inspected\n\n## Current Code / Repository State\n- backend\n\n## Verification State\n- NOT RUN\n\n## Adjustments / Discoveries\n- none\n\n## Remaining / Immediate Next Actions\n1. implement";
          return {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: model.provider,
            model: model.id,
            usage: emptyUsageForTests(),
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    };

    const bigPlan = `Original implementation plan\n${"p".repeat(9_000)}`;
    const branchEntries = [
      entry("u1", user(bigPlan)),
      entry("a1", assistant("I will follow it.")),
      entry("u2", user("continue")),
      entry("a2", assistant("continuing")),
    ];
    const event = {
      branchEntries,
      preparation: {
        firstKeptEntryId: "u2",
        messagesToSummarize: [user(bigPlan), assistant("I will follow it.")],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 3_000,
        previousSummary: undefined,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 80 },
      },
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const result = await beforeCompact(event as never, fakeCtx as never) as {
      compaction?: {
        summary: string;
        details: {
          version: number;
          knownUserArtifactIds: string[];
          knownUserArtifacts: Array<{ id: string; sourceSessionId?: string }>;
          durableUserReferences: Array<{ id: string; sourceSessionId?: string; state: string; kind?: string; authority?: string; semanticNote?: string }>;
        };
      };
    };

    assert.equal(result.compaction?.details.version, 5);
    assert.deepEqual(result.compaction?.details.knownUserArtifactIds, ["U0001"]);
    assert.equal(result.compaction?.details.durableUserReferences[0]?.id, "U0001");
    assert.equal(result.compaction?.details.durableUserReferences[0]?.state, "active");
    assert.equal(result.compaction?.details.durableUserReferences[0]?.kind, "plan");
    assert.equal(result.compaction?.details.durableUserReferences[0]?.authority, "governing");
    assert.equal(result.compaction?.details.durableUserReferences[0]?.sourceSessionId, "artifact-session");
    assert.deepEqual(result.compaction?.details.knownUserArtifacts, [{ id: "U0001", sourceSessionId: "artifact-session" }]);
    assert.match(result.compaction?.details.durableUserReferences[0]?.semanticNote ?? "", /implementation plan/);
    assert.match(result.compaction?.summary ?? "", /Governing exact user sources/);
    assert.match(result.compaction?.summary ?? "", /READ BEFORE GOVERNED WORK/);
    assert.match(result.compaction?.summary ?? "", /U0001 \[active, plan, governing\]/);
    assert.match(result.compaction?.summary ?? "", /user_artifact/);
    assert.equal(seenPrompts.filter((prompt) => prompt.includes("Oversized human user-source candidates")).length, 1);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("forked child user_artifact reads exact parent governing source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-fork-tool-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  const sessionsDir = path.join(agentDir, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const parentSessionId = "parent-session";
    const childSessionId = "child-session";
    const parentFile = path.join(sessionsDir, "parent.jsonl");
    const childFile = path.join(sessionsDir, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: parentSessionId, timestamp: new Date().toISOString(), cwd })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: childSessionId, timestamp: new Date().toISOString(), cwd, parentSession: parentFile })}\n`, "utf8");
    const plan = `EXACT PARENT PLAN\n${"q".repeat(9_000)}`;
    await storeUserArtifact({ sessionId: parentSessionId, text: plan, timestamp: 1, thresholdChars: 8_000, previewChars: 120 });

    let userArtifactTool: { execute: (...args: any[]) => Promise<any> } | undefined;
    const fakePi = {
      on() {},
      registerCommand() {},
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
        if (tool.name === "user_artifact") userArtifactTool = tool;
      },
    };
    oneRoundCompaction(fakePi as never);
    assert.ok(userArtifactTool);

    const branchEntries = [{
      type: "compaction" as const,
      id: "c1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "checkpoint",
      firstKeptEntryId: "u1",
      tokensBefore: 100_000,
      details: {
        plugin: "pi-one-round-compaction",
        version: 5,
        knownUserArtifactIds: ["U0001"],
        knownUserArtifacts: [{ id: "U0001", sourceSessionId: parentSessionId }],
        durableUserReferences: [{
          id: "U0001",
          sourceSessionId: parentSessionId,
          state: "active",
          misses: 0,
          kind: "plan",
          authority: "governing",
          semanticNote: "current governing plan",
        }],
      },
    }];
    const fakeCtx = {
      cwd,
      sessionManager: {
        getSessionId: () => childSessionId,
        getSessionFile: () => childFile,
        getHeader: () => ({ type: "session", version: 3, id: childSessionId, timestamp: new Date().toISOString(), cwd, parentSession: parentFile }),
        getBranch: () => branchEntries,
      },
      isProjectTrusted: () => false,
      ui: { notify() {} },
    };
    const result = await userArtifactTool!.execute(
      "call-1",
      { action: "read", id: "U0001", sourceSessionId: parentSessionId, maxChars: 20_000 },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(result.isError, undefined);
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /^EXACT PARENT PLAN/);
    assert.match(text, /sourceSessionId=parent-session: end of exact source/);
    assert.equal((await loadUserArtifactManifest(childSessionId)).artifacts.length, 0);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("active intent workflow is autodetected and switches the two lanes to implementation plus evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-workflow-test-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  const workHome = path.join(root, "pi-work");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(workHome, { recursive: true });
  const canonicalCwd = await realpath(cwd);

  const projectSlug = path.basename(canonicalCwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  const projectHash = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 12);
  const projectWork = path.join(workHome, "projects", `${projectSlug}-${projectHash}`);
  const intentDir = path.join(projectWork, "intents", "strict-tools-qdrant");
  await mkdir(intentDir, { recursive: true });
  await writeFile(path.join(projectWork, "project-root.txt"), `${canonicalCwd}\n`);
  await symlink(path.join("intents", "strict-tools-qdrant"), path.join(projectWork, "current"));
  await writeFile(path.join(intentDir, "intent.md"), `# Current intent

Implement strict tools and Qdrant indexes.

# Hard constraints

- Do not touch UI.

# Acceptance checks

- [ ] Focused tests pass.

# Evolution history

- old unrelated history
`);
  await writeFile(path.join(intentDir, "plan.md"), "1. Strict tools\n2. Qdrant indexes\n");

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldWorkHome = process.env.PI_WORK_HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORK_HOME = workHome;

  try {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const fakePi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
    };
    oneRoundCompaction(fakePi as never);
    const beforeCompact = handlers.get("session_before_compact")?.[0];
    assert.ok(beforeCompact);

    const model = {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      api: "openai-responses",
      provider: "opencode-go",
      baseUrl: "https://example.invalid",
      reasoning: true,
      thinkingLevelMap: { low: "low" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    };

    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const seenPrompts: string[] = [];
    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => "test-session" },
      isProjectTrusted: () => false,
      ui: { notify() {} },
      modelRegistry: {
        find(provider: string, modelId: string) {
          return provider === model.provider && modelId === model.id ? model : undefined;
        },
        async complete(_model: unknown, request: { messages: Array<{ content: Array<{ text?: string }> }> }) {
          calls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const prompt = request.messages[0]?.content[0]?.text ?? "";
          seenPrompts.push(prompt);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight--;
          const text = prompt.includes("implementation continuation state only")
            ? "## Done\n- inspected\n\n## Current Code / Repository State\n- backend\n\n## Adjustments / Discoveries\n- none\n\n## Remaining / Immediate Next Actions\n1. implement"
            : "## Verification State\n- NOT RUN\n\n## Important Failures / Wrong Turns\n- none\n\n## Unresolved Risks / Open Questions\n- none\n\n## Critical Exact Context\n- none";
          return {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: model.provider,
            model: model.id,
            usage: emptyUsageForTests(),
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    };

    const branchEntries = [
      entry("u1", user(`old-${"x".repeat(120)}`)),
      entry("a1", assistant(`old-${"x".repeat(120)}`)),
      entry("u2", user(`middle-${"x".repeat(120)}`)),
      entry("a2", assistant(`middle-${"x".repeat(120)}`)),
      entry("u3", user(`recent-${"x".repeat(120)}`)),
      entry("a3", assistant(`recent-${"x".repeat(120)}`)),
    ];
    const event = {
      branchEntries,
      preparation: {
        firstKeptEntryId: "a3",
        messagesToSummarize: [user("native prefix")],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 500,
        previousSummary: undefined,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 80 },
      },
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const result = await beforeCompact(event as never, fakeCtx as never) as {
      compaction?: {
        summary: string;
        details: { intentWorkflow: { active: boolean; workstream?: string }; lanes: unknown[] };
      };
    };

    assert.equal(calls, 2);
    assert.equal(maxInFlight, 2);
    assert.equal(result.compaction?.details.intentWorkflow.active, true);
    assert.equal(result.compaction?.details.intentWorkflow.workstream, "strict-tools-qdrant");
    assert.equal(result.compaction?.details.lanes.length, 2);
    assert.equal(seenPrompts.filter((prompt) => prompt.includes("implementation continuation state only")).length, 1);
    assert.equal(seenPrompts.filter((prompt) => prompt.includes("evidence and risk state only")).length, 1);
    assert.match(result.compaction?.summary ?? "", /## Durable Intent Workflow/);
    assert.match(result.compaction?.summary ?? "", /Implement strict tools and Qdrant indexes/);
    assert.match(result.compaction?.summary ?? "", /Plan: .*plan\.md/);
    assert.doesNotMatch(result.compaction?.summary ?? "", /# Current implementation plan/);
    assert.match(result.compaction?.summary ?? "", /## Implementation State/);
    assert.match(result.compaction?.summary ?? "", /## Verification \/ Evidence State/);
    assert.doesNotMatch(result.compaction?.summary ?? "", /old unrelated history/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldWorkHome === undefined) delete process.env.PI_WORK_HOME;
    else process.env.PI_WORK_HOME = oldWorkHome;
  }
});

test("idle input preflight compacts before a prompt would cross the model context window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-preflight-test-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const fakePi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
    };
    oneRoundCompaction(fakePi as never);
    const input = handlers.get("input")?.[0];
    assert.ok(input);

    let compactCalls = 0;
    const notifications: string[] = [];
    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => "test-session" },
      isProjectTrusted: () => false,
      isIdle: () => true,
      getContextUsage: () => ({ tokens: 270_000, contextWindow: 272_000, percent: 99.26 }),
      compact(options: { onComplete?: (result: unknown) => void }) {
        compactCalls++;
        options.onComplete?.({
          summary: "checkpoint",
          firstKeptEntryId: "u1",
          tokensBefore: 270_000,
          estimatedTokensAfter: 24_000,
        });
      },
      ui: { notify(message: string) { notifications.push(message); } },
    };

    const result = await input({ type: "input", text: "x".repeat(12_000), source: "interactive" } as never, fakeCtx as never);
    assert.equal(result, undefined);
    assert.equal(compactCalls, 1);
    assert.ok(notifications.some((message) => /273,000 \/ 272,000/.test(message)));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("failed required preflight blocks the prompt instead of sending oversized context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-one-round-preflight-fail-test-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const fakePi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
    };
    oneRoundCompaction(fakePi as never);
    const input = handlers.get("input")?.[0];
    assert.ok(input);

    const notifications: string[] = [];
    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => "test-session" },
      isProjectTrusted: () => false,
      isIdle: () => true,
      getContextUsage: () => ({ tokens: 271_000, contextWindow: 272_000, percent: 99.63 }),
      compact(options: { onError?: (error: Error) => void }) {
        options.onError?.(new Error("simulated compaction failure"));
      },
      ui: { notify(message: string) { notifications.push(message); } },
    };

    const result = await input({ type: "input", text: "x".repeat(8_000), source: "interactive" } as never, fakeCtx as never);
    assert.deepEqual(result, { action: "handled" });
    assert.ok(notifications.some((message) => /Prompt not sent/.test(message)));
    assert.ok(notifications.some((message) => /simulated compaction failure/.test(message)));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});
