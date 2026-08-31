import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateIncomingPromptTokens,
  getPreflightProjection,
  projectionExceedsContext,
} from "../src/preflight.js";

test("preflight uses Pi's chars/4 estimator and triggers only above context", () => {
  assert.equal(estimateIncomingPromptTokens("x".repeat(12_000)), 3_000);

  const projection = getPreflightProjection(
    { getContextUsage: () => ({ tokens: 270_000, contextWindow: 272_000, percent: 0 }) },
    "x".repeat(12_000),
  );
  assert.ok(projection);
  assert.equal(projection.projectedTokens, 273_000);
  assert.equal(projectionExceedsContext(projection), true);

  const exact = getPreflightProjection(
    { getContextUsage: () => ({ tokens: 270_000, contextWindow: 272_000, percent: 0 }) },
    "x".repeat(8_000),
  );
  assert.ok(exact);
  assert.equal(exact.projectedTokens, 272_000);
  assert.equal(projectionExceedsContext(exact), false);
});

test("preflight skips when Pi reports post-compaction usage as unknown", () => {
  assert.equal(
    getPreflightProjection(
      { getContextUsage: () => ({ tokens: null, contextWindow: 272_000, percent: null }) },
      "hello",
    ),
    undefined,
  );
});
