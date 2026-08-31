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

## Compatibility

Verified against the current Pi packages on 2026-08-31:

- `@earendil-works/pi-coding-agent` 0.84.4
- `@earendil-works/pi-ai` 0.84.4
- Node >= 22.19.0 (the same minimum required by Pi 0.84.4)

The extension uses Pi's public `session_before_compact`, `session_compact`, model registry, session-entry and token-estimation APIs. It does not import private `dist/...` modules.

## Why this design

The design follows the practical pattern seen in coding-agent context work: preserve current task semantics separately from execution state, prune low-value tool output, keep recent context verbatim, and preserve deterministic state outside the summarizer. The intent and execution lanes have disjoint responsibilities so they can be merged without a third LLM call.

## Important: remove other compaction overrides

Do not run another extension that returns a `session_before_compact` result at the same time. Pi executes all handlers and a later returned compaction can replace an earlier one.

For example, remove `pi-custom-compaction` before using this package:

```bash
pi remove npm:pi-custom-compaction
```

Use `pi list` first if your installed package has a different source/name.

## Install from a local checkout

```bash
pi install /absolute/path/to/pi-one-round-compaction
```

Pi also supports a git URL once this repository is hosted.

Then run inside Pi:

```text
/reload
/one-round-compaction
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

The plugin does not change Pi's automatic compaction trigger. `compaction.reserveTokens` and the native trigger behavior still determine *when* compaction starts.

## Prompt overrides

Built-in prompts can be overridden without editing the extension.

Global files:

```text
~/.pi/agent/one-round-compaction-system.md
~/.pi/agent/one-round-compaction-intent.md
~/.pi/agent/one-round-compaction-execution.md
```

Trusted project overrides:

```text
.pi/one-round-compaction-system.md
.pi/one-round-compaction-intent.md
.pi/one-round-compaction-execution.md
```

Project files take precedence over global files, which take precedence over built-ins. `/one-round-compaction` displays the effective prompt sources.

## What each lane sees

### Intent/scope lane

Receives all user messages from the compacted prefix and concise assistant text. Tool results and hidden reasoning are omitted. It owns only:

- current objective
- accepted plan/scope
- constraints and exclusions
- user corrections/non-goals

It is explicitly forbidden from turning historical work back into current scope.

### Execution-state lane

Receives the compacted prefix with tool calls and truncated tool results. Hidden reasoning is omitted by default. It owns only:

- completed/current implementation state
- relevant code/repository state
- verification/test state
- material discoveries/adjustments
- remaining work and immediate next action

### Deterministic state

Merged without an LLM:

- current git root/branch/HEAD
- dirty working-tree paths
- cumulative Pi read/modified file lists
- recent user requirement text from the summarized prefix
- retention boundary metadata

## PiTTy / observability

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

The standard compaction entry also contains combined `usage`, `tokensBefore`, `estimatedTokensAfter`, and the actual `summary`. PiTTy can render these directly from the `session_compact` event; no terminal-log parsing is needed.

## Development checks

```bash
npm run typecheck
npm test
```

The tests cover configuration validation, lane views, deterministic merge, cumulative file state, whole-turn token-budget retention, oversized newest turns, and the single-turn fallback.
