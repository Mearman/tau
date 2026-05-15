# Tau (τ) — Quality-of-Life Extension for pi

Background tasks, notifications, and other enhancements for the pi agent loop. Modelled after Claude Code's UX where possible.

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
- **Zero runtime dependencies** — tree-kill replaced with `process.kill(-pid)`

### Notifications

- **Native terminal notifications** on agent completion — OSC 777 (Ghostty, iTerm2, WezTerm), OSC 99 (Kitty), Windows toast
- **Last agent message** shown in the notification body (first line, max 200 chars)
- **Replaces the standalone `notify.ts` extension**

## Installation

```bash
# Extension lives at ~/.pi/agent/extensions/tau/
# Source: https://github.com/Mearman/tau (private)

pi  # loads automatically — look for "tau" in extension list
```

## Usage

### Background a Running Command (Ctrl+B)

```
Agent: Running npm build...
bash: npm run build
> Building [1/10]...

[User presses Ctrl+B]
⏸ Backgrounded. Ctrl+B to resume.
```

Both the bash process **and** the agent loop are backgrounded simultaneously. The agent stops processing, and the user regains control.

### Resume (Ctrl+B again)

```
[User presses Ctrl+B]
▶ Resumed
Agent: Continuing where you left off.
```

### Start Command in Background Immediately

```
User: Start a build in the background
Agent: I'll run that in the background immediately.
bash_bg: cargo build --release
→ Started background job job-1 (PID 42319)
→ Output: /tmp/pi-bg-job-1.log
```

### Auto-Background After 15 Seconds

Commands running longer than 15 seconds are automatically backgrounded. The agent receives a followUp message asking whether to kill or continue:

```
⏰ Command timed out after 15s and has been backgrounded as job-3.
Choose one:
- Use the jobs tool with action "kill" and jobId "job-3" to terminate it.
- Use the jobs tool with action "output" and jobId "job-3" to check progress.
- Do nothing and it will continue running in the background.
```

### Task Management (Shift+↓ or Ctrl+J)

```
Background Tasks
  ◐ agent · backgrounded · Ctrl+B to resume
  ◐ job-3: npm build · 45s
  ✅ job-1: sleep 10 · completed
  ❌ job-2: pi --model · failed
```

Select a task to see detail view with actions: attach, show output, kill.

### Kill Most Recent Task (Ctrl+X)

Instantly terminates the most recently started running background task.

## Tools

| Tool | Purpose |
|------|---------|
| `bash` | Standard bash, enhanced with 15s auto-background timeout and Ctrl+B support |
| `bash_bg` | Start a command in the background immediately |
| `jobs` | `list`, `output`, `kill`, or `attach` to background jobs |

## Commands

| Command | Purpose |
|---------|---------|
| `/bg` | Same as Ctrl+B — background bash/agent or resume |
| `/fg` | Attach to a background job, optionally with `--snapshot` |
| `/jobs` | Open task management interface |

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Background running bash + agent, or resume backgrounded agent |
| `Ctrl+X` | Kill most recent running background task |
| `Ctrl+J` / `Shift+↓` | Open task management interface |

## Architecture

```
User presses Ctrl+B
       │
       ├─ Bash process running?
       │   YES → backgroundProcess()
       │         - Remove foreground data listeners
       │         - Pipe stdout/stderr to /tmp/pi-bg-<jobId>.log
       │         - Unref child process
       │         - Resolve bash tool promise with backgrounded status
       │
       └─ Set agentBackgrounded = true
           - tool_call handler returns block:true
           - Agent's current turn finishes
           - Loop stops (no more tool calls execute)
           - User gets fresh input line

User presses Ctrl+B again
       │
       └─ agentBackgrounded = false
           - pi.sendMessage({ content: "Continuing..." }, { triggerTurn: true })
           - Agent starts new loop with full conversation context
```

### Key Design Decisions

- **Disk over memory**: Output goes to files, not in-memory buffers. Survives crashes, no memory pressure on long-running tasks.
- **Process groups over tree-kill**: `process.kill(-pid)` kills the entire group when spawned with `detached: true`. No external dependency needed.
- **Block over pause**: The agent loop can't be truly backgrounded (it runs in-process). Tool call blocking is the closest approximation. The agent sees an empty block reason and stops cleanly.
- **15s timeout**: Matches Claude Code's `ASSISTANT_BLOCKING_BUDGET_MS`. Commands that need longer should use `bash_bg`.

## Known Limitations

These require changes to pi core (see [implementation path note](obsidian://open?vault=Notebook&file=Resources%2Fdevelopment%2Fai-integration%2Fcoding-agents%2Fpi-cli%2FTau%20Extension%20%E2%80%94%20Unsolved%20UX%20Gaps%20and%20pi-mono%20Implementation%20Path)):

1. **Agent doesn't keep running in background** — tool calls are blocked, the loop pauses. True background execution needs an `AgentLoopHandle` API in pi core.
2. **No click handlers on pill bar** — `setWidget()` renders static text. No way to register click callbacks.
3. **No Ctrl+X inside dialogs** — `select()` doesn't support custom keybindings. Can only navigate with ↑/↓/Enter.
4. **No live output streaming** — `editor()` shows a static snapshot. No file-tail component available.

## Licence

Private — [github.com/Mearman/tau](https://github.com/Mearman/tau)
