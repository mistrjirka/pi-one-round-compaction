import fs from "node:fs";
import { protectLaneAnchor } from "../src/core.ts";
const rows=[];
for(const directory of ["baseline","cron-refresh","cron-thinking","review-thinking"]){
 if(!fs.existsSync("eval/private/"+directory))continue;
 for(const file of fs.readdirSync("eval/private/"+directory).filter(f=>/^(before-approval|after-approval|after-implementation)\.json$/.test(f))){
  const lanes=JSON.parse(fs.readFileSync("eval/private/"+directory+"/"+file,"utf8"));
  for(const {result,metrics} of lanes){
   let rejected;
   try{protectLaneAnchor(result,result.lane);}catch(e){rejected=e.message;}
   rows.push({directory,checkpoint:file,lane:result.lane,chars:result.text.length,rejected:rejected??null,
    introducedKnownUnsupportedEvidence:["671624a","retry.model-not-loaded","100% coverage","All 14284 declarations","vite v7.2.4 built in 19.17s"].filter(term=>result.text.includes(term)),metrics});
  }
 }
}
fs.writeFileSync("eval/results/output-audit.json",JSON.stringify(rows,null,2));
console.log(JSON.stringify(rows.map(({metrics,...row})=>row),null,2));
