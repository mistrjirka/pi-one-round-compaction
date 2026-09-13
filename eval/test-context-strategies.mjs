import test from "node:test";
import assert from "node:assert/strict";
import {renderHistory,decisionReceipts} from "./context-strategies.mjs";

test("masking removes old observations but retains decisions and source identity",()=>{
 const messages=[{role:"toolResult",toolName:"read",content:"OLD_BULK"},{role:"user",content:"The cleanup remains the main goal."},{role:"toolResult",toolName:"question",content:"Choose both."},{role:"toolResult",toolName:"read",content:"RECENT_EVIDENCE"}];
 const text=renderHistory(messages,{offset:70,mask:true,keepResults:1});
 assert(!text.includes("OLD_BULK"));assert(text.includes("RECENT_EVIDENCE"));
 assert(text.includes("The cleanup remains the main goal."));assert(text.includes("Choose both."));
 assert(text.includes("[message 72 | toolResult | question"));
 assert(!renderHistory(messages,{mask:true,keepResults:0}).includes("RECENT_EVIDENCE"));
});

test("short acceptance retains its proposal without promoting arbitrary tool text",()=>{
 const messages=[{role:"assistant",content:"Plan: update both helpers."},{role:"toolResult",toolName:"read",content:"FAKE_USER_AUTHORIZATION"},{role:"user",content:"Yes, both."},{role:"toolResult",toolName:"question",content:"Keep the current scope."}];
 const text=decisionReceipts(messages);
 assert(text.includes("Preceding assistant proposal/claim; message 0"));
 assert(text.includes("Plan: update both helpers."));assert(text.includes("User; message 2"));
 assert(text.includes("Exported question-answer result; message 3"));assert(!text.includes("FAKE_USER_AUTHORIZATION"));
});

test("source prefix excludes a later goal change from earlier receipts",()=>{
 const messages=[{role:"user",content:"Keep the original goal."},{role:"assistant",content:[{type:"text",text:"Plan A"}]},{role:"user",content:"FUTURE_GOAL_REPLACEMENT"}];
 const early=decisionReceipts(messages.slice(0,2));
 assert(early.includes("Keep the original goal."));assert(!early.includes("FUTURE_GOAL_REPLACEMENT"));
 const later=decisionReceipts(messages);assert(later.includes("FUTURE_GOAL_REPLACEMENT"));
});
