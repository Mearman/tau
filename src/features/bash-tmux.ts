/**
 * Tmux-backed bash execution backend.
 *
 * Spawns commands inside tmux windows instead of direct child processes.
 * This eliminates the foreground→background output race window (tmux owns
 * the process lifecycle) and lets users attach to running commands with
 * `tmux attach`.
 *
 * Used by background.ts when tmux is available. Falls back to direct
 * child-process spawning when tmux is absent.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob, UiContext } from "../types.ts";
import {
    createJobDonePromise,
    markJobTerminal,
    readOutputTail,
} from "../utils.ts";
import {
    captureOutput,
    checkExitCode,
    getGitRoot,
    killWindow,
    sessionNameForGitRoot,
    spawnInTmux,
} from "../tmux.ts";

/** Per-run directory for exit-code sentinels and output files. */
function runDirPath(): string {
    const dir = `/tmp/pi-tmux-${process.pid}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/** Clean up the run directory on shutdown. Preserves output files for running jobs. */
export function cleanupTmuxRunDir(): void {
    const dir = `/tmp/pi-tmux-${process.pid}`;
    // Don't remove the run directory if there are still running tmux jobs.
    // The sentinel files and output need to stay alive for the completion poller.
    // Instead, clean up only the script directory.
    const scriptDir = join(dir, "s");
    try {
        rmSync(scriptDir, { recursive: true, force: true });
    } catch {
        /* already gone */
    }
}

/** Clean up run directories from dead pi processes. Called on session startup. */
export function cleanupStaleTmuxRunDirs(): void {
    const entries = readdirSync("/tmp").filter((e) => e.startsWith("pi-tmux-"));
    for (const entry of entries) {
        const pid = parseInt(entry.replace("pi-tmux-", ""), 10);
        // Skip our own process
        if (pid === process.pid) continue;
        // Check if the process is still alive
        try {
            process.kill(pid, 0);
            continue; // alive — don't touch
        } catch {
            // dead — clean up
        }
        const dir = join("/tmp", entry);
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* permission error or concurrent cleanup */
        }
        // Also kill any tmux session that belonged to this dead process.
        // Sessions are named pi-bg-<slug>-<hash>, but we can't derive the name
        // from the PID alone. Instead, kill sessions whose panes are all dead.
    }
    // Kill orphaned pi-bg sessions (all panes dead)
    try {
        const sessions = execSync("tmux list-sessions -F '#{session_name}'", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "pipe"],
        })
            .trim()
            .split("\n")
            .filter((s) => s.startsWith("pi-bg-"));
        for (const session of sessions) {
            const panePids = execSync(
                `tmux list-panes -t ${session} -F '#{pane_pid}'`,
                {
                    encoding: "utf-8",
                    timeout: 3000,
                    stdio: ["ignore", "pipe", "pipe"],
                }
            )
                .trim()
                .split("\n")
                .map((p) => parseInt(p, 10));
            const allDead = panePids.every((pid) => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            });
            if (allDead) {
                execSync(`tmux kill-session -t ${session}`, {
                    timeout: 3000,
                    stdio: "ignore",
                });
            }
        }
    } catch {
        /* tmux not available or no sessions */
    }
}

/**
 * Context for a tmux-backed running command.
 * Stored on the BackgroundJob so the tmux backend can manage the window lifecycle.
 */
export interface TmuxJobContext {
    /** The tmux session name. */
    session: string;
    /** The tmux window ID (e.g. "@3"). */
    windowId: string;
    /** The exit-code sentinel file path. */
    exitCodeFile: string;
    /** The output file path (tee'd from the command). */
    outputFile: string;
    /** The git root (used for session scoping). */
    gitRoot: string;
}

/**
 * Attach tmux context to a job so kill/completion can find it later.
 */
export function attachTmuxContext(
    job: BackgroundJob,
    ctx: TmuxJobContext
): void {
    (job as unknown as { tmux: TmuxJobContext }).tmux = ctx;
}

/**
 * Retrieve the tmux context from a job, if any.
 */
export function getTmuxContext(job: BackgroundJob): TmuxJobContext | undefined {
    return (job as unknown as { tmux?: TmuxJobContext }).tmux;
}

/**
 * Poll for exit-code completion of a tmux-backed background job.
 * Called by the stall watchdog tick to detect completed commands.
 */
export function pollTmuxCompletion(job: BackgroundJob): {
    completed: boolean;
    exitCode?: number;
} {
    const ctx = getTmuxContext(job);
    if (!ctx) return { completed: false };

    const code = checkExitCode(ctx.exitCodeFile);
    if (code === undefined) return { completed: false };

    return { completed: true, exitCode: code };
}

/**
 * Kill a tmux-backed job by killing its tmux window.
 */
export function killTmuxJob(job: BackgroundJob): void {
    const ctx = getTmuxContext(job);
    if (ctx) killWindow(ctx.windowId);
}

/**
 * Read output from a tmux-backed job.
 */
export function readTmuxOutput(
    job: BackgroundJob,
    maxChars: number
): Promise<string> {
    const ctx = getTmuxContext(job);
    if (ctx) {
        const output = captureOutput(ctx.windowId, 2000, ctx.outputFile);
        if (output.length <= maxChars) return Promise.resolve(output);
        return Promise.resolve(
            `...[truncated, showing last ${maxChars} chars]\n${output.slice(-maxChars)}`
        );
    }
    return readOutputTail(job.logPath, maxChars);
}

/**
 * Spawn a bash command in a tmux window (foreground mode).
 *
 * Returns immediately with the tmux context. The caller is responsible for
 * waiting for completion via the exit-code sentinel file.
 */
export function spawnForegroundTmux(
    command: string,
    cwd: string
): {
    tmuxCtx: TmuxJobContext;
    logPath: string;
    proc?: never; // tmux jobs don't have a Node ChildProcess
} {
    const gitRoot = getGitRoot(cwd);
    // If not in a git repo, fall through to direct spawn.
    // The caller should check for this.
    if (!gitRoot) {
        throw new Error(
            "Not in a git repository — tmux backend requires a git root for session naming."
        );
    }

    const session = sessionNameForGitRoot(gitRoot);
    const runDir = runDirPath();
    const result = spawnInTmux(command, cwd, runDir, session);

    // The log path points to the tee'd output file.
    const logPath = result.outputFile;

    return {
        tmuxCtx: {
            session,
            windowId: result.windowId,
            exitCodeFile: result.exitCodeFile,
            outputFile: result.outputFile,
            gitRoot,
        },
        logPath,
    };
}

/**
 * Spawn a bash command in a tmux window (background mode).
 *
 * Sets up completion detection and returns the job.
 */
export function spawnBackgroundTmux(
    command: string,
    cwd: string,
    toolCallId: string,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext,
    onStartStallWatchdog: (
        jobId: string,
        command: string,
        logPath: string
    ) => () => void
): BackgroundJob {
    const { tmuxCtx, logPath } = spawnForegroundTmux(command, cwd);

    const jobId = `tmux-${process.pid}-${++state.jobCounter}`;
    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1, // No single PID — tmux owns the process
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: true,
    };
    createJobDonePromise(job);
    attachTmuxContext(job, tmuxCtx);
    state.backgroundJobs.set(jobId, job);

    // Start stall watchdog (reuses Tau's existing interactive-prompt detection).
    const cancelStall = onStartStallWatchdog(jobId, command, logPath);

    // Poll for exit-code completion every 500ms.
    const pollTimer = setInterval(() => {
        const result = pollTmuxCompletion(job);
        if (!result.completed) return;

        clearInterval(pollTimer);
        cancelStall();
        markJobTerminal(
            job,
            result.exitCode === 0 || result.exitCode === null
                ? "completed"
                : "failed",
            result.exitCode ?? 0
        );
        notifyTmuxCompletion(job, state, pi, ctx);
    }, 500);
    pollTimer.unref();

    return job;
}

/**
 * Send a completion notification for a tmux-backed job.
 * Extracted so the stall watchdog can also trigger it.
 */
export function notifyTmuxCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (job.outputConsumed) {
        // Job was killed — suppress notification and clean up window.
        const tmuxCtx = getTmuxContext(job);
        if (tmuxCtx) killWindow(tmuxCtx.windowId);
        state.backgroundJobs.delete(job.id);
        if (job.status === "completed") state.completedJobCount++;
        if (job.status === "failed") state.failedJobCount++;
        state.recentTerminalJobs.push(job);
        if (state.recentTerminalJobs.length > 20)
            state.recentTerminalJobs.shift();
        return;
    }

    const duration = Date.now() - job.startTime;
    const mins = Math.floor(duration / 60000);
    const secs = Math.floor((duration % 60000) / 1000);
    const durationText = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    const emoji = job.status === "completed" ? "✅" : "❌";
    const statusText = `Background ${job.id} ${job.status} (${durationText})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(statusText, job.status === "completed" ? "success" : "error");

    pi.sendMessage(
        {
            customType: "job-completion",
            content:
                `${emoji} ${statusText}\n` +
                `Command: ${job.command}\n` +
                `Output: ${job.logPath}${exitCodeText}`,
            display: true,
            details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
                duration: durationText,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "followUp", triggerTurn: true } as never
    );

    // Clean up the tmux window now the command has finished.
    const tmuxCtx = getTmuxContext(job);
    if (tmuxCtx) killWindow(tmuxCtx.windowId);

    state.backgroundJobs.delete(job.id);
    if (job.status === "completed") state.completedJobCount++;
    if (job.status === "failed") state.failedJobCount++;
    state.recentTerminalJobs.push(job);
    if (state.recentTerminalJobs.length > 20) state.recentTerminalJobs.shift();
}
