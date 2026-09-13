# Compaction replay experiment, 2026-09-13

This is a conversation-replay experiment, not a native Pi installation or task execution benchmark. Archived OpenCode messages are normalized into Pi-compatible user, assistant and tool-result messages. Tool calls from the archive are data and are never executed.

## Reproduce

Use Node >=22.19 and the project's dependencies. Start a private OpenAI-compatible Ornith server on localhost:18473. The recorded server uses V100, the V100-optimized build a70ee26ae, two fixed 98,304-token slots, q8_0 K/V, no MTP, and model:
`/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-A3B-AD-Q6_K-Q5_K.gguf`.

Normalize these members of the user's private archive:

```bash
python3 eval/normalize.py /path/to/opencode-sessions.tar.gz opencode/ses_31d7bcf4cffe7fjGfy8LC6UJqU.json eval/private/real-session-normalized.json
python3 eval/normalize.py /path/to/opencode-sessions.tar.gz opencode/ses_308d8f938ffeDJXvOoECX8ECtZ.json eval/private/review-session-normalized.json
node --import tsx eval/replay.mjs cron baseline
node --import tsx eval/replay.mjs cron refresh
node --import tsx eval/replay.mjs cron thinking
node --import tsx eval/replay.mjs review baseline
```

Run model batches sequentially. Each batch itself uses two concurrent Ornith requests. Sampling temperature is unspecified; seed is 42; prompt-cache reuse is disabled. Thinking mode explicitly enables thinking with a 1,024-token budget and adds 1,024 to the total generation cap so reasoning does not take away the same nominal answer allowance.

Baseline uses repository prompts unchanged. Refresh appends an experimental output/update contract; it is NOT a production prompt change. Thinking uses baseline prompts. The optional `masked` variant only reduces ordinary tool-result excerpts from 2,000 to 200 characters; it is not the full observation-masking algorithm from the paper and has not been evaluated here.

Three chained checkpoints: immediately before the final user correction, immediately after it, and after the remaining implementation/answer. At each subsequent step only the new messages, previous checkpoint, and cumulative bounded human ledger are supplied. Historical input is not silently replayed in full.

The initial baseline and refresh runs predate the new duplicate-section rejection. Replaying them with the final code can now fail early rather than persisting their ambiguous output. Raw outputs are under ignored `eval/private/`; source messages must not be committed or published.

## Limits

- Two archived OpenCode sessions, one seed, no claim of statistical significance.
- No native Pi event-hook replay, retained raw suffix, active workflow ledger, exact-artifact retrieval or real downstream coding execution.
- Git/file deterministic fields are empty to avoid injecting today's unrelated repository state.
- The normalizer preserves tool arguments and textual results, drops reasoning/encrypted state, and does not reproduce provider-specific tool metadata. A reported successful build is cross-checked against the original export's exit=0 metadata during manual review.
- Completion latency includes two concurrent lane requests; it excludes model load, Qwen/Ornith swapping and downstream prefill.
- Reasoning-free failures do not establish that the user's installed Muse compactor or normal Ornith reasoning profile behaves the same.
- The new format guard detects ambiguous duplicate H2 sections, not fabricated semantics.

## Observed results

No Ornith compaction profile passed this pilot. Baseline cron replay produced invented commit/test evidence and stale continuation state. The short refresh instruction did not resolve this and introduced more unsupported details. Thinking with a 1,024-token budget improved the first two boundaries but exhausted the total output cap at the third. A final-boundary probe without a forced thinking cutoff exhausted 12,288 tokens on the intent lane with no final answer; its execution lane demoted an outstanding planned runtime check to optional.

The archived review session's first baseline checkpoint exhausted its intent output cap. These failures are configuration-specific, not proof that Ornith in general or the optimized backend is defective. An upstream-runtime comparison was not performed.

The measured execution-view-only observation-masking baseline (keep last ten tool results) reduces 52,900 to 26,126 tokens, 50.6%. This is sizing, not a validated quality/latency improvement. Reproduce with `node --import tsx eval/mask-sizing.mjs`.

The two runtime fixes and the new duplicate-section guard pass typecheck and 87 tests. Before the fixes, the added completion tests failed 12/12, the sibling cancellation test failed, and duplicate-section tests failed 4/4. No production installation, main-branch change, push, or CI run occurred.

Natural thinking probe: `node --import tsx eval/probe-final.mjs` reuses the recorded final-boundary inputs. `validLane` checks termination/non-empty output/duplicate headings only; it is not semantic acceptance.

Research informing next experiments:
- [The Complexity Trap](https://arxiv.org/abs/2508.21433): masking and hybrid strategies warrant a coding-task baseline; its measured quality does not transfer automatically to this setup.
- [Parallel Context Compaction](https://arxiv.org/abs/2605.23296): parallel blocks can reduce latency, but reported QA/dialogue results do not prove plan preservation in coding traces.
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): prioritize recall and persistent notes before aggressively shrinking context.

Next: keep an exact lightweight plan/checklist outside repeated summaries without restoring the intent confirmation workflow; compare masked traces against current compaction on fixed continuation questions; test native Pi sessions and an upstream server control before attributing errors to prompts, model or backend. Track unrun checks and corrections separately from implementation completion. Require source identifiers for claimed evidence and test repeated compaction, not just one summary.

## Goal and progress retention audit

See [retention-evaluation.md](retention-evaluation.md) for public dataset candidates, sixteen source-linked assertions, manual scoring of two archived final checkpoints, and the question-answer routing audit. No additional model runs or production changes were made in that pass.
