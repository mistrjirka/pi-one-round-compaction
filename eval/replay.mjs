import fs from "node:fs";
import {serializeIntentView,serializeExecutionView,buildLanePrompt,protectLaneAnchor,deterministicMerge,emptyUsageForTests} from "../src/core.ts";
import {COMPACTION_SYSTEM_PROMPT,INTENT_LANE_PROMPT,EXECUTION_LANE_PROMPT} from "../src/prompts.ts";
const caseName=process.argv[2] || "cron";
const variant=process.argv[3] || "baseline";
const fixture=JSON.parse(fs.readFileSync("eval/private/"+(caseName==="cron"?"real":"review")+"-session-normalized.json","utf8"));
const messages=fixture.messages;
const approval=messages.findIndex(m=>m.role==="user" && String(m.content).includes(caseName==="cron"?"I am picking 1":"tbat is my main target"));
const outDir="eval/private/"+caseName+"-"+variant;
fs.mkdirSync(outDir,{recursive:true});
const budgets={intentWorkflowChars:8000,gitStateChars:4000,editedFilesChars:6000,readFilesChars:1000,userMessagesChars:16000,userArtifactReferencesChars:4000};
function state(end){
 return {readFiles:[],modifiedFiles:[],traceReadFiles:[],traceEditedFiles:[],
 userMessages:messages.slice(0,end).filter(m=>m.role==="user").map(m=>({timestamp:m.timestamp,text:m.content.slice(0,2000),originalChars:m.content.length,trimmed:m.content.length>2000}))};
}
async function lane(name,history,previous,det){
 let prompt=buildLanePrompt({lane:name,lanePrompt:name==="intent"?INTENT_LANE_PROMPT:EXECUTION_LANE_PROMPT,serializedConversation:name==="intent"?serializeIntentView(history):serializeExecutionView(history,variant==="masked"?200:2000,0),previousSummary:previous,deterministic:det,renderBudgets:budgets,isSplitTurn:false});
 if(variant==="refresh") prompt += "\n\n## Output contract\nReturn a freshly updated checkpoint using ONLY the requested lane headings, each exactly once. Do not reproduce input wrapper sections, the old checkpoint, or the user ledger. New evidence must update every affected section, especially the continuation anchor: do not preserve a pending implementation or old mode blocker after evidence shows it was performed. Preserve still-unverified checks separately. Only report commits, test names, test counts, coverage, or PASS when directly present in the supplied evidence; otherwise use unknown or NOT RUN. Distinguish assistant claims from tool-confirmed results. Resolve contradictions instead of carrying both versions. Keep each fact once.";
 const start=performance.now();
 const response=await fetch("http://127.0.0.1:18473/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"ornith-compaction-eval",messages:[{role:"system",content:COMPACTION_SYSTEM_PROMPT},{role:"user",content:prompt}],max_tokens:(name==="intent"?3072:6144)+(variant==="thinking"?1024:0),...(variant==="thinking"?{chat_template_kwargs:{enable_thinking:true},reasoning_budget_tokens:1024}:{}),seed:42,cache_prompt:false}),signal:AbortSignal.timeout(300000)});
 const data=await response.json(); if(!response.ok)throw Error(JSON.stringify(data));
 fs.writeFileSync(outDir+"/"+roundTag+"-"+name+"-raw.json",JSON.stringify({prompt,data},null,2));
 const choice=data.choices[0]; if(choice.finish_reason!=="stop")throw Error("Incomplete lane "+choice.finish_reason);
 const result=protectLaneAnchor({lane:name,text:choice.message.content,usage:emptyUsageForTests(),model:"ornith-compaction-eval",thinkingLevel:variant==="thinking"?"low":"off",durationMs:performance.now()-start},name);
 return {result,metrics:{inputChars:prompt.length,usage:data.usage,durationMs:result.durationMs,finishReason:choice.finish_reason},prompt};
}
let previous;let start=0;const records=[];let roundTag="";
for(const [name,end] of [["before-approval",approval],["after-approval",approval+1],["after-implementation",messages.length]]){
 roundTag=name;
 const t=performance.now(); const det=state(end);
 const results=await Promise.all(["intent","execution"].map(n=>lane(n,messages.slice(start,end),previous,det)));
 previous=deterministicMerge({intent:results[0].result,execution:results[1].result,deterministic:det,renderBudgets:budgets,isSplitTurn:false});
 fs.writeFileSync(outDir+"/"+name+".md",previous);
 fs.writeFileSync(outDir+"/"+name+".json",JSON.stringify(results,null,2));
 const row={name,start,end,wallMs:performance.now()-t,summaryChars:previous.length,lanes:results.map(r=>r.metrics)};
 records.push(row);fs.writeFileSync("eval/results/"+caseName+"-"+variant+"-metrics.json",JSON.stringify({source:fixture.source,sha256:fixture.sha256,model:"/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-A3B-AD-Q6_K-Q5_K.gguf",reasoning:variant==="thinking"?"1024-token budget":"off",mtp:false,seed:42,records},null,2));
 console.log(JSON.stringify(row));start=end;
}
