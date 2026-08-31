import { readFile } from "node:fs/promises";
import path from "node:path";

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  COMPACTION_SYSTEM_PROMPT,
  EXECUTION_LANE_PROMPT,
  INTENT_LANE_PROMPT,
} from "./prompts.js";

export interface PromptSet {
  system: string;
  intent: string;
  execution: string;
  sources: {
    system: string;
    intent: string;
    execution: string;
  };
}

const FILES = {
  system: "one-round-compaction-system.md",
  intent: "one-round-compaction-intent.md",
  execution: "one-round-compaction-execution.md",
} as const;

type PromptName = keyof typeof FILES;

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const text = (await readFile(filePath, "utf8")).trim();
    return text || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read prompt ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadPromptSet(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): Promise<PromptSet> {
  const builtins: Record<PromptName, string> = {
    system: COMPACTION_SYSTEM_PROMPT,
    intent: INTENT_LANE_PROMPT,
    execution: EXECUTION_LANE_PROMPT,
  };
  const values: Record<PromptName, string> = { ...builtins };
  const sources: Record<PromptName, string> = {
    system: "built-in",
    intent: "built-in",
    execution: "built-in",
  };

  for (const name of Object.keys(FILES) as PromptName[]) {
    const globalPath = path.join(getAgentDir(), FILES[name]);
    const globalText = await readTextIfPresent(globalPath);
    if (globalText !== undefined) {
      values[name] = globalText;
      sources[name] = globalPath;
    }
  }

  if (ctx.isProjectTrusted()) {
    for (const name of Object.keys(FILES) as PromptName[]) {
      const projectPath = path.join(ctx.cwd, ".pi", FILES[name]);
      const projectText = await readTextIfPresent(projectPath);
      if (projectText !== undefined) {
        values[name] = projectText;
        sources[name] = projectPath;
      }
    }
  }

  return {
    system: values.system,
    intent: values.intent,
    execution: values.execution,
    sources,
  };
}
