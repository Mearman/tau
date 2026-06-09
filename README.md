# Tau (τ) — Quality-of-Life Extension for pi

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/Mearman/tau)
[![npm version](https://img.shields.io/npm/v/pi-tau.svg)](https://www.npmjs.com/package/pi-tau)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/Mearman/tau/ci.yml?branch=main)](https://github.com/Mearman/tau/actions)

Background tasks, notifications, plan mode, presets, and other enhancements for the pi agent loop. Modelled after Claude Code's UX where possible.

## Features

### Background Tasks

- **Ctrl+B** — background running bash, background the agent loop, or resume a backgrounded agent
- **15-second auto-background** — long-running commands are automatically backgrounded with agent confirmation
- **Agent loop backgrounding** — Ctrl+B during agent processing blocks further tool calls and yields control back to you
- **Disk-based output** — all background job output written to `/tmp/pi-bg-<jobId>.log`, not memory
- **Process-group kill** — `process.kill(-pid)` terminates entire process trees
- **Stall detection** — detects interactive prompts (`(y/n)`, `Press any key`) in background jobs after 45s of stagnant output
- **Size watchdog** — kills background jobs exceeding 100 MiB output
- **Background hint** — `⏱ Ctrl+B to background` appears after 2s of bash or agent activity
- **Pill bar** — `◐ job-1: cmd (12s) · ◐ agent (backgrounded)` in the status area
- **Task management UI** — Shift+↓ or Ctrl+J opens grouped task list with detail views
- **Ctrl+X** — kill most recent running background task
- **Session persistence** — job history survives pi restarts

### Notifications

- **Native terminal notifications** on agent completion — OSC 777 (Ghostty, iTerm2, WezTerm), OSC 99 (Kitty), Windows toast
- **Last agent message** shown in the notification body (first line, max 200 chars)
- **Do Not Disturb** — respects macOS Focus mode; suppresses notifications when DnD is active
- **Persistent mode** — option to keep notifications visible until dismissed
- `/notifications` command to configure

### Plan Mode

- **Ctrl+Alt+P** or `/plan` — toggle read-only plan mode (only `read`, `bash`, `grep`, `find`, `ls` allowed)
- **Automatic step extraction** — numbered plan steps are parsed from the agent's response
- **Execution tracking** — switch to execution mode to track progress against the plan with `[DONE:n]` tags
- **Status widget** — shows `📋 3/7` progress in the status bar

### Presets

- **Ctrl+Shift+U** — cycle through named presets
- `/preset [name]` — switch directly or open selector UI
- Configure model, thinking level, tools, and system prompt instructions per preset
- Config files: `~/.pi/agent/presets.json` (global) and `.pi/presets.json` (project-local)
- CLI flag: `pi --preset plan`

### Bookmarks

- `/bookmark [label]` — label the last assistant message for easy navigation in `/tree`
- `/unbookmark` — remove the most recent bookmark

### Session Naming

- `/session-name [name]` — set a friendly name that appears in the session selector

### Instructions

- Automatically scans `.agents/rules/*.md` and `.claude/rules/*.md` (recursively) and injects them into the system prompt
- Also loads `AGENTS.md` / `CLAUDE.md` (and `*.local.md` variants), `.agents/AGENTS.md`, `.claude/CLAUDE.md`
- Walks from cwd up to root, with `~/.agents/rules/` and `~/.claude/rules/` as global fallbacks
- Both `.agents/` and `.claude/` are walked; `.agents/` wins on canonical-name conflict
- The agent can `read` specific rule files when relevant
- Memory: `MEMORY.md` from `.agents/memory/` or `.claude/memory/` is auto-loaded (when present); topic files are read on demand

### Custom Footer

- `/footer` — toggle a custom footer showing token usage (↑input ↓output $cost) and git branch

### Git Checkpoints

- Creates a `git stash create` checkpoint at each turn
- On `/fork`, offers to restore code to that point in history

### GitHub Issue Autocomplete

- Preloads the latest 100 open issues from the current GitHub repo via `gh`
- Type `#` in the input to trigger fuzzy-filtered issue completion
- Works with SSH and HTTPS remote URLs

### Handoff

- `/handoff <goal>` — generates a focused context-transfer prompt using the current model
- Opens an editor to review/edit the prompt before creating a new session
- Preserves parent session linkage

### Tasks

- `task` tool with nesting, links, and multi-status tracking
- Five statuses: `todo`, `in-progress`, `done`, `blocked`, `cancelled`
- Nested tasks via `parentId` — tree rendering in `/tasks` UI
- Directional links: `blocks`, `depends-on`, `related`
- Cycle detection on `move`, cascade removal, link cleanup
- `/tasks` command for interactive tree view

### Conversation Summary

- `/summarize` — generates a structured summary of the current conversation using an LLM
- Renders as Markdown in a custom UI

### Web Browse

- **chrome_list** — List open Chrome tabs across all profiles (bridge, CDP, or AppleScript)
- **web_browse** — Fetch page content as text, Markdown, or structured JSON
- **web_screenshot** — Capture full-page or viewport screenshots
- **web_interact** — Multi-step page interaction (click, fill, scroll, evaluate JS)
- Four browser modes: **bridge** (Chrome extension, zero prompts), **isolated** (headless Chromium), **cdp** (DevTools Protocol), **applescript** (read-only macOS)
- Playwright-core is optional — only needed for isolated and CDP modes
- Chrome extension + native messaging bridge included for zero-prompt tab access

### Feature Toggles

All tau features can be toggled on or off via the `/tau` command with six configuration scopes:

```
/tau features                              # open TUI overlay
/tau features set <id> on|off --scope <s>  # disable or enable a feature
/tau features get <id>                     # show effective value and source
/tau features unset <id> --scope <s>       # clear override, fall through to layer below
```

| Scope | Storage | Survives reload? | Survives session? |
|-------|----------|-------------------|--------------------|
| `temporary` | in-memory | no | no |
| `thread` | session branch entry | yes (per branch) | no |
| `session` | in-memory | no | no |
| `cwd` | `cwd/.pi/settings.json` | yes | yes |
| `project` | nearest `.pi/settings.json` walking up to git root | yes | yes |
| `global` | `~/.pi/agent/settings.json` | yes | yes |

Features default to on. The TUI shows the source layer for each feature's current value.

On-disk format in `.pi/settings.json`:

```json
{
  "tau": {
    "features": {
      "bookmark": false
    }
  }
}
```

Some features (instructions, git-checkpoint) bootstrap at session start; toggling them at runtime requires `/reload` to take full effect. The TUI flags these with a reload indicator.

## Tools

| Tool | Purpose |
|------|---------|
| `bash` | Standard bash, enhanced with 15s auto-background timeout and Ctrl+B support |
| `bash_bg` | Start a command in the background immediately |
| `jobs` | `list`, `output`, `kill`, or `attach` to background jobs |
| `job_decide` | Decide what to do with a timed-out background job |
| `task` | Manage tasks with nesting, links, and status — `list`, `add`, `update`, `remove`, `move`, `link`, `unlink` |
| `chrome_list` | List open Chrome tabs (bridge, CDP, or AppleScript) |
| `web_browse` | Fetch page content as text, Markdown, or structured JSON |
| `web_screenshot` | Capture page screenshots |
| `web_interact` | Multi-step page interaction (click, fill, scroll, evaluate) |

## Commands

| Command | Purpose |
|---------|---------|
| `/bg` | Same as Ctrl+B — background bash/agent or resume |
| `/fg` | Attach to a background job, optionally with `--snapshot` |
| `/jobs` | Open task management interface |
| `/tasks` | Show all tasks on the current branch |
| `/tools` | Enable/disable tools |
| `/plan` | Toggle plan mode (read-only exploration) |
| `/notifications` | Configure notification settings |
| `/bookmark` | Bookmark last assistant message |
| `/unbookmark` | Remove last bookmark |
| `/session-name` | Set or show session name |
| `/footer` | Toggle custom footer |
| `/preset [name]` | Switch preset configuration |
| `/handoff <goal>` | Transfer context to a new focused session |
| `/summarize` | Summarise the current conversation |
| `/tau` | Toggle features: set, get, unset, or open TUI |

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Background running bash + agent, or resume backgrounded agent |
| `Ctrl+X` | Kill most recent running background task |
| `Ctrl+J` / `Shift+↓` | Open task management interface |
| `Ctrl+Alt+P` | Toggle plan mode |
| `Ctrl+Shift+U` | Cycle presets |

## CLI Flags

| Flag | Purpose |
|------|---------|
| `--plan` | Start in plan mode (read-only exploration) |
| `--preset <name>` | Start with a named preset |

## Architecture

```
src/
  index.ts              Entry point — creates TauState, registers all features, cross-cutting event handlers
  state.ts              TauState class — shared mutable state
  types.ts              Shared type definitions (BackgroundJob, RunningProcess, Task, etc.)
  utils.ts              Shared utilities (formatDuration, notify, killProcessGroup, etc.)
  plan-utils.ts         Plan-mode pure functions (step extraction, safe command checking)
  features/
    background.ts       bash override, bash_bg, jobs, job_decide tools
    background-commands.ts  /bg, /fg, /jobs commands, Ctrl+B/X/J shortcuts, task UI
    titlebar.ts         Braille spinner and elapsed timer
    plan-mode.ts        /plan, Ctrl+Alt+P, plan execution tracking
    task.ts             task tool, /tasks command (nesting, links, status)
    tools-selector.ts   /tools command, state persistence
    notifications.ts    /notifications, agent_end notification, DnD support
    bookmark.ts         /bookmark, /unbookmark
    context-files.ts    project instructions, rules, and memory loading
    custom-footer.ts    /footer command
    git-checkpoint.ts   git stash checkpointing
    github-autocomplete.ts  # issue autocomplete
    handoff.ts          /handoff command
    preset.ts           /preset, Ctrl+Shift+U, JSON config
    session-name.ts     /session-name command
    summarize.ts        /summarize command
```

### Key Design Decisions

- **Disk over memory**: Output goes to files, not in-memory buffers. Survives crashes, no memory pressure on long-running tasks.
- **Process groups over tree-kill**: `process.kill(-pid)` kills the entire group when spawned with `detached: true`. No external dependency needed.
- **Block over pause**: The agent loop can't be truly backgrounded (it runs in-process). Tool call blocking is the closest approximation. The agent sees an empty block reason and stops cleanly.
- **15s timeout**: Matches Claude Code's `ASSISTANT_BLOCKING_BUDGET_MS`. Commands that need longer should use `bash_bg`.
- **Feature modules**: Each feature is a self-contained module that registers its own tools, commands, shortcuts, and event handlers. Shared state lives in a single `TauState` instance.
- **Subagent stays separate**: The subagent extension is large (~1000 lines) with external agent definitions and prompt templates. It remains a standalone extension for maintainability.

## Known Limitations

These require changes to pi core (see [implementation path note](obsidian://open?vault=Notebook&file=Resources%2Fdevelopment%2Fai-integration%2Fcoding-agents%2Fpi-cli%2FTau%20Extension%20%E2%80%94%20Unsolved%20UX%20Gaps%20and%20pi-mono%20Implementation%20Path)):

1. **Agent doesn't keep running in background** — tool calls are blocked, the loop pauses. True background execution needs an `AgentLoopHandle` API in pi core.
2. **No click handlers on pill bar** — `setWidget()` renders static text. No way to register click callbacks.
3. **No Ctrl+X inside dialogs** — `select()` doesn't support custom keybindings. Can only navigate with ↑/↓/Enter.
4. **No live output streaming** — `editor()` shows a static snapshot. No file-tail component available.

## Installation

### From npm

```bash
pi install npm:pi-tau
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-tau"]
}
```

### From GitHub

```bash
pi install github:Mearman/tau
```

Or clone directly into the extensions directory:

```bash
git clone https://github.com/Mearman/tau.git ~/.pi/agent/extensions/tau
cd ~/.pi/agent/extensions/tau && pnpm install
```

## Licence

MIT — [github.com/Mearman/tau](https://github.com/Mearman/tau)
