import { readFile } from "node:fs/promises";
import path from "node:path";

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface LaneConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface OneRoundCompactionConfig {
  enabled: boolean;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  toolResultChars: number;
  thinkingChars: number;
  recentControlChars: number;
  userMessageChars: number;
  userArtifactThresholdChars: number;
  userArtifactPreviewChars: number;
  userArtifactCandidateChars: number;
  userArtifactReferenceChars: number;
  targetPostCompactTokens: number;
  intentWorkflowChars: number;
  gitStateChars: number;
  editedFilesChars: number;
  readFilesChars: number;
  includeGitState: boolean;
  preflightAutoCompact: boolean;
  fallbackToNative: boolean;
  lanes: {
    intent: LaneConfig;
    execution: LaneConfig;
  };
}

export const DEFAULT_CONFIG: OneRoundCompactionConfig = {
  enabled: true,
  model: "opencode-go/muse-spark-1.2-contributor",
  thinkingLevel: "low",
  maxOutputTokens: 6144,
  toolResultChars: 2000,
  thinkingChars: 0,
  recentControlChars: 16000,
  userMessageChars: 2000,
  userArtifactThresholdChars: 8000,
  userArtifactPreviewChars: 600,
  userArtifactCandidateChars: 12000,
  userArtifactReferenceChars: 4000,
  targetPostCompactTokens: 40000,
  intentWorkflowChars: 8000,
  gitStateChars: 4000,
  editedFilesChars: 6000,
  readFilesChars: 1000,
  includeGitState: true,
  preflightAutoCompact: true,
  fallbackToNative: false,
  lanes: {
    intent: { maxOutputTokens: 3072 },
    execution: {},
  },
};

const GLOBAL_CONFIG_NAME = "one-round-compaction.json";
const PROJECT_CONFIG_PATH = path.join(".pi", GLOBAL_CONFIG_NAME);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function parseBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function parseString(value: unknown, key: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function parseThinkingLevel(value: unknown, key: string, fallback: ThinkingLevel): ThinkingLevel {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`${key} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevel;
}

function parseLane(value: unknown, key: string): LaneConfig {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`${key} must be an object`);
  const allowed = new Set(["model", "thinkingLevel", "maxOutputTokens"]);
  for (const actual of Object.keys(value)) {
    if (!allowed.has(actual)) throw new Error(`Unknown ${key} key: ${actual}`);
  }

  const lane: LaneConfig = {};
  if (value.model !== undefined) lane.model = parseString(value.model, `${key}.model`, "");
  if (value.thinkingLevel !== undefined) {
    lane.thinkingLevel = parseThinkingLevel(value.thinkingLevel, `${key}.thinkingLevel`, "low");
  }
  if (value.maxOutputTokens !== undefined) {
    lane.maxOutputTokens = parsePositiveInt(value.maxOutputTokens, `${key}.maxOutputTokens`, 1);
  }
  return lane;
}

export function parseConfig(value: unknown, base: OneRoundCompactionConfig = DEFAULT_CONFIG): OneRoundCompactionConfig {
  if (!isObject(value)) throw new Error("one-round-compaction config must be an object");
  const allowed = new Set([
    "enabled",
    "model",
    "thinkingLevel",
    "maxOutputTokens",
    "toolResultChars",
    "thinkingChars",
    "recentControlChars",
    "userMessageChars",
    "userArtifactThresholdChars",
    "userArtifactPreviewChars",
    "userArtifactCandidateChars",
    "userArtifactReferenceChars",
    "targetPostCompactTokens",
    "intentWorkflowChars",
    "gitStateChars",
    "editedFilesChars",
    "readFilesChars",
    "includeGitState",
    "preflightAutoCompact",
    "fallbackToNative",
    "lanes",
  ]);
  for (const actual of Object.keys(value)) {
    if (!allowed.has(actual)) throw new Error(`Unknown one-round-compaction key: ${actual}`);
  }

  let lanes = base.lanes;
  if (value.lanes !== undefined) {
    if (!isObject(value.lanes)) throw new Error("lanes must be an object");
    const laneKeys = new Set(["intent", "execution"]);
    for (const actual of Object.keys(value.lanes)) {
      if (!laneKeys.has(actual)) throw new Error(`Unknown lanes key: ${actual}`);
    }
    lanes = {
      intent: { ...base.lanes.intent, ...parseLane(value.lanes.intent, "lanes.intent") },
      execution: { ...base.lanes.execution, ...parseLane(value.lanes.execution, "lanes.execution") },
    };
  }

  return {
    enabled: parseBoolean(value.enabled, "enabled", base.enabled),
    model: parseString(value.model, "model", base.model),
    thinkingLevel: parseThinkingLevel(value.thinkingLevel, "thinkingLevel", base.thinkingLevel),
    maxOutputTokens: parsePositiveInt(value.maxOutputTokens, "maxOutputTokens", base.maxOutputTokens),
    toolResultChars: parsePositiveInt(value.toolResultChars, "toolResultChars", base.toolResultChars),
    thinkingChars: parseNonNegativeInt(value.thinkingChars, "thinkingChars", base.thinkingChars),
    recentControlChars: parseNonNegativeInt(value.recentControlChars, "recentControlChars", base.recentControlChars),
    userMessageChars: parsePositiveInt(value.userMessageChars, "userMessageChars", base.userMessageChars),
    userArtifactThresholdChars: parsePositiveInt(value.userArtifactThresholdChars, "userArtifactThresholdChars", base.userArtifactThresholdChars),
    userArtifactPreviewChars: parsePositiveInt(value.userArtifactPreviewChars, "userArtifactPreviewChars", base.userArtifactPreviewChars),
    userArtifactCandidateChars: parsePositiveInt(value.userArtifactCandidateChars, "userArtifactCandidateChars", base.userArtifactCandidateChars),
    userArtifactReferenceChars: parsePositiveInt(value.userArtifactReferenceChars, "userArtifactReferenceChars", base.userArtifactReferenceChars),
    targetPostCompactTokens: parsePositiveInt(value.targetPostCompactTokens, "targetPostCompactTokens", base.targetPostCompactTokens),
    intentWorkflowChars: parsePositiveInt(value.intentWorkflowChars, "intentWorkflowChars", base.intentWorkflowChars),
    gitStateChars: parseNonNegativeInt(value.gitStateChars, "gitStateChars", base.gitStateChars),
    editedFilesChars: parseNonNegativeInt(value.editedFilesChars, "editedFilesChars", base.editedFilesChars),
    readFilesChars: parseNonNegativeInt(value.readFilesChars, "readFilesChars", base.readFilesChars),
    includeGitState: parseBoolean(value.includeGitState, "includeGitState", base.includeGitState),
    preflightAutoCompact: parseBoolean(
      value.preflightAutoCompact,
      "preflightAutoCompact",
      base.preflightAutoCompact,
    ),
    fallbackToNative: parseBoolean(value.fallbackToNative, "fallbackToNative", base.fallbackToNative),
    lanes,
  };
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<{
  config: OneRoundCompactionConfig;
  globalPath: string;
  projectPath?: string;
}> {
  const globalPath = path.join(getAgentDir(), GLOBAL_CONFIG_NAME);
  let config = DEFAULT_CONFIG;
  const globalValue = await readJsonIfPresent(globalPath);
  if (globalValue !== undefined) config = parseConfig(globalValue, config);

  const projectPath = path.join(ctx.cwd, PROJECT_CONFIG_PATH);
  if (ctx.isProjectTrusted()) {
    const projectValue = await readJsonIfPresent(projectPath);
    if (projectValue !== undefined) config = parseConfig(projectValue, config);
  }

  return {
    config,
    globalPath,
    ...(ctx.isProjectTrusted() ? { projectPath } : {}),
  };
}

export function resolveLaneConfig(config: OneRoundCompactionConfig, lane: "intent" | "execution") {
  const override = config.lanes[lane];
  return {
    model: override.model ?? config.model,
    thinkingLevel: override.thinkingLevel ?? config.thinkingLevel,
    maxOutputTokens: override.maxOutputTokens ?? config.maxOutputTokens,
  };
}
