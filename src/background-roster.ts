/**
 * Read-only bridge to pi-bg-bash 0.6.x's live per-process task registry.
 *
 * pi-bg-bash keeps its registry at Symbol.for("pi-bg-bash.registry") specifically
 * to survive Pi extension reloads. Never mutate it, read logs, spawn processes
 * or block compaction. Fail closed if the host package changes.
 */
export interface RunningBackgroundRoster {
  total: number;
  tasks: Array<{ id: string; command: string; startedAt: number }>;
}

const REGISTRY_KEY = Symbol.for("pi-bg-bash.registry");
const TASK_ID = /^bg-[1-9][0-9]{0,6}$/;
const SESSION_ID = /^[a-zA-Z0-9-]{8,80}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function sanitizedCommand(value: unknown): string {
  if (typeof value !== "string") return "";
  // A command is untrusted data. Keep its text, never execute or interpret it.
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Snapshot only the current session's actively running commands. */
export function readRunningBackgroundCommands(sessionId: string): RunningBackgroundRoster | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  try {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const registry = record(holder[REGISTRY_KEY]);
    const tasks = registry?.tasks;
    if (!(tasks instanceof Map)) return undefined;
    const active: RunningBackgroundRoster["tasks"] = [];
    let total = 0;
    for (const [key, value] of tasks) {
      const task = record(value);
      if (!task || task.state !== "running" || task.ownerSessionId !== sessionId) continue;
      if (typeof key !== "string" || !TASK_ID.test(key) || task.id !== key) continue;
      if (typeof task.startedAt !== "number" || !Number.isSafeInteger(task.startedAt) || task.startedAt < 0) continue;
      total += 1;
      if (active.length >= 24) continue;
      active.push({ id: key, command: sanitizedCommand(task.command), startedAt: task.startedAt });
    }
    if (!total) return undefined;
    return { total, tasks: active.sort((a, b) => a.startedAt - b.startedAt) };
  } catch {
    // An unavailable, old, or changed pi-bg-bash cannot block compaction.
    return undefined;
  }
}

/** Whole entries only, with the same character budgeting as other evidence. */
export function renderRunningBackgroundCommands(
  roster: RunningBackgroundRoster | undefined, maxChars: number,
): string {
  if (!roster?.tasks.length || maxChars <= 0) return "";
  const header = "### Running background commands at compaction (snapshot; refresh with `bash_tasks`)";
  if (header.length + 1 >= maxChars) return "";
  let content = header;
  let count = 0;
  for (const task of roster.tasks) {
    const line = `\n- ${task.id} [running] command ${JSON.stringify(task.command)}`;
    if (content.length + line.length > maxChars) break;
    content += line;
    count++;
  }
  if (!count) return "";
  const missing = Math.max(0, roster.total - count);
  const omitted = missing > 0 ? `\n- ${missing} more running tasks: use \`bash_tasks\` to refresh` : "";
  return content.length + omitted.length <= maxChars ? content + omitted : content;
}
