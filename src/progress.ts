import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { LaneName } from "./core.js";

export type CompactionMode = "normal" | "workflow";
export type LaneRole = "intent" | "execution" | "implementation" | "evidence";
export type ProgressPhase = "preparing" | "streaming" | "merging" | "complete" | "error" | "aborted";
export type LaneProgressState = "queued" | "streaming" | "done" | "error";

export interface CompactionProgressLaneV1 {
  role: LaneRole;
  state: LaneProgressState;
  chars: number;
  /** Text produced since the previous emitted progress frame. PiTTy can append this verbatim. */
  delta?: string;
  elapsedMs?: number;
}

export interface CompactionProgressV1 {
  v: 1;
  runId: string;
  seq: number;
  phase: ProgressPhase;
  mode: CompactionMode;
  reason: "manual" | "threshold" | "overflow";
  elapsedMs: number;
  retainedTurns: number;
  estimatedRetainedTokens: number;
  keepRecentTokens: number;
  boundaryMode: "whole-turn" | "pi-fallback";
  intentWorkflow?: {
    active: true;
    workstream: string;
    hasPlan: boolean;
  };
  lanes: Record<LaneName, CompactionProgressLaneV1>;
  error?: string;
}

export const COMPACTION_PROGRESS_EVENT = "pi-one-round-compaction:progress";
export const COMPACTION_PROGRESS_STATUS_KEY = "pi-one-round-compaction.progress.v1";
export const COMPACTION_PREVIEW_WIDGET_KEY = "pi-one-round-compaction.preview.v1";
const MIN_EMIT_INTERVAL_MS = 125;
const MAX_WIDGET_CHARS_PER_LANE = 8_000;
const MAX_WIDGET_LINES_PER_LANE = 36;

interface LaneMutableState {
  role: LaneRole;
  state: LaneProgressState;
  text: string;
  pendingDelta: string;
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface ProgressReporter {
  readonly runId: string;
  laneStart(lane: LaneName): void;
  laneDelta(lane: LaneName, delta: string): void;
  laneDone(lane: LaneName, finalText?: string): void;
  laneError(lane: LaneName, error: string): void;
  merging(): void;
  complete(): void;
  fail(error: string): void;
  abort(): void;
  clear(): void;
}

function laneElapsed(now: number, lane: LaneMutableState): number | undefined {
  if (lane.startedAtMs === undefined) return undefined;
  return Math.max(0, (lane.finishedAtMs ?? now) - lane.startedAtMs);
}

function clipWidgetText(text: string): string {
  if (text.length <= MAX_WIDGET_CHARS_PER_LANE) return text;
  const head = Math.floor(MAX_WIDGET_CHARS_PER_LANE * 0.72);
  const tail = MAX_WIDGET_CHARS_PER_LANE - head;
  return `${text.slice(0, head)}\n[… live preview clipped …]\n${text.slice(-tail)}`;
}

function widgetLinesForLane(label: string, lane: LaneMutableState): string[] {
  const heading = `── ${label} · ${lane.state} · ${lane.text.length.toLocaleString()} chars ──`;
  if (!lane.text) return [heading, "(waiting for model output)"];
  const lines = clipWidgetText(lane.text).split("\n");
  if (lines.length <= MAX_WIDGET_LINES_PER_LANE) return [heading, ...lines];
  const headCount = Math.ceil(MAX_WIDGET_LINES_PER_LANE * 0.7);
  const tailCount = MAX_WIDGET_LINES_PER_LANE - headCount;
  return [
    heading,
    ...lines.slice(0, headCount),
    "[… live preview lines clipped …]",
    ...lines.slice(-tailCount),
  ];
}

export function createProgressReporter(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  mode: CompactionMode;
  reason: "manual" | "threshold" | "overflow";
  retainedTurns: number;
  estimatedRetainedTokens: number;
  keepRecentTokens: number;
  boundaryMode: "whole-turn" | "pi-fallback";
  intentWorkflow?: { workstream: string; hasPlan: boolean };
  roles: Record<LaneName, LaneRole>;
}): ProgressReporter {
  const runId = randomUUID();
  const startedAt = Date.now();
  let seq = 0;
  let phase: ProgressPhase = "preparing";
  let lastEmitAt = 0;
  let terminalError: string | undefined;
  let closed = false;

  const lanes: Record<LaneName, LaneMutableState> = {
    intent: { role: params.roles.intent, state: "queued", text: "", pendingDelta: "" },
    execution: { role: params.roles.execution, state: "queued", text: "", pendingDelta: "" },
  };

  const buildPayload = (consumeDelta: boolean): CompactionProgressV1 => {
    const now = Date.now();
    const lanePayload = (lane: LaneMutableState): CompactionProgressLaneV1 => {
      const elapsedMs = laneElapsed(now, lane);
      const delta = consumeDelta ? lane.pendingDelta : "";
      return {
        role: lane.role,
        state: lane.state,
        chars: lane.text.length,
        ...(delta ? { delta } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      };
    };
    const payload: CompactionProgressV1 = {
      v: 1,
      runId,
      seq: seq++,
      phase,
      mode: params.mode,
      reason: params.reason,
      elapsedMs: Math.max(0, now - startedAt),
      retainedTurns: params.retainedTurns,
      estimatedRetainedTokens: params.estimatedRetainedTokens,
      keepRecentTokens: params.keepRecentTokens,
      boundaryMode: params.boundaryMode,
      ...(params.intentWorkflow
        ? {
            intentWorkflow: {
              active: true as const,
              workstream: params.intentWorkflow.workstream,
              hasPlan: params.intentWorkflow.hasPlan,
            },
          }
        : {}),
      lanes: {
        intent: lanePayload(lanes.intent),
        execution: lanePayload(lanes.execution),
      },
      ...(terminalError ? { error: terminalError } : {}),
    };
    if (consumeDelta) {
      lanes.intent.pendingDelta = "";
      lanes.execution.pendingDelta = "";
    }
    return payload;
  };

  const renderWidget = (): string[] => {
    const modeLabel = params.mode === "workflow" ? "intent workflow" : "normal";
    return [
      `Compaction · ${modeLabel} · ${phase} · ${Math.max(0, Date.now() - startedAt)}ms`,
      ...widgetLinesForLane(lanes.intent.role, lanes.intent),
      "",
      ...widgetLinesForLane(lanes.execution.role, lanes.execution),
    ];
  };

  const bestEffort = (action: () => void): void => {
    try {
      action();
    } catch {
      // Progress is observability only. It must never make compaction fail on a
      // host/client that lacks, ignores, or rejects a particular UI surface.
    }
  };

  const publish = (force = false): void => {
    if (closed) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < MIN_EMIT_INTERVAL_MS) return;
    lastEmitAt = now;
    const payload = buildPayload(true);

    // Extension-to-extension consumers can subscribe when running in-process.
    bestEffort(() => params.pi.events.emit(COMPACTION_PROGRESS_EVENT, payload));

    // Vanilla Pi RPC serializes setStatus/setWidget as extension_ui_request JSONL
    // events, so an external client such as PiTTy can consume these without a Pi fork.
    // Keep statusText machine-readable in RPC mode; interactive mode gets a concise status.
    if (params.ctx.mode === "rpc") {
      bestEffort(() => params.ctx.ui.setStatus(COMPACTION_PROGRESS_STATUS_KEY, JSON.stringify(payload)));
    } else {
      const a = payload.lanes.intent;
      const b = payload.lanes.execution;
      bestEffort(() =>
        params.ctx.ui.setStatus(
          COMPACTION_PROGRESS_STATUS_KEY,
          `Compacting · ${a.role} ${a.chars.toLocaleString()} chars · ${b.role} ${b.chars.toLocaleString()} chars · ${payload.elapsedMs}ms`,
        ),
      );
      bestEffort(() => params.ctx.ui.setWidget(COMPACTION_PREVIEW_WIDGET_KEY, renderWidget(), { placement: "aboveEditor" }));
    }
  };

  // Emit an immediately visible/machine-readable starting frame.
  publish(true);

  const markTerminal = (nextPhase: ProgressPhase, error?: string): void => {
    phase = nextPhase;
    terminalError = error;
    publish(true);
  };

  return {
    runId,
    laneStart(lane) {
      const state = lanes[lane];
      state.state = "streaming";
      state.startedAtMs ??= Date.now();
      phase = "streaming";
      publish(true);
    },
    laneDelta(lane, delta) {
      if (!delta) return;
      const state = lanes[lane];
      state.text += delta;
      state.pendingDelta += delta;
      publish(false);
    },
    laneDone(lane, finalText) {
      const state = lanes[lane];
      // Non-streaming fallback still exposes the completed lane as one final chunk.
      if (finalText && !state.text) {
        state.text = finalText;
        state.pendingDelta += finalText;
      }
      state.state = "done";
      state.finishedAtMs = Date.now();
      publish(true);
    },
    laneError(lane, error) {
      const state = lanes[lane];
      state.state = "error";
      state.finishedAtMs = Date.now();
      terminalError = error;
      publish(true);
    },
    merging() {
      phase = "merging";
      publish(true);
    },
    complete() {
      markTerminal("complete");
    },
    fail(error) {
      markTerminal("error", error);
    },
    abort() {
      markTerminal("aborted");
    },
    clear() {
      if (closed) return;
      // Flush any final pending delta before clearing the UI surfaces.
      publish(true);
      closed = true;
      bestEffort(() => params.ctx.ui.setStatus(COMPACTION_PROGRESS_STATUS_KEY, undefined));
      bestEffort(() => params.ctx.ui.setWidget(COMPACTION_PREVIEW_WIDGET_KEY, undefined, { placement: "aboveEditor" }));
    },
  };
}
