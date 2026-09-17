// Audit transport visibility only. No model calls and no historical tool execution.
import fs from "node:fs";
import { serializeExecutionView } from "../src/core.ts";

const fixture = JSON.parse(fs.readFileSync("eval/private/review-session-normalized.json", "utf8"));
const prefixView = serializeExecutionView(fixture.messages.slice(0, 150), 2000, 0);
const rows = fixture.messages.flatMap((m, index) => {
  if (m.role !== "toolResult" || m.toolName !== "question") return [];
  const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const isolatedChars = serializeExecutionView([m], 2000, 0).length;
  return [{
    index,
    tool: m.toolName,
    sourceChars: text.length,
    isolatedAuditChars: isolatedChars,
    isolatedExecutionChars: isolatedChars,
    includedByReplayUserLedger: m.role === "user",
    exactAnswerPresentInAuditPrefix: prefixView.includes(text),
    exactAnswerPresentInExecutionPrefix: prefixView.includes(text),
  }];
});
const result = {
  source: fixture.source,
  sourceSha256: fixture.sha256,
  rows,
  caveat: "This audits the archived OpenCode-to-Pi replay. In v0.4 both LLM lanes receive the evidence view, so question-tool results are visible to both as tool evidence; they are not promoted to native human-user authority. This is not proof of behavior in the user's native Pi question adapter.",
};
fs.writeFileSync("eval/results/retention-visibility.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
