import assert from "node:assert/strict";
import test from "node:test";
import { protectLaneAnchor, emptyUsageForTests } from "../src/core.js";

for (const role of ["execution", "implementation", "evidence"] as const) {
  for (const text of [
    "## Done\nImplementation is not complete. Validation is NOT RUN.",
    "## Done\nThe parser returns COMPLETE for incomplete work.",
    "## Done\nBuild complete; mandatory review still pending.",
    "## Done\nHistorical task:\nCOMPLETE\nCurrent task is blocked.",
  ]) {
    test(role + " never infers completion from incidental text: " + text, () => {
      const result = protectLaneAnchor({
        lane: "execution", text, usage: emptyUsageForTests(),
        model: "test", thinkingLevel: "low", durationMs: 0,
      }, role);
      assert.match(result.text, /^## (Continuation|Evidence) Anchor\nUNKNOWN/);
    });
  }
}
