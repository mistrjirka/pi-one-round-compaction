import assert from "node:assert/strict";
import test from "node:test";
import { protectLaneAnchor, emptyUsageForTests } from "../src/core.js";

for (const text of [
  "## Done\nImplementation is not complete. Validation is NOT RUN.",
  "## Done\nThe parser returns COMPLETE for incomplete work.",
  "## Done\nBuild complete; mandatory review still pending.",
  "## Done\nHistorical task:\nCOMPLETE\nCurrent task is blocked.",
]) {
  test("execution never infers completion from incidental text: " + text, () => {
    const result = protectLaneAnchor({
      lane: "execution", text, usage: emptyUsageForTests(),
      model: "test", thinkingLevel: "low", durationMs: 0,
    }, "execution");
    assert.match(result.text, /^## Continuation Anchor\nUNKNOWN/);
  });
}
