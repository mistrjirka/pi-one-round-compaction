import fs from "node:fs";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {renderHistory,decisionReceipts,STATE_SYSTEM,STATE_INSTRUCTION,stateSchema,READER_SYSTEM,READER_PROMPT} from "./context-strategies.mjs";
const caseName=process.argv[2]||"cron";
const selected=process.argv[3]||"all";
const version=process.argv[4]||"v3";
if(!["v1","v2","v3","v4"].includes(version))throw Error("unknown version");
if(!["all","controls","joint","rounds","recent"].includes(selected))throw Error("unknown mode");
if(!["cron","review"].includes(caseName))throw Error("unknown case");
const dir="eval/private/continuation-"+version+"/"+caseName;fs.mkdirSync(dir,{recursive:true});
const fixture=JSON.parse(fs.readFileSync("eval/private/"+(caseName==="cron"?"real":"review")+"-session-normalized.json","utf8"));
const messages=fixture.messages;
const records=[];
async function request(name,system,prompt,{schema,seed=42}={}){
 if(schema && version!=="v1")system += "\nUse exactly this JSON schema, including its field names and allowed statuses:\n"+JSON.stringify(schema);
 const path=dir+"/"+name+".json";
 const thinking=!schema||["v1","v2"].includes(version);
 const body={model:"ornith-compaction-eval",messages:[{role:"system",content:system},{role:"user",content:prompt}],
 max_tokens:6144,seed,cache_prompt:false,chat_template_kwargs:{enable_thinking:thinking},reasoning_budget_tokens:thinking?2048:0,
 ...(schema&&version==="v1"?{response_format:{type:"json_schema",json_schema:{name:"work_state",strict:true,schema}}}:{})};
 const requestSettings={...body};delete requestSettings.messages;
 if(fs.existsSync(path)){
  const stored=JSON.parse(fs.readFileSync(path,"utf8"));
  assert.equal(stored.prompt,prompt,"Cached prompt differs: "+path);
  assert.equal(stored.system,system,"Cached system differs: "+path);
  assert.deepEqual(stored.requestSettings,requestSettings,"Cached settings differ: "+path);
  if(stored.metrics.httpStatus!==200)throw Error("Recorded request failed: "+path);
  records.push(stored.metrics);return stored;
 }
 const started=performance.now();
 const response=await fetch("http://127.0.0.1:18473/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(480000)});
 const data=await response.json();
 const choice=data.choices?.[0];
 const metrics={name,case:caseName,wallMs:performance.now()-started,inputChars:prompt.length,usage:data.usage,
  finish:choice?.finish_reason,outputChars:choice?.message?.content?.length??0,httpStatus:response.status,seed};
 const stored={system,prompt,requestSettings,data,metrics};
 fs.writeFileSync(path,JSON.stringify(stored,null,2));
 records.push(metrics);console.log(JSON.stringify(metrics));
 if(!response.ok)throw Error("HTTP "+response.status);
 return stored;
}
function answer(r){
 const c=r.data.choices?.[0];
 if(c?.finish_reason!=="stop" || !c.message?.content)throw Error("Unusable answer: "+r.metrics.name+" "+c?.finish_reason);
 return c.message.content;
}
const contexts={full:renderHistory(messages),masked:renderHistory(messages,{mask:true})};
// Freeze contexts before inference; no gold answers enter this process.
for(const [name,context] of Object.entries(contexts))fs.writeFileSync(dir+"/context-"+name+".txt",context);
const receipts=decisionReceipts(messages);fs.writeFileSync(dir+"/decision-receipts.txt",receipts);
if(selected==="controls"||selected==="all"){
 for(const name of ["full","masked"]){
  const r=await request("reader-"+name,READER_SYSTEM,contexts[name]+"\n\n"+READER_PROMPT);
  fs.writeFileSync(dir+"/reader-"+name+".md",answer(r));
 }
}
if(selected==="joint"||selected==="all"){
 let previous;let start=0;
 const boundaries=caseName==="cron"?[143,144,151]:[33,73,91,150,151,156];
 for(const [round,end] of boundaries.entries()){
  const prompt=STATE_INSTRUCTION+(version==="v4"?"\n\nSource decision receipts retained outside recursive summarization:\n"+decisionReceipts(messages.slice(0,end)):"")+"\n\n"+(previous?"Previous checkpoint:\n"+JSON.stringify(previous)+"\n\n":"")+"New source history:\n"+renderHistory(messages.slice(start,end),{offset:start,mask:true});
  const r=await request("compact-"+round,STATE_SYSTEM,prompt,{schema:stateSchema});
  previous=JSON.parse(execFileSync("python3",["eval/validate-checkpoint.py",String(end)],{input:answer(r),encoding:"utf8"}));
  if(!Array.isArray(previous.work)||previous.work.some(item=>!Array.isArray(item.source_ids)||item.source_ids.some(id=>!Number.isInteger(id)||id<0||id>=end)))throw Error("Out-of-range evidence IDs");
  fs.writeFileSync(dir+"/checkpoint-"+round+".json",JSON.stringify(previous,null,2)+"\n");start=end;
 }
 contexts.joint=JSON.stringify(previous,null,2);
 contexts["joint-receipts"]=contexts.joint+"\n\n"+receipts;
 for(const name of ["joint","joint-receipts"]){
  fs.writeFileSync(dir+"/context-"+name+".txt",contexts[name]);
  const r=await request("reader-"+name,READER_SYSTEM,contexts[name]+"\n\n"+READER_PROMPT);
  fs.writeFileSync(dir+"/reader-"+name+".md",answer(r));
 }
}
if(selected==="rounds"){
 const files=fs.readdirSync(dir).filter(f=>/^checkpoint-\d+\.json$/.test(f)).sort();
 for(const file of files.slice(0,-1)){
  const round=file.match(/\d+/)[0];
  const state=JSON.parse(fs.readFileSync(dir+"/"+file,"utf8"));
  const r=await request("reader-joint-round-"+round,READER_SYSTEM,JSON.stringify(state,null,2)+"\n\n"+READER_PROMPT);
  fs.writeFileSync(dir+"/reader-joint-round-"+round+".md",answer(r));
 }
}

if(selected==="recent"){
 const priorRound=caseName==="cron"?1:4;
 const start=caseName==="cron"?144:151;
 const state=fs.readFileSync(dir+"/checkpoint-"+priorRound+".json","utf8");
 const context="Checkpoint before the latest source chunk:\n"+state+"\n\nRecent source messages, retained verbatim:\n"+renderHistory(messages.slice(start),{offset:start});
 fs.writeFileSync(dir+"/context-joint-recent.txt",context);
 const r=await request("reader-joint-recent",READER_SYSTEM,context+"\n\n"+READER_PROMPT);
 fs.writeFileSync(dir+"/reader-joint-recent.md",answer(r));
}
