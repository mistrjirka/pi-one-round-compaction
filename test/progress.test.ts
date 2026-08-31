import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_PREVIEW_WIDGET_KEY,
  COMPACTION_PROGRESS_EVENT,
  COMPACTION_PROGRESS_STATUS_KEY,
  createProgressReporter,
  type CompactionProgressV1,
} from "../src/progress.js";

function reporterHarness() {
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const widgetCalls: Array<{ key: string; lines: string[] | undefined; placement?: string }> = [];
  const eventCalls: Array<{ channel: string; data: unknown }> = [];

  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        eventCalls.push({ channel, data });
      },
    },
  };
  const ctx = {
    mode: "rpc",
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
      },
      setWidget(key: string, lines: string[] | undefined, options?: { placement?: string }) {
        widgetCalls.push({ key, lines, ...(options?.placement ? { placement: options.placement } : {}) });
      },
    },
  };

  const reporter = createProgressReporter({
    pi: pi as never,
    ctx: ctx as never,
    mode: "normal",
    reason: "threshold",
    retainedTurns: 2,
    estimatedRetainedTokens: 1234,
    keepRecentTokens: 2048,
    boundaryMode: "whole-turn",
    roles: { intent: "intent", execution: "execution" },
  });

  return { reporter, statusCalls, widgetCalls, eventCalls };
}

test("RPC progress uses vanilla Pi setStatus/setWidget surfaces with structured progress", () => {
  const { reporter, statusCalls, widgetCalls, eventCalls } = reporterHarness();

  reporter.laneStart("intent");
  reporter.laneDelta("intent", "hello");
  reporter.laneDone("intent");
  reporter.laneStart("execution");
  reporter.laneDelta("execution", "world");
  reporter.laneDone("execution");
  reporter.merging();
  reporter.complete();
  reporter.clear();

  const frames = statusCalls
    .filter((call): call is { key: string; text: string } => typeof call.text === "string")
    .map((call) => {
      assert.equal(call.key, COMPACTION_PROGRESS_STATUS_KEY);
      return JSON.parse(call.text) as CompactionProgressV1;
    });

  assert.ok(frames.length >= 5);
  assert.equal(frames[0]?.v, 1);
  assert.equal(frames[0]?.phase, "preparing");
  assert.ok(frames.some((frame) => frame.phase === "streaming"));
  assert.ok(frames.some((frame) => frame.phase === "merging"));
  assert.ok(frames.some((frame) => frame.phase === "complete"));
  assert.ok(frames.some((frame) => frame.lanes.intent.delta === "hello"));
  assert.ok(frames.some((frame) => frame.lanes.execution.delta === "world"));
  assert.ok(frames.every((frame) => frame.retainedTurns === 2));

  assert.ok(eventCalls.length > 0);
  assert.ok(eventCalls.every((call) => call.channel === COMPACTION_PROGRESS_EVENT));

  // RPC stays compact: PiTTy consumes setStatus JSON frames instead of repeated full preview widgets.
  assert.equal(widgetCalls.some((call) => Array.isArray(call.lines)), false);
  assert.equal(statusCalls.at(-1)?.key, COMPACTION_PROGRESS_STATUS_KEY);
  assert.equal(statusCalls.at(-1)?.text, undefined);
  assert.equal(widgetCalls.at(-1)?.key, COMPACTION_PREVIEW_WIDGET_KEY);
  assert.equal(widgetCalls.at(-1)?.lines, undefined);
});

test("progress surfaces are best-effort and can never fail compaction", () => {
  const pi = {
    events: {
      emit() {
        throw new Error("event bus unavailable");
      },
    },
  };
  const ctx = {
    mode: "rpc",
    ui: {
      setStatus() {
        throw new Error("status unsupported");
      },
      setWidget() {
        throw new Error("widget unsupported");
      },
    },
  };

  assert.doesNotThrow(() => {
    const reporter = createProgressReporter({
      pi: pi as never,
      ctx: ctx as never,
      mode: "workflow",
      reason: "manual",
      retainedTurns: 1,
      estimatedRetainedTokens: 500,
      keepRecentTokens: 1000,
      boundaryMode: "whole-turn",
      intentWorkflow: { workstream: "strict-tools", hasPlan: true },
      roles: { intent: "implementation", execution: "evidence" },
    });
    reporter.laneStart("intent");
    reporter.laneDelta("intent", "partial");
    reporter.laneDone("intent");
    reporter.merging();
    reporter.complete();
    reporter.clear();
  });
});
