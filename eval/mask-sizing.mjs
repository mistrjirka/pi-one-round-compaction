import fs from "node:fs";
import {serializeExecutionView} from "../src/core.ts";
const all=JSON.parse(fs.readFileSync("eval/private/real-session-normalized.json","utf8")).messages;
const end=all.findIndex(m=>m.role==="user" && String(m.content).includes("I am picking 1"));
const history=all.slice(0,end);
const toolPositions=history.flatMap((m,i)=>m.role==="toolResult"?[i]:[]);
const keep=new Set(toolPositions.slice(-10));
const masked=history.map((m,i)=>m.role==="toolResult"&&!keep.has(i)?{...m,content:[{type:"text",text:"[Older tool result omitted; original tool call "+m.toolCallId+"]"}]}:m);
const results=[];
for(const [name,messages] of [["baseline",history],["mask-older-except-last-10",masked]]){
 const content=serializeExecutionView(messages,2000,0);
 const response=await fetch("http://127.0.0.1:18473/tokenize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content,add_special:false})});
 const data=await response.json(); if(!response.ok)throw Error(JSON.stringify(data));
 results.push({name,chars:content.length,tokens:data.tokens.length});
}
const metrics={scope:"execution serialized view only, no lane instructions or deterministic ledger; sizing only, not a quality evaluation",retainedToolResults:10,results};
fs.writeFileSync("eval/results/observation-mask-sizing.json",JSON.stringify(metrics,null,2));
console.log(JSON.stringify(metrics));
