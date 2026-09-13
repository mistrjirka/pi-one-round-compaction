// Audit transport visibility only. No model calls and no historical tool execution.
import fs from "node:fs";
import { serializeIntentView, serializeExecutionView } from "../src/core.ts";
const fixture=JSON.parse(fs.readFileSync("eval/private/review-session-normalized.json","utf8"));
const rows=fixture.messages.flatMap((m,index)=>{
 if(m.role!=="toolResult" || m.toolName!=="question") return [];
 const text=m.content.filter(p=>p.type==="text").map(p=>p.text).join("\n");
 return [{
  index,tool:m.toolName,sourceChars:text.length,
  isolatedIntentChars:serializeIntentView([m]).length,
  isolatedExecutionChars:serializeExecutionView([m],2000,0).length,
  includedByReplayUserLedger:m.role==="user",
  // Exact output presence is separate from possible later assistant paraphrases.
  exactAnswerPresentInIntentPrefix:serializeIntentView(fixture.messages.slice(0,150)).includes(text)
 }];
});
const result={source:fixture.source,sourceSha256:fixture.sha256,rows,
 caveat:"This audits the archived OpenCode-to-Pi replay. Direct answers in question tool results reach the execution view but not the intent view or user-only replay ledger. Later assistant paraphrases can preserve some meaning; this is not proof all information was lost, nor a verified bug in the user's native Pi question adapter."};
fs.writeFileSync("eval/results/retention-visibility.json",JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
