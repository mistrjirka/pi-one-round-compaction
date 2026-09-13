import assert from "node:assert/strict";
import test from "node:test";
import {protectLaneAnchor,emptyUsageForTests} from "../src/core.js";

for (const [role, heading] of [
  ["intent","Current Objective"],
  ["execution","Continuation Anchor"],
  ["implementation","Remaining / Immediate Next Actions"],
  ["evidence","Verification State"],
] as const) {
  test("rejects contradictory duplicated sections in " + role, () => {
    const result = {
      lane: "execution" as const,
      text: "## " + heading + "\nCurrent: finish validation.\n\n## Previous LLM checkpoint state (fallible historical state)\n## " + heading + "\nOld: implement everything again.",
      usage: emptyUsageForTests(), model: "test", thinkingLevel: "low" as const, durationMs: 0,
    };
    assert.throws(() => protectLaneAnchor(result, role), /duplicate.*section/i);
  });
}
