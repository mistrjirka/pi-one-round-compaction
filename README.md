# pi-one-round-compaction

Research-informed context compaction for Pi Coding Agent with **one LLM round only**.

Normal compaction topology:

```text
older context
    |
    +--> intent/scope lane --------+
    |                              |
    +--> execution-state lane -----+--> deterministic merge
    |                              |
    +--> git/file-state capture ---+

+ newest complete turns retained verbatim
```

The two LLM calls run concurrently. Neither call sees the other call's output and there is no LLM verifier/finalizer.

When the project uses the DEVEON-style `intent-workflow`, the plugin auto-detects the active external ledger and changes roles automatically:

```text
active intent.md + optional plan.md ----+--> deterministic durable intent
                                        |
older context --> implementation lane --+--> deterministic merge
              --> evidence/risk lane ----+

+ newest complete turns retained verbatim
```

No configuration flag is required. If no valid active ledger exists for the exact project, normal intent/scope + execution mode is used.

## Compatibility

Verified against the current Pi packages on 2026-08-31:

- `@earendil-works/pi-coding-agent` 0.84.4
- `@earendil-works/pi-ai` 0.84.4
- Node >= 22.19.0 (the same minimum required by Pi 0.84.4)

The extension uses Pi's public `session_before_compact`, `session_compact`, model registry, session-entry and token-estimation APIs. It does not import private `dist/...` modules.

## Why this design

The design follows the practical pattern seen in coding-agent context work: preserve current task semantics separately from execution state, prune low-value tool output, keep recent context verbatim, and preserve deterministic state outside the summarizer. The intent and execution lanes have disjoint responsibilities so they can be merged without a third LLM call.

## Installation

### Requirements

- Pi Coding Agent `>= 0.84.0` (verified with `0.84.4`)
- Node.js `>= 22.19.0`
- access to the configured compaction model (the default is `opencode-go/muse-spark-1.2-contributor`)

### 1. Remove another compaction override

Only one extension should return a `session_before_compact` result. If you currently use `pi-custom-compaction`, remove it first:

```bash
pi remove npm:pi-custom-compaction
```

If you are unsure what is installed:

```bash
pi list
```

Removing the other compaction extension does **not** remove Pi's native compaction settings such as `compaction.keepRecentTokens`.

### 2. Install this extension

Recommended: install the tagged release directly from GitHub:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction@v0.3.1
```

To follow the latest `main` instead:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction
```

Pi also accepts the SSH form:

```bash
pi install git:git@github.com:mistrjirka/pi-one-round-compaction.git@v0.3.1
```

For development from a local checkout:

```bash
git clone https://github.com/mistrjirka/pi-one-round-compaction.git
cd pi-one-round-compaction
npm install
pi install "$PWD"
```

By default `pi install` writes the package to your user Pi settings. Add `-l` if you intentionally want a project-local installation.

### 3. Reload Pi and verify

Inside Pi run:

```text
/reload
/one-round-compaction
```

`/one-round-compaction` should show the effective configuration, both LLM lanes, prompt sources, recent-turn retention settings, and whether the intent workflow is active for the current project.

The default compaction model is:

```text
opencode-go/muse-spark-1.2-contributor
thinking: low
```

If that provider/model is not available in your Pi setup, configure another model as described below before triggering compaction.

### 4. Choose how much recent context stays verbatim

The extension uses Pi's normal `compaction.keepRecentTokens` setting as a **budget for the newest complete turns**. For example, in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "keepRecentTokens": 32000
  }
}
```

Pi still owns its normal threshold and overflow triggers. In addition, this extension adds the zero-reserve preflight guard described below so a newly submitted prompt cannot be the thing that silently crosses the active model context window.

### 5. Optional plugin configuration

No plugin config file is required for the default setup. To override the model or other options, create:

```text
~/.pi/agent/one-round-compaction.json
```

For example:

```json
{
  "model": "opencode-go/muse-spark-1.2-contributor",
  "thinkingLevel": "low",
  "lanes": {
    "intent": {
      "maxOutputTokens": 3072
    },
    "execution": {
      "maxOutputTokens": 6144
    }
  }
}
```

Then run `/reload` again.

### Updating

If you installed the unpinned Git source, update extensions normally with Pi:

```bash
pi update --extensions
```

A pinned install such as `@v0.3.1` is intentionally not moved by updates. Install a newer tag explicitly when one is released:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction@NEW_TAG
```

### Uninstalling

```bash
pi remove git:github.com/mistrjirka/pi-one-round-compaction@v0.3.1
```

If Pi reports that the source string differs, run `pi list` and remove the exact listed package source.

## Zero-reserve auto-compaction preflight

`preflightAutoCompact` is enabled by default. Pi 0.84.x checks native threshold compaction before adding a newly submitted user prompt, so `reserveTokens: 0` can otherwise allow the new prompt itself to cross the model context window. This plugin projects the incoming prompt with Pi's estimator and compacts first when `current + incoming > contextWindow`. If that required compaction fails, the prompt is not sent.

This configuration is supported:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 0,
    "keepRecentTokens": 20000
  }
}
```

## Configuration

Global configuration:

```text
~/.pi/agent/one-round-compaction.json
```

Project override for trusted projects:

```text
.pi/one-round-compaction.json
```

Default behavior is equivalent to:

```json
{
  "enabled": true,
  "model": "opencode-go/muse-spark-1.2-contributor",
  "thinkingLevel": "low",
  "maxOutputTokens": 6144,
  "toolResultChars": 2000,
  "thinkingChars": 0,
  "recentControlChars": 16000,
  "includeGitState": true,
  "preflightAutoCompact": true,
  "fallbackToNative": false,
  "lanes": {
    "intent": {
      "maxOutputTokens": 3072
    },
    "execution": {}
  }
}
```

Each lane may independently override `model`, `thinkingLevel`, or `maxOutputTokens`:

```json
{
  "model": "opencode-go/muse-spark-1.2-contributor",
  "thinkingLevel": "low",
  "lanes": {
    "intent": {
      "maxOutputTokens": 3072
    },
    "execution": {
      "maxOutputTokens": 6144
    }
  }
}
```

`fallbackToNative` defaults to `false`. This guarantees that a failed lane does not silently trigger a later native LLM summarization call. Setting it to `true` trades that guarantee for automatic recovery.

## Recent-turn budget

The plugin uses Pi's existing setting as the token budget:

```json
{
  "compaction": {
    "keepRecentTokens": 32000
  }
}
```

Unlike Pi's native cut point, the plugin walks backward by **complete turns** and keeps the newest complete turns whose estimated total fits the budget. If the newest turn alone is larger than the budget, it is kept intact when older history can still be compacted.

Only the pathological case where the session effectively consists of one oversized turn falls back to Pi's split-turn boundary so compaction can make progress.

Pi's native threshold/overflow triggers remain unchanged. `preflightAutoCompact` adds one extra trigger only for an idle user submission whose projected `current + incoming` context would exceed the active model window; it does not reserve a fixed number of tokens.

## Prompt overrides

Built-in prompts can be overridden without editing the extension.

Global files:

```text
~/.pi/agent/one-round-compaction-system.md
~/.pi/agent/one-round-compaction-intent.md
~/.pi/agent/one-round-compaction-execution.md
~/.pi/agent/one-round-compaction-workflow-implementation.md
~/.pi/agent/one-round-compaction-workflow-evidence.md
```

Trusted project overrides:

```text
.pi/one-round-compaction-system.md
.pi/one-round-compaction-intent.md
.pi/one-round-compaction-execution.md
.pi/one-round-compaction-workflow-implementation.md
.pi/one-round-compaction-workflow-evidence.md
```

Project files take precedence over global files, which take precedence over built-ins. `/one-round-compaction` displays the effective prompt sources.

## Intent-workflow auto-detection

The plugin does not treat an installed skill as proof that a project uses the workflow. It activates intent-workflow mode only when the exact current project has a valid external active ledger using the workflow's canonical layout:

```text
${PI_WORK_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-work}/projects/
  <project-slug>-<12-char-root-hash>/
    project-root.txt
    current -> intents/<workstream>/
      intent.md
      plan.md   # optional
```

Detection verifies the canonical project root, the root hash/binding, that `current` resolves inside that project's `intents/` directory, and that `intent.md` contains a non-empty `# Current intent`. Because the workflow's `current` symlink can persist after an old task, a valid pointer alone is not enough: the current Pi session must also have touched/activated that workstream, or a prior compaction in the same session must already have confirmed it. Missing, stale, unconfirmed, invalid, or unrelated ledgers simply select normal compaction mode.

In active mode the plugin re-reads `intent.md` and `plan.md` from disk on every compaction. It deterministically preserves the current intent contract sections (`Current intent`, navigation context, direct user quotes, interpretation corrections, accepted behavior, hard constraints, boundaries, accepted decisions, acceptance checks, and open questions) while deliberately omitting `Evolution history`. Known untouched template-placeholder lines are also removed. The plugin is read-only: it never creates or modifies intent-workflow files.

The ledger remains context rather than absolute authority. Newer retained raw user messages override stale ledger content, matching the intent-workflow's own precedence rule.

## What each lane sees

### Normal mode: intent/scope lane

Receives all user messages from the compacted prefix and concise assistant text. Tool results and hidden reasoning are omitted. It owns only:

- current objective
- accepted plan/scope
- constraints and exclusions
- user corrections/non-goals

It is explicitly forbidden from turning historical work back into current scope.

### Normal mode: execution-state lane

Receives the compacted prefix with tool calls and truncated tool results. Hidden reasoning is omitted by default. It owns only:

- completed/current implementation state
- relevant code/repository state
- verification/test state
- material discoveries/adjustments
- remaining work and immediate next action

### Active intent-workflow mode

When a valid active ledger is detected, task semantics are no longer reconstructed by an LLM. `intent.md` and optional `plan.md` are preserved deterministically. The two parallel calls are repurposed:

- first lane: implementation continuation state (`Done`, current code/repository state, material discoveries, remaining/immediate actions)
- second lane: verification/evidence state (tests/checks, important failures, unresolved risks/open questions, critical exact context)

Both lanes are explicitly forbidden from redefining or broadening the durable intent. Newer explicit user instructions in the compacted conversation and the retained raw turns still outrank the ledger.

### Deterministic state

Merged without an LLM:

- active intent-workflow contract + optional current plan, when validly detected
- current git root/branch/HEAD
- dirty working-tree paths
- cumulative Pi read/modified file lists
- recent user requirement text from the summarized prefix
- retention boundary metadata

## PiTTy / observability

The extension is usable with unmodified vanilla Pi. Progress is observability-only: failures or unsupported UI surfaces never fail compaction.

### Live progress in vanilla Pi

Interactive Pi receives a normal extension status plus a live `setWidget` preview of both parallel lanes. When the provider exposes streaming events, checkpoint text appears as it is generated. If streaming is unavailable, the lane still advances through start/done/merge states and the completed lane text arrives at the end.

### PiTTy / vanilla Pi RPC contract

No Pi fork or custom RPC protocol is required. In `pi --mode rpc`, vanilla Pi already serializes extension `setStatus()` calls as normal JSONL `extension_ui_request` events. This extension reserves:

```text
statusKey = "pi-one-round-compaction.progress.v1"
```

For that key, `statusText` is JSON matching `CompactionProgressV1` from `src/progress.ts`. PiTTy should parse only events shaped like:

```json
{
  "type": "extension_ui_request",
  "method": "setStatus",
  "statusKey": "pi-one-round-compaction.progress.v1",
  "statusText": "{...JSON payload...}"
}
```

The payload is versioned (`v: 1`) and includes:

- `runId` and monotonically increasing `seq`
- `phase`: `preparing | streaming | merging | complete | error | aborted`
- `mode`: `normal | workflow`
- compaction reason and retained-turn/token-budget metadata
- active intent-workflow workstream/plan state when applicable
- both lanes' semantic `role`, `state`, output `chars`, elapsed time, and optional `delta`
- an error string for terminal failures

`delta` contains only text produced since the previous progress frame, so PiTTy can append it per `runId`/lane without repeatedly receiving the full checkpoint. Frames are throttled to roughly 8 Hz. If true provider streaming is unavailable, the completed lane is emitted as one final `delta`, so the client contract is the same.

A minimal PiTTy state machine is:

```text
compaction_start
  -> watch extension_ui_request/setStatus with the reserved statusKey
  -> group by runId
  -> ignore seq <= lastSeq
  -> append lanes.<lane>.delta when present
  -> render phase/lane state/timers
  -> on complete/error/aborted keep or collapse the preview
compaction_end
  -> replace preview with the authoritative persisted summary/details
```

When `statusText` becomes undefined, vanilla Pi is clearing the temporary progress status; it is not a failure. RPC mode intentionally does not send repeated full `setWidget` previews, keeping the JSONL stream compact for PiTTy.

For in-process extensions/SDK hosts, the same payload is additionally emitted on Pi's extension event bus channel:

```text
pi-one-round-compaction:progress
```

The returned compaction entry stores structured `details` with:

- plugin/version marker
- intent and execution model
- thinking level per lane
- wall-clock duration and per-lane duration
- per-lane token/cost usage
- retained complete-turn count
- estimated retained tokens and boundary mode
- cumulative read/modified files
- git state
- intent-workflow active/inactive status, workstream, plan presence, and truncation flags

The standard compaction entry also contains combined `usage`, `tokensBefore`, `estimatedTokensAfter`, and the actual `summary`. PiTTy should treat the final `session_compact`/`compaction_end` data as authoritative and the live progress stream only as transient UI state.

## Development checks

```bash
npm run typecheck
npm test
```

The tests cover configuration validation, lane views, deterministic merge, cumulative file state, whole-turn token-budget retention, oversized newest turns, the single-turn fallback, intent-workflow auto-detection/stale-ledger rejection, and both normal-mode and active-workflow two-call concurrency.
