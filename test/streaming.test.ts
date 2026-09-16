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

function finalMessage(text: string, responseModel = model) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: responseModel.api,
    provider: responseModel.provider,
    model: responseModel.id,
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

test("runLane sends OpenCode session routing headers through direct provider streaming", async () => {
  const openCodeModel = {
    ...model,
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  let streamedOptions: {
    sessionId?: string;
    headers?: Record<string, string | null>;
  } | undefined;

  const provider = {
    stream(
      _requestModel: unknown,
      _context: unknown,
      options: { sessionId?: string; headers?: Record<string, string | null> },
    ) {
      streamedOptions = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", message: finalMessage("routed", openCodeModel) };
        },
      };
    },
  };

  const ctx = {
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return providerId === openCodeModel.provider && modelId === openCodeModel.id ? openCodeModel : undefined;
      },
      getProvider(providerId: string) {
        return providerId === openCodeModel.provider ? provider : undefined;
      },
      async getApiKeyAndHeaders() {
        return {
          ok: true as const,
          apiKey: "test-key",
          headers: { "X-Test": "preserved", "X-OpenCode-Session": "stale" },
        };
      },
      async complete() {
        throw new Error("complete fallback should not be used");
      },
    },
  };

  await runLane({
    lane: "execution",
    config: { ...laneConfig, model: `${openCodeModel.provider}/${openCodeModel.id}` },
    prompt: "checkpoint",
    systemPrompt: "system",
    ctx: ctx as never,
    signal: new AbortController().signal,
    onTextDelta: () => {},
  });

  assert.ok(streamedOptions);
  assert.ok(streamedOptions.sessionId);
  assert.equal(streamedOptions.headers?.["x-opencode-session"], streamedOptions.sessionId);
  assert.equal(streamedOptions.headers?.["x-opencode-client"], "pi");
  assert.equal(streamedOptions.headers?.["X-Test"], "preserved");
  assert.equal(streamedOptions.headers?.["X-OpenCode-Session"], undefined);
});

test("runLane sends OpenCode session routing headers through ModelRegistry.complete fallback", async () => {
  const openCodeModel = {
    ...model,
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  let completionOptions: {
    sessionId?: string;
    headers?: Record<string, string | null>;
  } | undefined;

  const ctx = {
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return providerId === openCodeModel.provider && modelId === openCodeModel.id ? openCodeModel : undefined;
      },
      async complete(
        _requestModel: unknown,
        _context: unknown,
        options: { sessionId?: string; headers?: Record<string, string | null> },
      ) {
        completionOptions = options;
        return finalMessage("fallback routed", openCodeModel);
      },
    },
  };

  await runLane({
    lane: "execution",
    config: { ...laneConfig, model: `${openCodeModel.provider}/${openCodeModel.id}` },
    prompt: "checkpoint",
    systemPrompt: "system",
    ctx: ctx as never,
    signal: new AbortController().signal,
  });

  assert.ok(completionOptions);
  assert.ok(completionOptions.sessionId);
  assert.equal(completionOptions.headers?.["x-opencode-session"], completionOptions.sessionId);
  assert.equal(completionOptions.headers?.["x-opencode-client"], "pi");
});
