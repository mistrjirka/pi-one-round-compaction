import assert from "node:assert/strict";
import test from "node:test";

import { readLiveSubagentRoster, renderLiveSubagentRoster, SUBAGENT_ROSTER_CHANNEL } from "../src/subagent-roster.js";

test("reads a synchronous in-process roster without requiring transcript I/O", () => {
  const roster = readLiveSubagentRoster({
    emit(channel, value) {
      assert.equal(channel, SUBAGENT_ROSTER_CHANNEL);
      (value as { respond: (snapshot: unknown) => void }).respond({
        v: 1,
        total: 3,
        agents: [
          { id: "sage", label: "Implementer", description: "Cache\n invalidation", state: "running" },
          { id: "kim", label: "Reviewer", description: "Check tests", state: "waiting" },
          { id: "bad/uuid", label: "Not trusted", description: "Invalid id", state: "running" },
        ],
      });
    },
  });
  assert.deepEqual(roster?.agents.map((agent) => agent.id), ["sage", "kim"]);
  assert.equal(roster?.total, 3);
  assert.equal(roster.agents[0]?.description, "Cache invalidation");
});

test("missing, invalid, or broken event consumers do not block compaction", () => {
  assert.equal(readLiveSubagentRoster({ emit() {} }), undefined);
  assert.equal(readLiveSubagentRoster({ emit() { throw new Error("extension unavailable"); } }), undefined);
  assert.equal(readLiveSubagentRoster({ emit(_channel, payload) { (payload as { respond: (x: unknown) => void }).respond({ v: 1, total: 2, agents: [{ id: "wrong/id", state: "running" }] }); } }), undefined);
});

test("rendering respects a hard character limit and never clips a worker name", () => {
  const roster = {
    total: 3,
    agents: [
      { id: "kim", state: "waiting" as const, label: "Review", description: "Review the build and tests" },
      { id: "sage", state: "running" as const, label: "Implementer", description: "Fix cache invariants" },
      { id: "leo", state: "idle" as const, label: "Explorer", description: "Find alternatives" },
    ],
  };
  const full = renderLiveSubagentRoster(roster, 4_000);
  assert.match(full, /@kim \[waiting\]/);
  assert.match(full, /@sage \[running\]/);
  assert.match(full, /@leo \[idle\]/);
  assert.equal(renderLiveSubagentRoster(roster, 0), "");
  for (let maxChars = 1; maxChars <= 500; maxChars++) {
    const text = renderLiveSubagentRoster(roster, maxChars);
    assert.ok(text.length <= maxChars);
    if (text) {
      assert.match(text, /@kim \[waiting\]/);
      assert.doesNotMatch(text, /@\w+\s*$/);
    }
  }
});
