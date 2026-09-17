import fs from "node:fs";
import { COMPACTION_SYSTEM_PROMPT } from "../src/prompts.ts";
import { protectLaneAnchor, emptyUsageForTests } from "../src/core.ts";

const t = performance.now();
const rows = await Promise.all(["audit", "execution"].map(async (lane) => {
  const { prompt } = JSON.parse(fs.readFileSync(`eval/private/cron-thinking/after-implementation-${lane}-raw.json`, "utf8"));
  const start = performance.now();
  const response = await fetch("http://127.0.0.1:18473/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "ornith-compaction-eval",
      messages: [
        { role: "system", content: COMPACTION_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget_tokens: -1,
      max_tokens: 12288,
      seed: 42,
      cache_prompt: false,
    }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await response.json();
  fs.writeFileSync(`eval/private/natural-final-${lane}.json`, JSON.stringify({ prompt, data }, null, 2));
  if (!response.ok) throw Error(JSON.stringify(data));
  const c = data.choices[0];
  let rejected;
  try {
    protectLaneAnchor({
      lane,
      text: c.message.content,
      usage: emptyUsageForTests(),
      model: "test",
      thinkingLevel: "low",
      durationMs: 0,
    }, lane);
  } catch (error) {
    rejected = error.message;
  }
  return {
    lane,
    durationMs: performance.now() - start,
    usage: data.usage,
    finishReason: c.finish_reason,
    reasoningChars: c.message.reasoning_content?.length ?? 0,
    textChars: c.message.content?.length ?? 0,
    duplicateSectionRejection: rejected ?? null,
    validLane: c.finish_reason === "stop" && Boolean(c.message.content) && !rejected,
  };
}));
const metrics = { wallMs: performance.now() - t, reasoning: "natural, no forced cutoff", maxTokens: 12288, rows };
fs.writeFileSync("eval/results/natural-final-metrics.json", JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
