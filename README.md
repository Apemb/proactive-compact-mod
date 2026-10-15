# proactive-compact-mod

A Claude Code mod that lets the agent **prepare and choose its own compaction**, instead of having auto-compact land
on it when the context is full.

Without it, a long session ends up auto-compacted in the middle of the work, before the agent has saved its memories:
whatever was not written down is lost in the summary. The mod warns the agent early enough, gives it a way to measure
its context, and lets it trigger the compaction itself when it judges the moment right.

## What it does

| Piece | Role |
|---|---|
| **Compact request** | At the end of a main-session turn, if the raw context fill reaches `requestThreshold` (60% by default), the mod sends a message asking the agent to update its memories, then call `compact_session`. Once per cycle. |
| **Reminder** | The same at `reminderThreshold` (80% by default), if the agent has not compacted. Jumping straight past this threshold sends the reminder only. |
| `context_usage` tool | Gives the agent the tokens used, the window, the percentage, the thresholds and which message was last sent. With `detail: true`, the breakdown by category and the auto-compact threshold. |
| `compact_session` tool | **Schedules** the compaction, run when the current turn ends: Claude Code refuses to compact during a turn. It takes `instructions`, what the summary must keep. Refused below `compactFloor` (40% by default), cancelled if the turn is interrupted. |
| `/proactive-compact` | `status` (default), `on`, `off`, `settings`. |

Any successful compaction, the agent's, a `/compact` or auto-compact, rearms the compact request and the reminder.
Subagent turns are ignored, and both tools refuse subagents: they only read the main session.

The agent sees the tools as `mcp__proactive-compact-mod__context_usage` and `mcp__proactive-compact-mod__compact_session`.

## Settings

Global settings live in `/config`, in the `proactive-compact-mod` rows:

| Setting | Default | Role |
|---|---|---|
| `enabled` | `true` | Sends the compact request and the reminder. The tools are offered either way. |
| `requestThreshold` | `60` | Raw context percentage that triggers the compact request. |
| `reminderThreshold` | `80` | Raw percentage that triggers the reminder. |
| `compactFloor` | `40` | Below it, `compact_session` refuses. |
| `requestMessage` | provided text | The compact request message. |
| `reminderMessage` | empty | The reminder message; when empty, the compact request message is reused. |
| `messageSuffix` | empty | Appended to both messages. |
| `compactInstructions` | empty | Passed to the summary, before the agent's own. |

Messages accept the variables `{percent}`, `{threshold}`, `{floor}` and `{tool}`.

**Per-project override.** In the repository's `.claude/settings.json` (shared) or `.claude/settings.local.json`
(personal), which wins:

```json
{
  "pluginConfigs": {
    "proactive-compact-mod": {
      "options": {
        "requestThreshold": 50,
        "messageSuffix": "Also update docs/task-log.md."
      }
    }
  }
}
```

Overrides are read again on every use: a change takes effect without reloading the mod. `/proactive-compact` shows
where each value comes from.

## Install

The mod is a Claude Code function-hooks plugin (early-access API, written against Claude Code 2.1.301).

- **For every session**: add the repository folder to `CLAUDE_CODE_PLUGIN_DIRS`, in the `env` block of
  `~/.claude/settings.json`:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/proactive-compact-mod" } }
  ```
- **For one session**: `claude --plugin-dir /path/to/proactive-compact-mod`.

In an interactive session the folder is watched: saving a file reloads the mod.

## Develop

```sh
claude plugin validate .   # what the module hooks and calls, and what the engine would refuse
claude plugin test .       # tests/*.test.ts against the engine
tsc -p .                   # once the mod has loaded and Claude Code has written .claude-plugin/types/
```

| File | Content |
|---|---|
| `.claude-plugin/plugin.json` | Manifest and settings (`userConfig`). |
| `hooks/register.ts` | Hooks: turn end, compaction, tools, command. |
| `hooks/settings.ts` | Settings resolution (default, user, project, local) and message templating. |
| `types/index.d.ts` | Session state contract (`$.state`). |
| `tests/` | Behaviour tests. |

`.claude-plugin/types/` is written by Claude Code on every load and is not versioned.

## Known limits

- Subagents get neither the messages nor the tools: measuring their own context is still to be done.
- A `compactFloor` above `requestThreshold` makes the compact request pointless, since the tool would refuse. The mod
  does not flag it yet.
- The `⚠` before the status in the status bar is drawn by Claude Code; the API offers no way to change it.
