// Offline provenance and protocol validation. No model requests.
import fs from "node:fs";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {renderHistory,decisionReceipts,STATE_SYSTEM,STATE_INSTRUCTION,stateSchema,READER_SYSTEM,READER_PROMPT} from "./context-strategies.mjs";
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const result={date:"2026-09-13",method:"Offline input/provenance checks; schema validity does not establish semantic correctness",cases:[],records:[]};
for(const caseName of ["cron","review"]){
 const fixturePath="eval/private/"+(caseName==="cron"?"real":"review")+"-session-normalized.json";
 const fixtureText=fs.readFileSync(fixturePath,"utf8"),fixture=JSON.parse(fixtureText),messages=fixture.messages;
 const boundaries=caseName==="cron"?[143,144,151]:[33,73,91,150,151,156];
 result.cases.push({case:caseName,source:fixture.source,sourceSha256:fixture.sha256,normalizedSha256:hash(fixtureText),boundaries});
 for(const version of ["v1","v2","v3","v4"]){
  const dir="eval/private/continuation-"+version+"/"+caseName;
  if(!fs.existsSync(dir))continue;
  for(const name of fs.readdirSync(dir).filter(n=>/^(compact-|reader-).*\.json$/.test(n)).sort()){
   const text=fs.readFileSync(dir+"/"+name,"utf8"),r=JSON.parse(text),record={version,case:caseName,name:name.slice(0,-5),...r.metrics,requestArtifactSha256:hash(text),promptSha256:hash(r.prompt)};
   const compact=/^compact-(\d+)\.json$/.exec(name);
   let expectedSystem,expectedPrompt;
   if(compact){
    const round=Number(compact[1]),end=boundaries[round],start=round?boundaries[round-1]:0;
    const previous=round?JSON.parse(fs.readFileSync(dir+"/checkpoint-"+(round-1)+".json","utf8")):undefined;
    expectedSystem=STATE_SYSTEM+(version!=="v1"?"\nUse exactly this JSON schema, including its field names and allowed statuses:\n"+JSON.stringify(stateSchema):"");
    expectedPrompt=STATE_INSTRUCTION+(version==="v4"?"\n\nSource decision receipts retained outside recursive summarization:\n"+decisionReceipts(messages.slice(0,end)):"")+"\n\n"+(previous?"Previous checkpoint:\n"+JSON.stringify(previous)+"\n\n":"")+"New source history:\n"+renderHistory(messages.slice(start,end),{offset:start,mask:true});
    const response=r.data.choices?.[0];
    if(response?.finish_reason==="stop"){
     const validation=spawnSync("python3",["eval/validate-checkpoint.py",String(end)],{input:response.message.content,encoding:"utf8"});
     record.schemaValid=validation.status===0;
     if(validation.status!==0)record.validationFailure=validation.stderr.trim().split("\n").at(-1);
    } else record.schemaValid=false;
    record.cutoff=end;record.checkpointWritten=fs.existsSync(dir+"/checkpoint-"+round+".json");
   }else{
    expectedSystem=READER_SYSTEM;
    const round=/reader-joint-round-(\d+)\.json$/.exec(name);
    let context;
    if(name==="reader-full.json")context=renderHistory(messages);
    else if(name==="reader-masked.json")context=renderHistory(messages,{mask:true});
    else if(round)context=JSON.stringify(JSON.parse(fs.readFileSync(dir+"/checkpoint-"+round[1]+".json","utf8")),null,2);
    else if(name==="reader-joint-recent.json"){
     const previousRound=caseName==="cron"?1:4,start=caseName==="cron"?144:151;
     context="Checkpoint before the latest source chunk:\n"+fs.readFileSync(dir+"/checkpoint-"+previousRound+".json","utf8")+"\n\nRecent source messages, retained verbatim:\n"+renderHistory(messages.slice(start),{offset:start});
    }else if(["reader-joint.json","reader-joint-receipts.json"].includes(name)){
     context=JSON.stringify(JSON.parse(fs.readFileSync(dir+"/checkpoint-"+(boundaries.length-1)+".json","utf8")),null,2);
     if(name==="reader-joint-receipts.json")context+="\n\n"+decisionReceipts(messages);
    }else throw Error("Unrecognized reader: "+name);
    expectedPrompt=context+"\n\n"+READER_PROMPT;
   }
   if(r.system!==expectedSystem||r.prompt!==expectedPrompt)throw Error("Input differs from specified source prefix: "+dir+"/"+name);
   const thinking=!compact||["v1","v2"].includes(version);
   if(r.requestSettings.seed!==42||r.requestSettings.cache_prompt!==false||r.requestSettings.max_tokens!==6144||r.requestSettings.chat_template_kwargs.enable_thinking!==thinking||r.requestSettings.reasoning_budget_tokens!==(thinking?2048:0))throw Error("Unexpected settings: "+name);
   record.inputProvenanceVerified=true;result.records.push(record);
  }
 }
}
fs.writeFileSync("eval/results/continuation-audit.json",JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({verifiedRequests:result.records.length,compactRequests:result.records.filter(r=>r.name.startsWith("compact-")).length,schemaFailures:result.records.filter(r=>r.name.startsWith("compact-")&&!r.schemaValid).map(r=>({version:r.version,case:r.case,name:r.name,error:r.validationFailure??r.httpStatus}))},null,2));
