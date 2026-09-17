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

## Compatibility

- Pi Coding Agent `>= 0.84.0` (tested with `0.84.4`)
- Node.js `>= 22.19.0`
- default compaction model: `opencode-go/muse-spark-1.2-contributor`

The extension uses Pi's public compaction, model-registry, session-entry, and token-estimation APIs.

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
  "maxOutputTokens": 6144,
  "targetPostCompactTokens": 40000,
  "toolResultChars": 2000,
  "recentControlChars": 16000,
  "includeGitState": true,
  "preflightAutoCompact": true,
  "fallbackToNative": false,
  "lanes": {
    "audit": {
      "thinkingLevel": "medium",
      "maxOutputTokens": 3072
    },
    "execution": {
      "thinkingLevel": "low"
    }
  }
}
```

The audit lane defaults to medium thinking; execution defaults to low. Each lane can independently override `model`, `thinkingLevel`, and `maxOutputTokens`.

Important defaults:

| Setting | Default | Purpose |
|---|---:|---|
| `targetPostCompactTokens` | 40000 | Soft total target after compaction |
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

Pi's normal `compaction.keepRecentTokens` is the maximum raw recent-context budget. The plugin may choose a smaller effective budget so both LLM outputs and deterministic state fit under `targetPostCompactTokens`.

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

Replace `lanes.intent` with `lanes.audit` if you had a lane override. Remove obsolete `intentWorkflowChars`; unknown keys are rejected so stale configuration is visible rather than silently ignored.

Old prompt overrides such as `one-round-compaction-intent.md` and `one-round-compaction-workflow-*.md` are no longer read. Use `one-round-compaction-audit.md` instead.

## Development

```bash
npm run typecheck
npm test
```

The tests cover two-call concurrency/cancellation, audit/execution carry-forward, repeated obligation protection, deterministic merging, recent-context retention, preflight compaction, exact oversized user artifacts/fork provenance, progress output, streaming model calls, and configuration validation.

## License

MIT
