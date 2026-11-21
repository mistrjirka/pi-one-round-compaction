import assert from "node:assert/strict";
import test from "node:test";
import oneRoundCompaction from "../src/index.js";
import { isOneRoundSelected } from "../src/method-selection.js";

test("installed one-round extension leaves cache-aware compaction to the selected method", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: string[] = [];
  oneRoundCompaction({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: () => {},
  } as never);

  const ctx = {
    getCompactionMethod: () => "cache-aware",
    isIdle: () => { throw new Error("Unselected preflight must not inspect the session"); },
    ui: { notify: () => { throw new Error("Unselected compactor must not read or report its configuration"); } },
  };
  assert.equal(await handlers.get("session_before_compact")?.({ method: "cache-aware" }, ctx), undefined);
  assert.equal(await handlers.get("input")?.({ source: "rpc", text: "continue", images: [] }, ctx), undefined);
  assert.ok(tools.includes("user_artifact"), "selecting another compactor must preserve artifact recovery");
});

test("explicit method wins and legacy hosts retain their existing extension behavior", () => {
  assert.equal(isOneRoundSelected({} as never), true);
  assert.equal(isOneRoundSelected({ getCompactionMethod: () => "extension" } as never), true);
  assert.equal(isOneRoundSelected({ getCompactionMethod: () => "cache-aware" } as never), false);
  assert.equal(isOneRoundSelected({} as never, { method: "cache-aware" }), false);
  assert.equal(isOneRoundSelected({ getCompactionMethod: () => "cache-aware" } as never, { method: "extension" }), true);
});
