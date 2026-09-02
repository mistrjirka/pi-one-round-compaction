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

The two LLM calls run concurrently. Neither call sees the other call's output and there is no LLM verifier/finalizer. User acceptance/rejection, relative priority, and corrections are treated as task semantics in the stronger intent lane rather than delegated to a third "sentiment" model; this avoids a third interpretation/merge path over the same evidence.

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
pi install git:github.com/mistrjirka/pi-one-round-compaction@v0.3.4
```

To follow the latest `main` instead:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction
```

Pi also accepts the SSH form:

```bash
pi install git:git@github.com:mistrjirka/pi-one-round-compaction.git@v0.3.4
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

The default compaction model is `opencode-go/muse-spark-1.2-contributor`. The continuation/task-semantics lane defaults to **medium** thinking because losing the current objective or next action is disproportionately costly; the evidence/execution lane remains **low**. Both are independently configurable.

If that provider/model is not available in your Pi setup, configure another model as described below before triggering compaction.

### 4. Choose how much recent context stays verbatim

The extension uses Pi's normal `compaction.keepRecentTokens` as the **maximum raw recent-context budget**. It also has a post-compaction target (40k tokens by default), so the effective raw budget can be smaller when room is needed for the two LLM summaries and deterministic state. For example, in `~/.pi/agent/settings.json`:

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
      "thinkingLevel": "medium",
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

A pinned install such as `@v0.3.4` is intentionally not moved by updates. Install a newer tag explicitly when one is released:

```bash
pi install git:github.com/mistrjirka/pi-one-round-compaction@NEW_TAG
```

### Uninstalling

```bash
pi remove git:github.com/mistrjirka/pi-one-round-compaction@v0.3.4
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
  "userMessageChars": 2000,
  "userArtifactThresholdChars": 8000,
  "userArtifactPreviewChars": 600,
  "userArtifactCandidateChars": 12000,
  "userArtifactReferenceChars": 4000,
  "targetPostCompactTokens": 40000,
  "intentWorkflowChars": 8000,
  "gitStateChars": 4000,
  "editedFilesChars": 6000,
  "readFilesChars": 1000,
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

## Post-compaction target and recent-turn budget

Pi's setting remains the upper bound for verbatim recent context:

```json
{
  "compaction": {
    "keepRecentTokens": 32000
  }
}
```

`targetPostCompactTokens` defaults to `40000`. Before choosing the cut point, the plugin reserves room for **both configured LLM lane outputs** plus bounded deterministic state, then gives the remainder to raw recent context (never more than `keepRecentTokens`). This prevents a 20k raw suffix from crowding out the summaries, Git state, edited files, intent contract, or user-message history.

Ordinary recent turns are kept whole. If the newest tool-heavy turn alone exceeds the effective recent budget, the plugin now cuts at a Pi-compatible assistant/user/custom message boundary and summarizes the discarded prefix. It never keeps a 100k+ turn merely because it is one turn. The retained suffix stays provider-safe: tool results are not orphaned from their preceding assistant tool call.

The target is deliberately **soft**. LLM lane summaries are high-priority and are never clipped to hit it. Deterministic categories have floors and are scaled together when necessary; if even those floors plus the LLM summaries exceed the target, the checkpoint remains useful and reports `targetExceeded` instead of destroying summary quality.

Pi's native threshold/overflow triggers remain unchanged. `preflightAutoCompact` adds one extra trigger only for an idle user submission whose projected `current + incoming` context would exceed the active model window; it does not reserve a fixed number of tokens before compaction.

## Oversized human user sources

Large pasted plans/specifications should not be repeatedly summarized until exact requirements disappear. Human user messages of at least `userArtifactThresholdChars` (8,000 chars by default) are therefore stored verbatim in a session-owned sidecar under:

```text
~/.pi/agent/state/one-round-compaction/sessions/<session-id>/
  user-artifacts.json
  user-artifacts/
    U0001-<hash>.md
    ...
```

Only native persisted `role: "user"` messages are eligible. Extension/custom messages such as subagent progress, background completion/failure notifications, bash execution wrappers, and compaction summaries are never treated as human source material. Existing oversized messages are backfilled from the current branch on the next compaction; new large interactive/RPC inputs are also saved before a preflight compaction can discard older context. Exact artifacts are SHA-256 deduplicated and branch-scoped when exposed back to the model. In a fork, inherited exact text is not duplicated into the child manifest, and new child-local U#### ids are allocated above inherited ordinals to avoid provenance collisions.

Forked Pi sessions inherit exact user artifacts read-only through the persisted `parentSession` lineage. The child does not copy the parent's exact files into its own manifest. Provenance is carried as `sourceSessionId`, and new child-local U#### IDs are allocated above inherited IDs so a new child artifact cannot collide with an inherited `U0001`. The tool exposes only artifacts that are actually present on the active branch through raw human messages or prior compaction metadata; it does not expose an ancestor's entire catalog.

The intent/implementation LLM lane receives bounded metadata/previews and performs the semantic decision. Newly seen oversized user sources are offered for classification before older durable references: older references that do not fit are preserved unevaluated, while a new correction/specification must not be starved out by historical active sources. When candidates are present it appends `## Durable User Sources` and labels each relevant source with a semantic `kind` (`plan`, `spec`, `requirements`, `correction`, `log`, `evidence`, or `other`) and `authority` (`governing` or `supporting`). The deterministic layer never guesses these labels. `governing` is reserved for exact current user instructions that control planning, delegation, editing, or implementation; logs and ordinary evidence remain `supporting` and are retrieved only on demand.

References use a two-compaction hysteresis:

- mentioned by the semantic lane → `active`
- omitted once → `cooling`
- omitted on the next compaction as well → removed from normal checkpoint context (archived)

Archiving never deletes the exact source. Active `governing` sources render a prominent read-before-governed-work section: the checkpoint explicitly says its summary is not a substitute for the exact source and instructs the agent to page through the complete artifact before planning, delegating, editing, or implementing work it governs. Supporting/cooling sources remain on-demand. Every checkpoint that has archived sources retains a small recovery hint, and the extension exposes the `user_artifact` tool:

```text
user_artifact list
user_artifact search <query>
user_artifact read U0001
user_artifact read U0001 sourceSessionId=<shown-session-id>
```

The tool is branch-scoped and `read` supports `startChar`/`maxChars` paging for very large plans. When the same U#### could exist in more than one visible session, `sourceSessionId` disambiguates it. Active `governing` sources render under `### Governing exact user sources — READ BEFORE GOVERNED WORK`; the model is explicitly instructed to read the complete exact source before planning, delegating, editing, or implementing work controlled by it. Supporting/cooling sources remain on-demand. This is a strong retrieval contract, not a universal tool-call blocker.

The ordinary human-message ledger remains separate. `recentControlChars` still caps its total rendered size at 16,000 chars by default, while `userMessageChars` now allows up to 2,000 chars per compacted human message. Rendering first preserves a useful share for every genuine human message and gives spare budget to newer messages; oversized artifacts provide the exact fallback for long pasted source material.

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
      intent-state.json  # optional machine-readable generation/status
      plan.md   # optional
```

Detection verifies the canonical project root, the root hash/binding, that `current` resolves inside that project's `intents/` directory, and that `intent.md` contains a non-empty `# Current intent`. Because the workflow's `current` symlink can persist after an old task, a valid pointer alone is not enough: the current Pi session must also have touched/activated that workstream, or a prior compaction in the same session must already have confirmed it. Missing, stale, unconfirmed, invalid, or unrelated ledgers simply select normal compaction mode.

In active mode the plugin re-reads `intent.md` and `plan.md` from disk on every compaction. When `intent-state.json` is present, it also reads its intent generation/status. A `pending_reconciliation` generation suppresses the old durable contract and previous-generation checkpoint and renders a deterministic reconciliation reminder instead; legacy workstreams without the state file remain active generation 1. Once confirmed, prior checkpoint continuation state is reused only when workstream **and generation** match. It extracts the current intent contract sections (`Current intent`, navigation context, direct user quotes, interpretation corrections, accepted behavior, hard constraints, boundaries, accepted decisions, acceptance checks, and open questions) while deliberately omitting `Evolution history`. The persisted checkpoint keeps a bounded prioritized intent contract plus the exact `intent.md`/`plan.md` paths; it does **not** paste the full plan. The LLM lanes receive only a small bounded plan excerpt for orientation. When `plan.md` exists, the checkpoint explicitly identifies it as the maintained evolving workflow plan and tells the agent to read the exact file before implementation when plan detail governs the work. Newer explicit user instructions still override stale workflow state. Known untouched template-placeholder lines are also removed. The plugin is read-only: it never creates or modifies intent-workflow files.

The ledger remains context rather than absolute authority. Newer retained raw user messages override stale ledger content, matching the intent-workflow's own precedence rule.

## What each lane sees

### Normal mode: intent/scope lane

Receives native human user messages from the compacted prefix and concise assistant text. Long assistant proposals keep both their head and tail so a later short `yes`/`no` can still be interpreted. Branch/compaction summaries may be supplied as explicitly labeled **generated, non-authoritative** semantic evidence for fork/resume continuity. Tool results, hidden reasoning, and ordinary extension/custom messages remain omitted from task semantics even though Pi maps some of those generated messages to provider `role=user`. It owns only:

- current objective
- accepted plan/scope
- explicit user priorities / acceptance / rejection / unresolved decision state
- constraints and exclusions
- user corrections/non-goals

The intent lane preserves operational decision signals, not inferred emotion or generic sentiment.

It is explicitly forbidden from turning historical work back into current scope.

### Normal mode: execution-state lane

Receives the compacted prefix with tool calls and bounded tool results. Tool-result labels retain the tool name and error state. Raw source/file outputs and overlapping `subagent` transcript/status tool results keep the normal small budget. The larger bounded evidence budget is spent on the final `subagent-notify` handoff/child-results message and on higher-density structural results such as CodeGraph/module reports, targeted symbol/structural search, and session/memory search. `user_artifact read` results collapse to a durable U####/source-session/range locator instead of copying a giant exact plan back into the summarizer input. Generated extension/custom/bash messages remain available as execution evidence, explicitly labeled rather than misrepresented as human user instructions. Hidden reasoning is omitted by default. It owns only:

- a short **Continuation Anchor**: current phase, immediate next action, active delegated run/wait identifiers, blockers/decisions, and do-not-redo facts
- completed/current implementation state
- relevant code/repository state
- verification/test state
- material discoveries/adjustments
- remaining work and immediate next action

### Active intent-workflow mode

When a valid active ledger is detected, task semantics are no longer reconstructed by an LLM. A bounded prioritized view of `intent.md` plus the intent/plan paths is preserved deterministically; `plan.md` is referenced rather than copied wholesale into every checkpoint. The two parallel calls are repurposed:

- first lane: implementation continuation state, beginning with a short protected **Continuation Anchor** and **User Contract Delta**. Operational priority/emphasis can be preserved there without forcing intent reconciliation; only an actual newer correction/rejection/extension of the durable contract is marked `RECONCILIATION REQUIRED`. The lane then carries `Done`, current code/repository state, material discoveries, and remaining/immediate actions
- second lane: verification/evidence state, beginning with an **Evidence Anchor** for unresolved required checks/blockers, then tests/checks, important failures, unresolved risks/open questions, and critical exact context

Both lanes are explicitly forbidden from redefining or broadening the durable intent. Newer explicit user instructions in the compacted conversation and the retained raw turns still outrank the ledger.

### Continuation protection across repeated compactions

The previous LLM checkpoint is not carried forward by simply clipping its first N characters. Each lane is parsed by heading and re-ordered by continuation priority before the bounded carry-forward: immediate next action / active-run / blocker state comes before historical `Done` or long verification chronology. If a summarizer omits the required continuation/evidence anchor, the plugin deterministically reconstructs it from that lane's `Remaining / Immediate Next Actions` or unresolved-risk section; if neither exists it emits an explicit unknown-state warning instead of silently inventing a next action.

Long generated evidence such as tool results, bash output, and subagent completion messages is clipped **head + tail**, not head-only, so terminal status, run IDs, and final handoff lines are less likely to disappear while the middle bulk remains bounded.

### Deterministic state

Merged without an LLM:

- bounded active intent-workflow contract + exact intent/plan paths (full plan not duplicated)
- current git root/branch/HEAD and bounded dirty paths, ordered by filesystem modification time when available
- files actually edited/written in the compacted trace, newest touch first and character-bounded
- a much smaller bounded list of trace-local read files
- cumulative compacted **human** user-message ledger across repeated compactions; extension/subagent/background notifications are excluded, each source message is capped at 2,000 chars by default, and rendered shares favor preserving short messages plus newer detail
- LLM-selected active/cooling references to exact oversized human source artifacts, including `kind`, `authority`, and `sourceSessionId`; active governing sources are rendered as read-before-work instructions, with archived sources still recoverable through `user_artifact`
- full cumulative file/user/reference metadata in structured compaction `details` version 5, including provenance-qualified `knownUserArtifacts`, even when the model-facing rendering is reduced
- retention/target metadata, including effective raw budget and whether the soft target was exceeded

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
- configured/effective recent-token budgets, target post-compaction tokens, estimated tokens after compaction, and `targetExceeded`
- retained tokens and boundary mode (`whole-turn`, `split-turn`, or compatibility fallback)
- cumulative read/modified files plus trace-local recency-ordered edited/read files
- complete capped cumulative user-message ledger
- final per-category render budgets used to fit the checkpoint
- git state
- intent-workflow active/inactive status, workstream, plan presence, and truncation flags

The standard compaction entry also contains combined `usage`, `tokensBefore`, `estimatedTokensAfter`, and the actual `summary`. PiTTy should treat the final `session_compact`/`compaction_end` data as authoritative and the live progress stream only as transient UI state.

## Development checks

```bash
npm run typecheck
npm test
```

The tests cover configuration validation, lane views, deterministic merge, cumulative file state, whole-turn token-budget retention, oversized newest turns, the single-turn fallback, intent-workflow auto-detection/stale-ledger rejection, both normal-mode and active-workflow two-call concurrency, governing/supporting artifact classification, v4→v5 artifact-state migration, forked-child exact parent-artifact reads, and collision-safe child-local artifact IDs.
