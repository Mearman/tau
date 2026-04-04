# Background Tasks Extension

Adds Claude Code-style task backgrounding to pi with **Ctrl+B** support.

## Features

✅ **Ctrl+Shift+B Backgrounding** - Press Ctrl+Shift+B during any running bash command to send it to background  
✅ **Live Process Monitoring** - Widget shows running jobs with elapsed time  
✅ **Completion Notifications** - Get alerted when background jobs finish  
✅ **Output Preservation** - Full stdout/stderr capture for later viewing  
✅ **Job Management** - Kill, monitor, or view output of any background job  
✅ **Session Persistence** - Job history survives pi restarts  
✅ **Dual Mode Support** - Background processes instantly OR mid-execution  

## Installation

The extension is automatically loaded from `~/.pi/agent/extensions/background-tasks/`.

Test it's working:
```bash
pi
# You should see the extension load
# Try: "Run a test command like 'sleep 10 && echo done'"
# Press Ctrl+B while it's running
```

## Usage

### 1. Background Running Commands (Ctrl+B)

```bash
# Start a long-running command
"Run npm run build"

# While it's executing, press Ctrl+Shift+B
[Ctrl+Shift+B]

# Output:
# Process backgrounded as job-1
# Command: npm run build  
# PID: 12345

# Continue working while it runs in background
"What's in package.json?"
```

### 2. Planned Background Commands

```bash
# Start command in background immediately
"Use bash_bg to run 'python train_model.py --epochs 100'"

# Or disable notifications  
"Use bash_bg to run 'cargo build --release' with notify false"
```

### 3. Job Management

```bash
# List all background jobs
"Use jobs to list all background jobs"

# Check specific job output
"Use jobs with action 'output' for job 'job-1'"

# Kill a running job  
"Use jobs with action 'kill' for job 'job-2'"

# Interactive management
"/jobs"
```

## UI Elements

### Widget Display (Above Editor)
```
⏳ job-1: npm run build (2m34s)
⏳ job-2: python train.py (45m12s)
```

### Status Bar
```
🔄 2 running, 1 done, 0 failed
```

### Notifications
```
ℹ️ Process backgrounded as job-1
✅ Background job job-1 completed (89s)
❌ Background job job-2 failed (12s)
```

## Tools Available to LLM

| Tool | Purpose | Parameters |
|------|---------|------------|
| `bash` | Enhanced with backgrounding support | `command` (use Ctrl+Shift+B to background) |
| `bash_bg` | Start command in background immediately | `command`, `notify?` |
| `jobs` | Manage background jobs | `action`: "list"/"kill"/"output", `jobId?` |

## Commands

| Command | Purpose |
|---------|---------|
| `/jobs` | Interactive job management UI |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|---------|
| `Ctrl+Shift+B` | Background current running bash process |

## Example Session

```
User: Run a build that takes forever
Agent: I'll start the build process for you.

bash: npm run build
> Building application...
> [1/10] Compiling...

[User presses Ctrl+Shift+B]

Process backgrounded as job-1
Command: npm run build
PID: 12345

User: While that builds, show me the git log  
Agent: I'll check the git history while your build continues in the background.

bash: git log --oneline -5
a1b2c3d Fix authentication bug
d4e5f6g Add input validation
...

[Widget shows: ⏳ job-1: npm run build (1m23s)]

User: How's the build going?
Agent: Let me check the build output for you.

jobs: list
Background Jobs:
job-1: npm run build - ⏳ running (1m45s)

[Notification: ✅ Background job job-1 completed (2m12s)]

User: Great! What was the output?
Agent: Let me show you the complete build output.

jobs: output job-1
Output for job-1:
Command: npm run build
Status: completed

> Building application...
> [10/10] Optimizing bundle...
> ✅ Build completed successfully!
> Bundle size: 2.3MB
> Build time: 2m10s
```

## Implementation Details

### Process Management
- **Hijacks built-in bash tool** to add backgrounding capability
- **Preserves streaming output** before backgrounding  
- **Process isolation** - background jobs don't interfere with each other
- **Clean shutdown** - terminates all background processes on exit

### State Tracking
- **In-memory job registry** for active management
- **Session persistence** via `appendEntry()` for job history
- **PID tracking** for process control and monitoring
- **Output buffering** for complete capture

### Error Handling
- **Process spawn failures** reported immediately
- **Background job crashes** logged and notified
- **Signal handling** for clean termination
- **State corruption recovery** on session restart

## Troubleshooting

### "No running bash process to background"
- Only bash commands can be backgrounded with Ctrl+Shift+B
- Make sure a bash command is actively running when you press Ctrl+Shift+B

### Background jobs not showing in widget  
- Widget only shows currently running jobs
- Completed/failed jobs are hidden but accessible via `/jobs` command

### Jobs lost after restart
- Only completed/failed job history is preserved across restarts
- Running jobs cannot be restored and will be terminated on shutdown

### Process won't die with kill action
- Some processes ignore SIGTERM - try `kill -9` manually
- Check if process has child processes that need separate termination

## Future Enhancements

- [ ] Process priority management  
- [ ] Resource usage monitoring (CPU/memory)
- [ ] Job scheduling and queuing
- [ ] Multi-server job distribution
- [ ] Log rotation for long-running jobs
- [ ] Job dependency management