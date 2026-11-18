# pi-one-round-compaction

Context compaction for Pi Coding Agent using **two parallel LLM calls in one round** plus a deterministic merge.

```text
older context
    |
    +--> work-state audit lane -----+
    |                               |
    +--> execution lane ------------+--> deterministic checkpoint
    |                               |
    +--> git/file/user state -------+

+ newest useful raw context retained verbatim
```

Neither LLM call sees the other call's output. There is no LLM verifier/finalizer and no external intent workflow.

## What the two calls preserve

### Work-state audit

The audit lane is deliberately not another general summary. It tracks information that repeated compaction can otherwise silently lose:

- **Active obligations** — accepted work that is still open, partial, blocked, or unknown.
- **Obligation status** — `DONE`, `PARTIAL`, `OPEN`, `BLOCKED`, or `UNKNOWN`, with supporting evidence.
- **Decisions that still matter** — explicit acceptance/rejection, corrections, scope choices, authorization, and priorities.
- **Contradictions / unsupported claims** — for example work disappearing without completion evidence, verification claimed but never run, or approved work being treated as awaiting approval again.
- **Do-not-repeat knowledge** — failed approaches and discoveries worth retaining because losing them would waste work.
- **Important unknowns** — uncertainties that can materially change completion or continuation.

Native human user messages are authoritative for user decisions. Assistant text, generated checkpoints, and tool results are evidence, not user authority.

### Execution

The execution lane tracks the operational handoff:

- continuation anchor and immediate next action;
- completed work relevant to continuation;
- current code/repository state;
- verification state (`PASS` / `FAIL` / `NOT RUN`);
- material discoveries;
- remaining actions.

The checkpoint keeps these lanes separate, then appends deterministic Git/file/user state.

## Live subagent continuity

When `@mistrjirka/pi-subagent` **0.5.14 or newer** runs in the same Pi process, compaction obtains a small, read-only snapshot of active **direct** children. The checkpoint records their short `@name`, current `running`/`waiting`/`idle` state, label, and a bounded task description. It excludes exited workers and does not read child transcripts or save their tool state. A missing or older subagent extension causes no roster to be added.

The live roster is rendered within the ordinary deterministic checkpoint budget. Its characters also reserve room before recent raw-context selection, and the final token estimate includes it. If the target is tight, the normal checkpoint fitter shortens the roster along with other deterministic evidence. If even the minimum useful state and both full model summaries cannot fit, compaction reports the existing `targetExceeded` warning instead of silently clipping the summaries.

The roster is a snapshot, not a live monitor. Run `agent_list` after compaction to see updated direct workers, and `agent_recover` after restarting Pi to find saved persistent workers. Nested workers are not included in this direct-child snapshot.

## Running background shell commands at compaction

When `pi-bg-bash` 0.6.x is loaded in the same Pi process, compaction takes a small, read-only snapshot of background commands that are **still running** in the **current session**. The deterministic checkpoint records their `bg-N` task IDs and bounded command strings. It does not read command output, inspect or restart their processes, or copy any log content. Finished or other-session tasks are excluded.

The list shares the same checkpoint token budget as the live subagent roster and the file/user evidence. It reserves space before raw-context retention, and token fitting can shorten it if needed. This is a point-in-time snapshot, not a live monitor: use `bash_tasks` after compaction to refresh the state and `bash_output` for logs.

The adapter reads pi-bg-bash's stable process-local `Symbol.for("pi-bg-bash.registry")` registry. This is an internal compatibility seam, not a Pi public API. If the registry is absent or changes shape, compaction proceeds without the shell-task snapshot rather than failing.

## Compatibility

- Pi Coding Agent `>= 0.84.0` (tested with `0.84.4`)
- Node.js `>= 22.19.0`
- default compaction model: `opencode-go/muse-spark-1.2-contributor`

The compaction work uses Pi public compaction, model-registry, session-entry, and token-estimation APIs. Running pi-bg-bash task continuity additionally uses the read-only, optional registry compatibility seam described above.

## Installation

Only one extension should return a `session_before_compact` result. Remove another compaction override first if necessary, then install:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction
```

For a local checkout:

```bash
git clone https://github.com/mistrjirka/pi-one-round-compaction.git
cd pi-one-round-compaction
npm install
pi install "$PWD"
```

Reload Pi and inspect the active configuration:

```text
/reload
/one-round-compaction
```

## Configuration

Global config:

```text
~/.pi/agent/one-round-compaction.json
```

Trusted projects may override it with:

```text
.pi/one-round-compaction.json
```

Example:

```json
{
  "model": "opencode-go/muse-spark-1.2-contributor",
  "thinkingLevel": "low",
  "targetPostCompactTokens": 40000,
  "toolResultChars": 2000,
  "recentControlChars": 16000,
  "includeGitState": true,
  "preflightAutoCompact": true,
  "fallbackToNative": false,
  "lanes": {
    "audit": {
      "thinkingLevel": "medium"
    },
    "execution": {
      "thinkingLevel": "low"
    }
  }
}
```

The audit lane defaults to medium thinking; execution defaults to low. Each lane can independently override only `model` and `thinkingLevel`. There is no configurable or fixed per-lane output-token limit.

Important defaults:

| Setting | Default | Purpose |
|---|---:|---|
| `targetPostCompactTokens` | 40000 | Soft checkpoint-size target after compaction. Does not limit LLM generation |
| `toolResultChars` | 2000 | Base retained chars per older tool result |
| `thinkingChars` | 0 | Older assistant-thinking retention |
| `recentControlChars` | 16000 | Cumulative compacted human-user ledger budget |
| `userMessageChars` | 2000 | Per-message user-ledger cap |
| `userArtifactThresholdChars` | 8000 | Exact oversized user-source archive threshold |
| `userArtifactPreviewChars` | 600 | Archive preview size |
| `userArtifactCandidateChars` | 12000 | Audit-lane source-classification budget |
| `userArtifactReferenceChars` | 4000 | Checkpoint durable-source reference budget |
| `gitStateChars` | 4000 | Rendered Git-state budget |
| `editedFilesChars` | 6000 | Rendered edited-file budget |
| `readFilesChars` | 1000 | Rendered read-file budget |

Unknown configuration keys fail closed.

### Pi recent-context budget

Pi's normal `compaction.keepRecentTokens` is the maximum raw recent-context budget. The plugin may choose a smaller effective raw budget to reserve room for deterministic state. Each parallel LLM lane uses only the model/provider maximum output allowance (`model.maxTokens`). The checkpoint-size target does not impose a generation limit. The final merged checkpoint is fitted to the soft target without clipping LLM summaries. The provider still has a finite maximum, and a provider `length` response fails compaction rather than persisting incomplete summaries.

The target is soft: LLM summaries are never clipped merely to hit it. Oversized/tool-heavy turns can be split at provider-safe boundaries rather than retained wholesale.

## Zero-reserve preflight

`preflightAutoCompact` defaults to `true`. Before an idle user submission, the extension projects the incoming prompt against the active model context window. If the new prompt would cross the window, compaction runs first. If required compaction fails, the prompt is not sent.

This allows `reserveTokens: 0` without relying on a fixed artificial reserve.

## Oversized exact user sources

Large native human user messages are stored exactly outside normal checkpoint text. The audit lane decides whether a source still matters and classifies it as:

- kind: `plan`, `spec`, `requirements`, `correction`, `log`, `evidence`, or `other`;
- authority: `governing` or `supporting`.

`governing` is reserved for exact current user material that directly controls work. Governing sources are rendered as read-before-work references; supporting sources stay available on demand.

The extension exposes:

```text
user_artifact
```

with `list`, `search`, and paged `read` actions. Exact artifacts survive normal reference archival and forked child sessions can read inherited parent sources without copying them.

## Custom prompts

Global prompt overrides:

```text
~/.pi/agent/one-round-compaction-system.md
~/.pi/agent/one-round-compaction-audit.md
~/.pi/agent/one-round-compaction-execution.md
```

Trusted project overrides use the same filenames under `.pi/`. Project prompts take precedence over global prompts, which take precedence over built-ins.

## Progress / PiTTy

Live compaction progress is observability-only and cannot fail compaction. RPC mode publishes JSON through Pi's `setStatus` surface using:

```text
pi-one-round-compaction.progress.v2
```

The payload is `CompactionProgressV2` from `src/progress.ts`, has `v: 2`, and exposes `audit` and `execution` lanes. The extension also emits `pi-one-round-compaction:progress` in-process. Final persisted compaction data is authoritative; live progress is transient.

## Persisted checkpoint schema

Current plugin details use schema version **6**. They include:

- both lane model/thinking/usage/duration records;
- whole-turn/split-turn retention metadata;
- post-compaction target and estimate;
- cumulative file and human-user metadata;
- durable exact-user-source provenance and classifications;
- optional Git state.

Artifact lifecycle recovery remains backward-compatible with v4/v5 checkpoints.

## Migration from 0.3.x

This release intentionally removes intent support completely:

- no intent lane;
- no `intent-workflow` auto-detection or ledger handling;
- no `intentWorkflowChars` setting;
- no `lanes.intent` setting;
- no intent/workflow prompt files.

Replace `lanes.intent` with `lanes.audit` if you had a lane override, or remove the lane block entirely to use the defaults. Remove obsolete `intentWorkflowChars` and `maxOutputTokens`; unknown keys are rejected so stale configuration is visible rather than silently ignored.

Old prompt overrides such as `one-round-compaction-intent.md` and `one-round-compaction-workflow-*.md` are no longer read. Use `one-round-compaction-audit.md` instead.

A configuration or prompt-loading error now **cancels compaction** instead of returning control to Pi native compaction. This prevents a stale config from silently changing the compaction mechanism. Explicit `fallbackToNative: true` still applies only to runtime lane failures after valid configuration has loaded.

On the first new-format compaction, known v5 normal checkpoints and Pi native checkpoints can be translated into bounded, neutral migration evidence so active work is not lost. The removed intent-workflow format is not detected, loaded, or reactivated. After a v6 checkpoint exists, only the new `Work-State Audit` and `Execution State` sections are carried forward.

## Development

```bash
npm run typecheck
npm test
```

The tests cover two-call concurrency/cancellation, audit/execution carry-forward, repeated obligation protection, deterministic merging, recent-context retention, preflight compaction, exact oversized user artifacts/fork provenance, progress output, streaming model calls, and configuration validation.

## License

MIT
