import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { lstat, readFile, realpath, stat } from "node:fs/promises";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const INTENT_MAX_CHARS = 24_000;
const PLAN_MAX_CHARS = 24_000;

const SELECTED_HEADINGS = [
  "Current intent",
  "Navigation context",
  "Direct user quotes",
  "Interpretation corrections",
  "Accepted behavior",
  "Hard constraints",
  "Boundaries",
  "Accepted decisions",
  "Acceptance checks",
  "Open questions",
] as const;

const TEMPLATE_LINES = new Set([
  "- Active branch / base ref / PR or issue when relevant.",
  "- Request lineage: the prior decisions this request continues, narrows, or corrects.",
  "- Code ownership route: UI or entry point → API/service → owning workflow or persistence boundary.",
  "- Explicitly excluded neighboring systems or paths.",
  "- Add a relevant direct user quote when the request is materially clarified.",
  "- Add only when a prior interpretation materially affected ownership, scope, architecture, safety, or validation.",
  "- Record concise facts and decisions, never hidden reasoning, speculative alternatives, or a transcript.",
  "- Observable behavior the implementation must provide.",
  "- Compatibility, architecture, safety, type-system, or scope constraints.",
  "- Explicit non-goals and forbidden changes.",
  "- Decisions explicitly made by the user or accepted after a stated interpretation.",
  "- [ ] Concrete checks that prove completion.",
]);

type IntentWorkflowStatus = "active" | "pending_reconciliation";

interface IntentWorkflowStateV1 {
  version: 1;
  generation: number;
  status: IntentWorkflowStatus;
}

export interface ActiveIntentWorkflow {
  active: true;
  projectRoot: string;
  projectKey: string;
  workstream: string;
  generation: number;
  intentPath: string;
  intentContract: string;
  intentTruncated: boolean;
  lastTouchedAtMs: number;
  planPath?: string;
  plan?: string;
  planTruncated: boolean;
}

export interface PendingIntentWorkflow {
  active: false;
  reason: "pending-reconciliation";
  projectRoot: string;
  projectKey: string;
  workstream: string;
  generation: number;
  intentPath: string;
}

export interface InactiveIntentWorkflow {
  active: false;
  reason:
    | "no-active-ledger"
    | "stale-project-root"
    | "invalid-current-target"
    | "invalid-intent"
    | "invalid-intent-state"
    | "not-used-in-session";
}

export type IntentWorkflowDetection = ActiveIntentWorkflow | PendingIntentWorkflow | InactiveIntentWorkflow;

function slugifyProject(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} chars omitted]`,
    truncated: true,
  };
}

async function canonicalProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 2500,
      encoding: "utf8",
    });
    const root = stdout.trim();
    if (root) return await realpath(root);
  } catch {
    // Outside Git or Git unavailable: intent-workflow uses the physical cwd.
  }
  return realpath(cwd);
}

function workHome(): string {
  if (process.env.PI_WORK_HOME) return path.resolve(process.env.PI_WORK_HOME);
  const dataHome = process.env.XDG_DATA_HOME
    ? path.resolve(process.env.XDG_DATA_HOME)
    : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "pi-work");
}

function parseH1Sections(markdown: string): Map<string, string> {
  const matches = [...markdown.matchAll(/^# ([^\n]+)\s*$/gm)];
  const sections = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const heading = match[1]!.trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : markdown.length;
    sections.set(heading, markdown.slice(start, end).trim());
  }
  return sections;
}

function cleanSection(heading: string, body: string): string {
  const cleaned = body
    .split("\n")
    .filter((line) => !TEMPLATE_LINES.has(line.trim()))
    .join("\n")
    .trim();

  if (!cleaned) return "";
  if (heading === "Direct user quotes") {
    const lines = cleaned.split("\n");
    const bulletIndexes = lines
      .map((line, index) => (/^\s*-\s+/.test(line) ? index : -1))
      .filter((index) => index >= 0);
    if (bulletIndexes.length > 6) {
      const start = bulletIndexes[bulletIndexes.length - 6]!;
      return lines.slice(start).join("\n").trim();
    }
  }
  return cleaned;
}

export function extractIntentContract(markdown: string): { text: string; truncated: boolean } | undefined {
  const sections = parseH1Sections(markdown);
  const rendered: string[] = [];
  for (const heading of SELECTED_HEADINGS) {
    const raw = sections.get(heading);
    if (raw === undefined) continue;
    const body = cleanSection(heading, raw);
    if (!body) continue;
    rendered.push(`# ${heading}\n\n${body}`);
  }

  const current = cleanSection("Current intent", sections.get("Current intent") ?? "");
  if (!current) return undefined;
  return clip(rendered.join("\n\n"), INTENT_MAX_CHARS);
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIntentState(raw: string | undefined): IntentWorkflowStateV1 | undefined {
  if (raw === undefined) return { version: 1, generation: 1, status: "active" };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 1) return undefined;
  if (value.status !== "active" && value.status !== "pending_reconciliation") return undefined;
  return { version: 1, generation: value.generation, status: value.status };
}

async function resolveProjectPointer(projectWork: string, name: "current" | "pending"):
Promise<{ dir: string; touchedAtMs: number } | undefined> {
  const pointerPath = path.join(projectWork, name);
  try {
    const [dir, info] = await Promise.all([realpath(pointerPath), lstat(pointerPath)]);
    return { dir, touchedAtMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function commandActivatesWorkstream(command: string, workstream: string): boolean {
  if (!command.includes("new-intent.sh")) return false;
  if (!/(?:--resume|--continue|--reuse|--create|--create-new)\b/.test(command)) return false;
  return slugifyProject(command).includes(workstream);
}

function assistantMessageTouchesWorkflow(entry: SessionEntry, snapshot: ActiveIntentWorkflow): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;

  if (message.role === "bashExecution") {
    if (message.exitCode !== 0) return false;
    return message.command.includes(snapshot.intentPath)
      || message.command.includes(path.dirname(snapshot.intentPath))
      || commandActivatesWorkstream(message.command, snapshot.workstream);
  }

  if (message.role !== "assistant") return false;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    for (const value of Object.values(block.arguments)) {
      if (typeof value !== "string") continue;
      if (value.includes(snapshot.intentPath) || value.includes(path.dirname(snapshot.intentPath))) return true;
      if (commandActivatesWorkstream(value, snapshot.workstream)) return true;
    }
  }
  return false;
}

export function activateIntentWorkflowForSession(
  detection: IntentWorkflowDetection,
  entries: SessionEntry[],
  extensionLoadedAtMs: number,
): IntentWorkflowDetection {
  if (!detection.active) return detection;

  // A create/resume/continue/confirm/edit performed after this extension instance
  // loaded is direct evidence. A small tolerance avoids filesystem timestamp races.
  if (detection.lastTouchedAtMs >= extensionLoadedAtMs - 2_000) return detection;

  for (const entry of entries) {
    if (entry.type === "compaction" && isRecord(entry.details)) {
      const workflow = entry.details.intentWorkflow;
      if (
        isRecord(workflow)
        && workflow.active === true
        && workflow.workstream === detection.workstream
      ) {
        return detection;
      }
    }
    if (assistantMessageTouchesWorkflow(entry, detection)) return detection;
  }

  // A persistent `current` symlink alone may be from a previous task. Do not let
  // that stale pointer redefine a session that is not using intent-workflow.
  return { active: false, reason: "not-used-in-session" };
}

export function previousSummaryMatchesIntent(
  summary: string | undefined,
  detection: IntentWorkflowDetection,
): boolean {
  if (!summary?.trim()) return true;
  if (detection.active === false) {
    if (detection.reason === "pending-reconciliation") return false;
    return !summary.includes("## Durable Intent Workflow");
  }

  return summary.includes("## Durable Intent Workflow")
    && summary.includes(`Active workstream: \`${detection.workstream}\``)
    && summary.includes(`Intent generation: ${detection.generation}`);
}

export async function detectIntentWorkflow(cwd: string): Promise<IntentWorkflowDetection> {
  const projectRoot = await canonicalProjectRoot(cwd);
  const projectSlug = slugifyProject(path.basename(projectRoot));
  const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const projectKey = `${projectSlug}-${projectHash}`;
  const projectWork = path.join(workHome(), "projects", projectKey);

  const recordedRoot = (await readOptional(path.join(projectWork, "project-root.txt")))?.trim();
  if (!recordedRoot) return { active: false, reason: "stale-project-root" };
  try {
    if ((await realpath(recordedRoot)) !== projectRoot) return { active: false, reason: "stale-project-root" };
  } catch {
    return { active: false, reason: "stale-project-root" };
  }

  const intentsRoot = path.join(projectWork, "intents");
  let realIntentsRoot: string;
  try {
    realIntentsRoot = await realpath(intentsRoot);
  } catch {
    return { active: false, reason: "invalid-current-target" };
  }

  const [currentPointer, pendingPointer] = await Promise.all([
    resolveProjectPointer(projectWork, "current"),
    resolveProjectPointer(projectWork, "pending"),
  ]);
  if (currentPointer && pendingPointer) return { active: false, reason: "invalid-intent-state" };
  const pointer = currentPointer ?? pendingPointer;
  if (!pointer) return { active: false, reason: "no-active-ledger" };
  if (!pointer.dir.startsWith(`${realIntentsRoot}${path.sep}`)) {
    return { active: false, reason: "invalid-current-target" };
  }

  const intentPath = path.join(pointer.dir, "intent.md");
  if (!(await isRegularFile(intentPath))) return { active: false, reason: "invalid-intent" };
  const [intentRaw, intentInfo, stateRaw] = await Promise.all([
    readFile(intentPath, "utf8"),
    stat(intentPath),
    readOptional(path.join(pointer.dir, "state.json")),
  ]);
  const contract = extractIntentContract(intentRaw);
  if (!contract) return { active: false, reason: "invalid-intent" };
  const workflowState = parseIntentState(stateRaw);
  if (!workflowState) return { active: false, reason: "invalid-intent-state" };

  if (pendingPointer) {
    if (workflowState.status !== "pending_reconciliation") {
      return { active: false, reason: "invalid-intent-state" };
    }
    return {
      active: false,
      reason: "pending-reconciliation",
      projectRoot,
      projectKey,
      workstream: path.basename(pointer.dir),
      generation: workflowState.generation,
      intentPath,
    };
  }

  // Accept a current pointer to a pending state for compatibility with the first
  // generation-aware script revision; it is still inactive and therefore safe.
  if (workflowState.status === "pending_reconciliation") {
    return {
      active: false,
      reason: "pending-reconciliation",
      projectRoot,
      projectKey,
      workstream: path.basename(pointer.dir),
      generation: workflowState.generation,
      intentPath,
    };
  }

  const planPath = path.join(pointer.dir, "plan.md");
  const planRaw = (await readOptional(planPath))?.trim();
  const clippedPlan = planRaw ? clip(planRaw, PLAN_MAX_CHARS) : undefined;
  const planTouchedAtMs = clippedPlan ? (await stat(planPath)).mtimeMs : 0;
  const stateTouchedAtMs = stateRaw !== undefined ? (await stat(path.join(pointer.dir, "state.json"))).mtimeMs : 0;
  const lastTouchedAtMs = Math.max(pointer.touchedAtMs, intentInfo.mtimeMs, planTouchedAtMs, stateTouchedAtMs);

  return {
    active: true,
    projectRoot,
    projectKey,
    workstream: path.basename(pointer.dir),
    generation: workflowState.generation,
    intentPath,
    intentContract: contract.text,
    intentTruncated: contract.truncated,
    lastTouchedAtMs,
    ...(clippedPlan ? { planPath, plan: clippedPlan.text } : {}),
    planTruncated: clippedPlan?.truncated ?? false,
  };
}

export interface IntentWorkflowRenderOptions {
  /** Hard character budget for the rendered workflow block. */
  maxChars?: number;
  /** Include a bounded plan excerpt. Final checkpoints normally keep only the path. */
  includePlanBody?: boolean;
  /** Maximum characters from plan.md when includePlanBody is true. */
  planChars?: number;
}

const COMPACT_CONTRACT_PRIORITY = [
  "Current intent",
  "Hard constraints",
  "Boundaries",
  "Accepted decisions",
  "Acceptance checks",
  "Navigation context",
  "Accepted behavior",
  "Interpretation corrections",
  "Open questions",
  "Direct user quotes",
] as const;

function compactIntentContract(contract: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const sections = parseH1Sections(contract);
  const rendered: string[] = [];
  let used = 0;

  for (const heading of COMPACT_CONTRACT_PRIORITY) {
    const body = sections.get(heading)?.trim();
    if (!body) continue;
    const prefix = `# ${heading}\n\n`;
    const separator = rendered.length > 0 ? "\n\n" : "";
    const remaining = maxChars - used - separator.length - prefix.length;
    if (remaining <= 0) break;
    // No individual section should consume the whole compact ledger.
    const perSection = Math.min(remaining, Math.max(900, Math.floor(maxChars * 0.28)));
    const clipped = clip(body, perSection).text;
    rendered.push(`${prefix}${clipped}`);
    used += separator.length + prefix.length + clipped.length;
  }

  return rendered.join("\n\n");
}

export function renderIntentWorkflow(
  snapshot: ActiveIntentWorkflow,
  options: IntentWorkflowRenderOptions = {},
): string {
  const maxChars = options.maxChars ?? Number.MAX_SAFE_INTEGER;
  const includePlanBody = options.includePlanBody ?? true;
  const planChars = options.planChars ?? 8_000;
  const metadata = [
    `Active workstream: \`${snapshot.workstream}\``,
    `Intent generation: ${snapshot.generation}`,
    `Intent: \`${snapshot.intentPath}\``,
    ...(snapshot.planPath ? [
      `Plan: \`${snapshot.planPath}\``,
      "Plan precedence: this is the maintained evolving workflow plan. Read the exact plan file before implementation when its details govern the work; newer explicit user instructions override stale workflow state.",
    ] : []),
  ].join("\n");

  const planReserve = includePlanBody && snapshot.plan
    ? Math.min(planChars + 40, Math.floor(maxChars * 0.38))
    : 0;
  const contractBudget = Math.max(0, maxChars - metadata.length - planReserve - 4);
  const contract = compactIntentContract(snapshot.intentContract, contractBudget);
  const parts = [metadata, ...(contract ? ["", contract] : [])];

  if (includePlanBody && snapshot.plan) {
    const body = clip(snapshot.plan, Math.min(planChars, Math.max(0, maxChars - parts.join("\n").length - 36))).text;
    if (body) parts.push("", "# Current implementation plan (excerpt)", "", body);
  }

  return clip(parts.join("\n"), maxChars).text;
}
