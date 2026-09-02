import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, parseConfig, resolveLaneConfig } from "../src/config.js";

test("defaults use Muse Spark with a stronger continuation/intent lane", () => {
  assert.equal(DEFAULT_CONFIG.model, "opencode-go/muse-spark-1.2-contributor");
  assert.equal(DEFAULT_CONFIG.thinkingLevel, "low");
  assert.equal(resolveLaneConfig(DEFAULT_CONFIG, "intent").thinkingLevel, "medium");
  assert.equal(resolveLaneConfig(DEFAULT_CONFIG, "execution").thinkingLevel, "low");
  assert.equal(DEFAULT_CONFIG.thinkingChars, 0);
  assert.equal(DEFAULT_CONFIG.preflightAutoCompact, true);
  assert.equal(DEFAULT_CONFIG.targetPostCompactTokens, 40_000);
  assert.equal(DEFAULT_CONFIG.userMessageChars, 2_000);
  assert.equal(DEFAULT_CONFIG.userArtifactThresholdChars, 8_000);
  assert.equal(DEFAULT_CONFIG.userArtifactPreviewChars, 600);
  assert.equal(DEFAULT_CONFIG.userArtifactCandidateChars, 12_000);
  assert.equal(DEFAULT_CONFIG.userArtifactReferenceChars, 4_000);
  assert.equal(DEFAULT_CONFIG.intentWorkflowChars, 8_000);
  assert.equal(DEFAULT_CONFIG.gitStateChars, 4_000);
  assert.equal(DEFAULT_CONFIG.editedFilesChars, 6_000);
  assert.equal(DEFAULT_CONFIG.readFilesChars, 1_000);
});

test("project-style overrides merge lanes", () => {
  const config = parseConfig({
    thinkingLevel: "minimal",
    toolResultChars: 1500,
    lanes: {
      execution: { thinkingLevel: "medium", maxOutputTokens: 4096 },
    },
  });
  assert.equal(resolveLaneConfig(config, "intent").thinkingLevel, "medium");
  assert.equal(resolveLaneConfig(config, "execution").thinkingLevel, "medium");
  assert.equal(resolveLaneConfig(config, "execution").maxOutputTokens, 4096);
  assert.equal(config.toolResultChars, 1500);
});

test("unknown keys fail closed", () => {
  assert.throws(() => parseConfig({ template: "x.md" }), /Unknown one-round-compaction key: template/);
});

test("zero is accepted for optional retained text budgets", () => {
  const config = parseConfig({ thinkingChars: 0, recentControlChars: 0 });
  assert.equal(config.thinkingChars, 0);
  assert.equal(config.recentControlChars, 0);
});
