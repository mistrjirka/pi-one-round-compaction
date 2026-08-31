import assert from "node:assert/strict";
import test from "node:test";

import { emptyUsageForTests, runLane } from "../src/core.js";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses" as const,
  provider: "test-provider",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function finalMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsageForTests(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

const laneConfig = {
  model: `${model.provider}/${model.id}`,
  thinkingLevel: "low" as const,
  maxOutputTokens: 2048,
};

test("runLane observes provider text deltas when vanilla Pi exposes provider/auth accessors", async () => {
  const deltas: string[] = [];
  let completeCalled = false;
  let streamCalled = false;

  const provider = {
    stream() {
      streamCalled = true;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: "hello " };
          yield { type: "text_delta", delta: "world" };
          yield { type: "done", message: finalMessage("hello world") };
        },
      };
    },
  };

  const ctx = {
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return providerId === model.provider && modelId === model.id ? model : undefined;
      },
      getProvider(providerId: string) {
        return providerId === model.provider ? provider : undefined;
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "test-key" };
      },
      async complete() {
        completeCalled = true;
        throw new Error("complete fallback should not be used");
      },
    },
  };

  const result = await runLane({
    lane: "intent",
    config: laneConfig,
    prompt: "checkpoint",
    systemPrompt: "system",
    ctx: ctx as never,
    signal: new AbortController().signal,
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(streamCalled, true);
  assert.equal(completeCalled, false);
  assert.equal(deltas.join(""), "hello world");
  assert.equal(result.text, "hello world");
  assert.equal(result.model, `${model.provider}/${model.id}`);
});

test("runLane falls back to ModelRegistry.complete when streaming accessors are unavailable", async () => {
  let completeCalled = false;
  const ctx = {
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return providerId === model.provider && modelId === model.id ? model : undefined;
      },
      async complete() {
        completeCalled = true;
        return finalMessage("fallback checkpoint");
      },
    },
  };

  const result = await runLane({
    lane: "execution",
    config: laneConfig,
    prompt: "checkpoint",
    systemPrompt: "system",
    ctx: ctx as never,
    signal: new AbortController().signal,
    onTextDelta: () => {
      throw new Error("fallback completion must not synthesize deltas");
    },
  });

  assert.equal(completeCalled, true);
  assert.equal(result.text, "fallback checkpoint");
});
