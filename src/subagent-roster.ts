/** Small, synchronous, in-process contract with @mistrjirka/pi-subagent.
 * Never query transcript files or copy the child LLM's context into a checkpoint.
 */
export const SUBAGENT_ROSTER_CHANNEL = "pi-subagent:checkpoint-roster:v1";

export interface LiveSubagentRoster {
  total: number;
  agents: Array<{ id: string; label: string; description: string; state: "waiting" | "running" | "idle" }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function short(value: unknown, chars: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, chars) : "";
}

/** An absent or older subagent extension simply produces no roster. */
export function readLiveSubagentRoster(events: { emit(channel: string, data: unknown): void }): LiveSubagentRoster | undefined {
  let snapshot: LiveSubagentRoster | undefined;
  try {
    events.emit(SUBAGENT_ROSTER_CHANNEL, {
      respond: (payload: unknown) => {
        if (snapshot !== undefined) return;
        const value = record(payload);
        if (value?.v !== 1 || !Array.isArray(value.agents) || !Number.isSafeInteger(value.total)) return;
        const agents: LiveSubagentRoster["agents"] = [];
        for (const entry of value.agents.slice(0, 24)) {
          const item = record(entry);
          if (!item || (item.state !== "waiting" && item.state !== "running" && item.state !== "idle")) continue;
          const id = short(item.id, 64);
          if (!/^[a-z]{1,64}$/.test(id)) continue;
          agents.push({ id, label: short(item.label, 80), description: short(item.description, 120), state: item.state });
        }
        if (agents.length > 0) {
          snapshot = { total: Math.max(agents.length, Math.min(100_000, Number(value.total))), agents };
        }
      },
    });
  } catch {
    // Observability must never block compaction when an extension is unavailable.
  }
  return snapshot;
}

/** Whole rows only: never cut an agent ID or task in half to meet a character budget. */
export function renderLiveSubagentRoster(roster: LiveSubagentRoster | undefined, maxChars: number): string {
  if (!roster?.agents.length || maxChars <= 0) return "";
  const header = "### Direct subagents at compaction (snapshot; refresh with `agent_list`)";
  if (header.length + 1 >= maxChars) return "";
  let result = header;
  let shown = 0;
  for (const agent of roster.agents) {
    const detail = agent.description && agent.description !== agent.label ? `, task ${JSON.stringify(agent.description)}` : "";
    const line = `\n- @${agent.id} [${agent.state}] ${JSON.stringify(agent.label)}${detail}`;
    if (result.length + line.length > maxChars) break;
    result += line;
    shown += 1;
  }
  if (!shown) return "";
  const remaining = Math.max(0, roster.total - shown);
  const omitted = remaining ? `\n- ${remaining} more direct subagents: use \`agent_list\` for current details` : "";
  if (result.length + omitted.length <= maxChars) result += omitted;
  return result;
}
