# pi-dcp

Dynamic Context Pruning for the [pi coding agent](https://github.com/earendil-works/pi-mono).

A port of [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (DCP), adapted to pi's extension model. DCP reduces token usage by letting the model compress closed/stale conversation ranges into high-fidelity technical summaries, plus automatic deduplication and error-purge strategies.

## What it does

- **`compress` tool** — a tool the model calls to replace stale conversation ranges (or individual messages) with technical summaries. Summaries preserve file paths, decisions, user intent, and protected tool outputs.
- **Deduplication** — prunes older tool calls that have the same name + arguments, keeping only the most recent.
- **Purge errors** — prunes inputs from errored tool calls after a configurable number of turns (error messages preserved).
- **Nudges** — injects reminders to compress when context crosses soft `minContextLimit` / `maxContextLimit` thresholds, with configurable frequency and force.
- **Message IDs** — injects stable `(dcp-msg-id mNNNN)` markers so the model can reference boundaries when calling `compress`.
- **State persistence** — pruning/compression state survives restarts, keyed by session file, and is inherited by forked/cloned sessions.

Your session history on disk is **never modified** — DCP only transforms the message array sent to the LLM.

DCP mirrors pi's context filtering: assistant turns that ended with `stopReason: "error"` or `"aborted"` are excluded from DCP's view (refs, compression, pruning), just as pi-ai's `transformMessages` never replays them to the LLM. Orphaned tool calls inside such interrupted turns therefore cannot block compression.

## Installation

### npm (recommended)

```bash
pi install npm:@snowy117/pi-dcp
```

### git

```bash
pi install git:github.com/Snowy117/pi-dcp-migrate
```

### Manual (global extension)

```bash
git clone https://github.com/Snowy117/pi-dcp-migrate ~/.pi/agent/extensions/pi-dcp
```

Pi auto-discovers extensions in `~/.pi/agent/extensions/`. Use `/reload` after editing.

### Quick test

```bash
pi -e ./index.ts
```

## Configuration

DCP reads its own config, searched in order (later layers override earlier):

1. Global: `~/.config/pi/dcp.jsonc` (or `dcp.json`), created automatically on first run
2. `$PI_CONFIG_DIR/dcp.jsonc`
3. Project: `.pi/dcp.jsonc` (or `dcp.json`) in your project's `.pi` directory

### Supported options

All options from the original DCP `dcp.schema.json` are supported **except**:
- `autoUpdate` — npm-package concept, not applicable to pi extensions
- `pruneNotificationType` (`"chat"` / `"toast"`) — pi has no toast/chat split; notifications use pi's `ui.notify`
- `experimental.allowSubAgents` — pi has no in-process subagent sessions. The [pi-subagents](https://github.com/Snowy117/pi-subagents) plugin spawns separate processes, each running its own independent DCP instance, so there is nothing to gate. The option is accepted in config for compatibility but is a no-op.

### Defaults

```jsonc
{
    "$schema": "./dcp.schema.json",
    "enabled": true,
    "debug": false,
    "pruneNotification": "detailed",   // "off" | "minimal" | "detailed"
    "commands": { "enabled": true, "protectedTools": [] },
    "manualMode": { "enabled": false, "automaticStrategies": true },
    "turnProtection": { "enabled": false, "turns": 4 },
    "experimental": { "allowSubAgents": false, "customPrompts": false },
    "protectedFilePatterns": [],
    "compress": {
        "mode": "range",              // "range" | "message"
        "permission": "allow",        // "ask" | "allow" | "deny"
        "showCompression": false,
        "summaryBuffer": true,
        "maxContextLimit": 100000,    // number | "X%"
        "minContextLimit": 50000,
        "nudgeFrequency": 5,
        "iterationNudgeThreshold": 15,
        "nudgeForce": "soft",         // "strong" | "soft"
        "protectedTools": [],
        "protectTags": false,
        "protectUserMessages": false
        // "modelMaxLimits": { "anthropic/claude-sonnet-4": "80%" },
        // "modelMinLimits": { "anthropic/claude-sonnet-4": "25%" },
    },
    "strategies": {
        "deduplication": { "enabled": true, "protectedTools": [] },
        "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] }
    }
}
```

### Per-model limits

`maxContextLimit` / `minContextLimit` accept a number (absolute tokens) or `"X%"` (percentage of the active model's context window). Override per model with `modelMaxLimits` / `modelMinLimits`, keyed by `provider/modelId`:

```jsonc
{
    "compress": {
        "modelMaxLimits": { "anthropic/claude-sonnet-4": "80%" },
        "modelMinLimits": { "anthropic/claude-sonnet-4": "25%" }
    }
}
```

## Commands

- `/dcp` — show help
- `/dcp stats` — pruning statistics
- `/dcp context` — current context usage vs. DCP limits
- `/dcp manual on|off` — toggle manual mode
- `/dcp compress [focus]` — trigger one manual compression
- `/dcp-compress [focus]` — alias for the above

## Prompt overrides

Set `experimental.customPrompts: true` to enable user-editable prompts. Managed defaults are written to `~/.config/pi/dcp-prompts/defaults/`. Put overrides in `~/.config/pi/dcp-prompts/overrides/` (global) or `.pi/dcp-prompts/overrides/` (project) using the same filenames.

## Protected tools

Default protected tools (never pruned by dedup/purge): `subagent`, `compress`, `write`, `edit`.

`compress.protectedTools` (default: `["subagent"]`) ensures those tools' completed outputs are appended to compression summaries, so subagent results survive compression.

## pi-subagents compatibility

Works alongside [pi-subagents](https://github.com/Snowy117/pi-subagents). Each subagent runs in its own process with its own DCP instance. The parent session's `subagent` tool results are protected from compression by default (`compress.protectedTools` includes `subagent`).

## How fork and clone interact

`/fork`, `/clone`, and `pi --fork` copy session entries into a new session file, keeping their entry IDs. Since DCP keys its state by entry ID, the new session inherits the parent's compression blocks:

- On `session_start`, if the new session has no DCP state of its own, DCP walks the `parentSession` chain in the session headers and adopts the first ancestor state it finds.
- Inherited blocks are filtered against the entries the new session actually contains, so blocks whose origin or anchor was cut off by the fork point are dropped.
- The result is saved under the new session's own key. The parent's state file is never modified.

## How tree navigation interacts

Pi's `/tree` (with or without summary) does **not** conflict with DCP:
- Tree navigation changes the active branch. DCP reconciles its compression-block state on the next `context` event: blocks whose origin (compress tool-call message) is no longer on the active path are deactivated.
- Pi's branch/compaction summarizer calls the LLM directly (`completeSimple`), bypassing DCP's context pipeline, so DCP never injects into summarizer calls.
- DCP detects pi's internal summarizer system prompt and skips its own system-prompt injection for those calls.

## License

AGPL-3.0-or-later (inherited from the original opencode-dynamic-context-pruning).
