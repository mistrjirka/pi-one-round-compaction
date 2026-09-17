# Goal and work-state retention evaluation — 2026-09-13

> This report records experiments from before the v0.4 audit-lane migration. Historical references to the former lane names describe saved results only; current replay tooling uses work-state audit + execution.

Public data exists, but the useful target here is whether a fresh agent can continue the task correctly. Generic summary similarity does not establish that. This audit adds source-linked expected answers for two supplied sessions and checks the complete saved checkpoints against the cron case.

## Public data and suitability

| Source | Available material | Use here | Limitation |
|---|---|---|---|
| [JetBrains Complexity Trap](https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap) | Raw coding-agent trajectories accompanying masking/summarization experiments, compressed archives | Most directly relevant public context-management comparison data | Model summaries are candidate outputs, not authoritative target summaries; task-state labels still need annotation |
| [Nebius SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) | 80,036 coding trajectories, patches and final evaluation logs | Diverse public development/training material with successful and unsuccessful attempts | A final success label is not evidence available at an earlier checkpoint; do not leak future evaluation logs into compaction |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | 500 questions, histories, answers and evidence-session labels | Useful controls for updated decisions, time ordering and unknown answers | Primarily conversational memory rather than ongoing coding progress |
| [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | 451 manually curated questions over web/enterprise agent histories; dynamic-state and workflow categories | Closest supplied gold-label structure for changing work state | Different domains, potentially multimodal and much larger than this pilot |

The dataset cards were inspected; no full public corpus was downloaded or evaluated in this pass. Nebius advertises CC-BY-4.0 and additional source-repository/model conditions; check the particular subset before training. JetBrains advertises Apache-2.0.

Two relevant methods:
- [Factory's probe evaluation](https://factory.ai/news/evaluating-compression) asks about facts, changed artifacts, next actions and decisions after compression. This is a useful methodological precedent, not evidence that its product results transfer to Pi/Ornith. I did not find a downloadable benchmark in the inspected article.
- [AutoCompact](https://autocompact.github.io/) reports 1,052 supervised examples from 379 tasks, with judges correcting compaction timing, summaries and continuation. It is a useful recipe for generating supervised examples. The inspected project page did not expose a downloadable SFT dataset, so this is not counted as acquired training data.

## What was actually prepared

Sixteen assistant-authored, source-checked expected-answer assertions across two archived OpenCode sessions:
1. Cron tool availability: overall purpose, chosen scope, successful edits, build evidence, outstanding runtime verification, next step, unsupported evidence, obsolete work-state blocker.
2. Review/deduplication: broader priority, explicit exclusions, decisions carried by the question tool, regression constraint, completed notification refactor, remaining planned refactors, frontend build evidence, correct continuation focus.

Private files:
- `eval/private/work-state-gold.json`: expected answers with source message indices and exact supporting excerpts.
- `eval/private/work-state-grades.json`: manual labels with exact candidate-output excerpts.
- Existing source sessions and model traces remain in the same ignored directory.

The validator checks that every cited source message precedes the cutoff, every source/output excerpt exists, all assertions are accounted for, and known invented evidence is absent from the source. It hashes normalized inputs and checkpoints. It validates annotation bookkeeping, not semantic truth automatically.

These are development cases already examined during diagnosis, not a blinded holdout or sufficient fine-tuning corpus. Future train/dev/test separation should be by whole task/session (preferably repository), never neighboring checkpoints from the same trajectory. Labels and future messages must stay outside model input. Failed source trajectories are useful tests, but their assistant completion claims are not gold.

## Retention observed in saved Ornith outputs

The assessed object is the **full merged checkpoint including the deterministic user-message ledger**, not only the model-authored lane text. Two final candidates follow three chained synthetic compaction boundaries on the same cron session.

| Assertion | Original prompts, reasoning off | Experimental refresh instruction, reasoning off |
|---|---|---|
| Overall goal: allow history-before-send to prevent duplicate cron messages | Preserved | Preserved |
| User choice: cron-only, main agent unchanged | Preserved | Preserved |
| Both implementation patches already succeeded | Contradicted by continuation | Preserved |
| Build ran after edits and passed | Preserved | Preserved |
| Planned runtime check still unverified | Contradicted | Contradicted |
| Correct next action | Contradicted | Contradicted |
| No invented verification evidence | Failed | Failed |
| Old read-only blocker updated after successful edits/build | Failed | Preserved |

Diagnostic counts: original 3/8 assertions preserved; refresh 5/8. **These are not accuracy estimates for Ornith or the installed system.** They are manual classifications of two previously inspected outputs from one task, with no confidence interval or independent reviewer.

The strongest finding is the separation between knowing the goal and knowing the current work state:
- Both retain the goal and user's scope. The original wording about preventing duplicate messages survives in the deterministic ledger even when model-authored sections focus narrowly on tool availability.
- Original output reports successful patches and then tells the next agent to wait for Plan Mode and implement them again.
- Refresh output records runtime validation as NOT RUN, yet says all planned work is complete and no next action remains.
- Original invents a commit and test/coverage evidence; refresh invents detailed build output.

The source supports two successful patches and a subsequent build. The earlier accepted plan also included a targeted cron runtime check. No evidence of that execution appears before the cutoff. The historical assistant's final “done” does not establish that the planned check happened.

**Current guard behavior:** both archived candidates are rejected by the duplicate-heading guard added earlier: execution Continuation Anchor for original, intent Current Objective for refresh. Therefore these are diagnostic rejected candidates, not summaries newly accepted by the fixed code.

Reasoning-enabled runs are not omitted from the comparison: the earlier capped-thinking run stopped before producing a complete final checkpoint; the natural-thinking probe also exhausted its intent output allowance. These are availability failures, not successful summaries to score. The review session likewise has no usable full checkpoint from the earlier pilot; its eight assertions are prepared but unscored.

## New input-routing finding

The review export contains four question-tool answers, at normalized indices 51, 69, 71 and 88. They encode:
- JWT selection, no localhost/CORS change, and concern about duplicates;
- secret-storage choice;
- agreement to implement all;
- manual token input and local storage.

Running the actual serializers shows all four:
- produce zero characters when individually sent through `serializeIntentView`;
- reach `serializeExecutionView`;
- are excluded from the replay's native-user-only deterministic ledger.

This matters because the task lane may depend on the original assistant's paraphrase of a decision instead of seeing the user's actual answer. The user later repeats the dedup priority in a native message, which helps at later cutoffs but cannot repair an earlier cutoff retrospectively.

This is a confirmed **OpenCode-export replay input gap**, not a verified defect in the user's native Pi question adapter. Ordinary tool output must not be blindly promoted to user authority. Any adapter change should recognize the actual trusted question-answer event and preserve its origin. The production input path is unchanged in this pass.

## Next practical comparison

Use the same source prefixes, raw recent suffix and reader model for four conditions:
1. Full source context.
2. Old tool-output masking with recent results retained.
3. Current two-lane compaction.
4. The same compaction plus the proposed exact goal/plan state.

Ask a fresh reader the gold questions without revealing expected answers; score against source evidence. Add one constrained next-action selection to test whether the reader would redo completed work, skip a promised check, or drift to a secondary goal. Measure repeated-compaction retention, contradictory completion, missed outstanding work, fabricated verification, usable-checkpoint rate, and end-to-end time/token cost.

First validate question-answer routing in native Pi and in the replay. Then evaluate the exact-plan hypothesis; do not assume another prompt paragraph solves a missing-input problem. For fine-tuning later, create reviewed source-prefix → checkpoint pairs plus correct continuation examples, keeping the evaluation sessions separate.

## Reproduce and status

From `/workspace/pi-compaction-eval-0913`:

```bash
python3 eval/check-retention.py
/workspace/.tools/compaction-node22/node-v22.23.2-linux-x64/bin/node --import tsx eval/retention-visibility.mjs
```

Results: `eval/results/work-state-retention.json`, `eval/results/retention-visibility.json`, `eval/results/retention-current-guard.json`.

This pass made no new model calls, no training run, no production prompt/runtime changes, no installation and no push. The proposed exact lightweight plan remains unimplemented.
