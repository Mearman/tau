/**
 * Background jobs feature — bash override, bash_bg, jobs, job_decide tools.
 *
 * Handles background process management, auto-timeout, stall detection,
 * and the pill-bar status widget.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import type { BackgroundJob, RunningProcess, UiContext } from "../types.ts";
import {
    DEFAULT_TIMEOUT_MS,
    MAX_LOG_BYTES,
    MAX_OUTPUT_PREVIEW_CHARS,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    STALL_THRESHOLD_MS,
    createJobDonePromise,
    detectBlockedSleep,
    formatDuration,
    generateJobId,
    isAutoBackgroundAllowed,
    killProcessGroup,
    logPathForJob,
    looksLikePrompt,
    markJobTerminal,
    readOutputTail,
    readOutputTailSync,
    formatJobLine,
} from "../utils.ts";
import {
    attachTmuxContext,
    getTmuxContext,
    killTmuxJob,
    pollTmuxCompletion,
    readTmuxOutput,
    spawnBackgroundTmux,
    spawnForegroundTmux,
    notifyTmuxCompletion,
} from "./bash-tmux.ts";
import { captureOutput } from "../tmux.ts";

// ─── Kill helpers ───────────────────────────────────────────────────

/**
 * Mark a job as killed and suppress the completion notification.
 * Use in every kill path (tool, shortcut, watchdog) to prevent
 * proc.on("close") from sending a spurious job-completion message
 * that re-enters the agent loop.
 */
export function silenceJobAfterKill(job: BackgroundJob): void {
    markJobTerminal(job, "killed");
    job.outputConsumed = true;
}

// ─── Stall watchdog ─────────────────────────────────────────────────

export function startStallWatchdog(
    jobId: string,
    command: string,
    logPath: string,
    pi: ExtensionAPI,
    onOversize?: () => void
): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
    let cancelled = false;

    const timer = setInterval(() => {
        if (cancelled) return;
        try {
            const size = statSync(logPath).size;

            if (size > MAX_LOG_BYTES) {
                cancelled = true;
                clearInterval(timer);
                if (onOversize) onOversize();
                pi.sendMessage(
                    {
                        customType: "bg-stall",
                        content: `⚠️ Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
                return;
            }

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
                return;
            }
            if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
            if (!looksLikePrompt(tail)) {
                lastGrowth = Date.now();
                return;
            }

            cancelled = true;
            clearInterval(timer);

            const summary =
                `Background job ${jobId} appears to be waiting for interactive input.\n` +
                `Command: ${command}\n\n` +
                `Last output:\n${tail.trimEnd()}\n\n` +
                `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
                `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;

            pi.sendMessage(
                {
                    customType: "bg-stall",
                    content: `⚠️ ${summary}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );
        } catch {
            // File may not exist yet — skip this tick
        }
    }, STALL_CHECK_INTERVAL_MS);

    timer.unref();
    return () => {
        cancelled = true;
        clearInterval(timer);
    };
}

/** Check if there are any foreground tasks that can be backgrounded. */
export function hasForegroundTasks(state: TauState): boolean {
    return Array.from(state.backgroundJobs.values()).some(
        (job) => job.status === "running" && !job.isBackgrounded && job.proc
    );
}

// ─── Widget / status bar ────────────────────────────────────────────

export function updateWidget(state: TauState, ctx: UiContext): void {
    const allJobs = Array.from(state.backgroundJobs.values());
    const runningJobs = allJobs.filter((job) => job.status === "running");

    if (runningJobs.length === 0 && !state.agentBackgrounded) {
        ctx.ui.setWidget("background-jobs", undefined);
        ctx.ui.setStatus("background-jobs", undefined);
        return;
    }

    const pills: string[] = [];
    if (state.agentBackgrounded) {
        pills.push("◐ agent (backgrounded)");
    }
    for (const job of runningJobs) {
        const duration = formatDuration(Date.now() - job.startTime);
        const icon = job.isBackgrounded ? "◐" : "▶";
        pills.push(
            `${icon} ${job.id}: ${job.command.slice(0, 25)} (${duration})`
        );
    }
    ctx.ui.setWidget("background-jobs", pills);

    let statusText = `${runningJobs.length} running`;
    if (state.completedJobCount > 0)
        statusText += `, ${state.completedJobCount} done`;
    if (state.failedJobCount > 0)
        statusText += `, ${state.failedJobCount} failed`;

    ctx.ui.setStatus(
        "background-jobs",
        ctx.ui.theme.fg("accent", `◐ ${statusText}`)
    );
}

/**
 * Look up a job by ID. Tries exact match first, then falls back to
 * prepending "job-" to handle LLMs that strip the prefix. Also checks
 * recent terminal jobs for completed/failed/killed lookups.
 */
export function lookupJob(
    state: TauState,
    jobId: string
): BackgroundJob | undefined {
    return (
        state.backgroundJobs.get(jobId) ??
        state.backgroundJobs.get(`job-${jobId}`) ??
        state.recentTerminalJobs.find(
            (j) => j.id === jobId || j.id === `job-${jobId}`
        )
    );
}

/**
 * Clear pendingDecisionJobId if it matches the given job's id.
 * Extracted so both bash_bg close/error handlers and job_decide
 * can share the same logic.
 */
export function clearPendingDecision(
    state: TauState,
    job: BackgroundJob
): void {
    if (state.pendingDecisionJobId === job.id)
        state.pendingDecisionJobId = undefined;
}

/** Maximum number of recent terminal jobs kept for output lookups. */
const MAX_RECENT_TERMINAL = 20;

/** Remove a terminal job from the background jobs map and update counters. */
function removeJob(state: TauState, job: BackgroundJob): void {
    state.backgroundJobs.delete(job.id);
    if (state.pendingDecisionJobId === job.id) {
        state.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") state.completedJobCount++;
    if (job.status === "failed") state.failedJobCount++;
    state.recentTerminalJobs.push(job);
    if (state.recentTerminalJobs.length > MAX_RECENT_TERMINAL) {
        state.recentTerminalJobs.shift();
    }
}

/** Send a structured completion notification to the agent. */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (job.outputConsumed) {
        removeJob(state, job);
        return;
    }
    const duration = formatDuration(Date.now() - job.startTime);
    const emoji = job.status === "completed" ? "✅" : "❌";
    const statusText = `Background ${job.id} ${job.status} (${duration})`;
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
                duration,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );

    removeJob(state, job);
}

// ── Background a running foreground process (signal-based) ─────────

/**
 * Register a foreground process as a background job, start stall watchdog,
 * and set up completion handlers. Called when the background signal wins
 * the Promise.race (timeout or Ctrl+B).
 */
export function registerBackgroundJob(
    proc: import("node:child_process").ChildProcess,
    logPath: string,
    command: string,
    toolCallId: string,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): BackgroundJob {
    const jobId = generateJobId(++state.jobCounter);

    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: proc.pid!,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc,
        toolCallId,
        isBackgrounded: true,
    };
    createJobDonePromise(job);

    // Update existing job registration from foreground to background
    const existingJob = state.backgroundJobs.get(jobId);
    if (existingJob) {
        existingJob.isBackgrounded = true;
    } else {
        state.backgroundJobs.set(jobId, job);
    }
    state.currentlyRunningToolCallId = null;

    const cancelStall = startStallWatchdog(jobId, command, logPath, pi, () => {
        if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
        silenceJobAfterKill(job);
    });

    proc.on("close", (code) => {
        cancelStall();
        markJobTerminal(
            job,
            code === 0 || code === null ? "completed" : "failed",
            code ?? 0
        );
        clearPendingDecision(state, job);
        notifyCompletion(job, state, pi, ctx);
        updateWidget(state, ctx);
    });

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    updateWidget(state, ctx);

    return job;
}

// ── Default timeout timer (signal-based) ─────────────────────────────

/**
 * Start a timer that resolves the background signal after timeoutMs.
 * If the command is not auto-backgroundable, kills the process instead.
 * Returns the timer handle so it can be cleared on early completion.
 */
export function startTimeoutTimer(
    triggerBackground: () => void,
    command: string,
    state: TauState,
    toolCallId: string,
    explicitTimeoutMs?: number
): NodeJS.Timeout {
    const timeoutMs = explicitTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timer = setTimeout(() => {
        // Non-interactive (print/`-p`/non-TTY): there is no agent loop to answer
        // the auto-background job_decide prompt, so never auto-background or kill
        // on timeout — let the command run to completion.
        if (state.nonInteractive) return;

        // Guard: only act if this tool call still has a running process.
        // The global currentlyRunningToolCallId may have been overwritten by
        // a concurrent tool call — that doesn't mean *this* call finished.
        if (!state.runningProcesses.has(toolCallId)) return;

        // If auto-backgrounding is disallowed for this command, kill it
        if (!isAutoBackgroundAllowed(command)) {
            const rp = state.runningProcesses.get(toolCallId);
            if (rp?.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
            return;
        }

        triggerBackground();
    }, timeoutMs);
    timer.unref();
    return timer;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerBackgroundJobs(
    pi: ExtensionAPI,
    state: TauState
): void {
    // ── Override bash tool ─────────────────────────────────────────────

    const originalBashTool = createBashTool(process.cwd());

    pi.registerTool({
        ...originalBashTool,
        name: "bash",
        description:
            "Execute bash commands with streaming output. Commands that run longer than 2 minutes " +
            "are automatically backgrounded and the agent is asked whether to kill or let them continue. " +
            "Use Ctrl+Shift+B to manually background a running process. " +
            "Background job output is written to per-session log files.",
        promptSnippet:
            "Execute shell commands (backgroundable with Ctrl+Shift+B)",
        promptGuidelines: [
            "Use bash_bg when you know a command should run in background from the start.",
            "Use the jobs tool with action 'list' to check background job status.",
            "Use the jobs tool with action 'output' to read a background job's output file.",
        ],

        async execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<BashToolDetails | undefined>> {
            const { command } = params;

            // Validate: block sleep >= 2s
            const sleepMatch = detectBlockedSleep(command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash_bg for long waits. ` +
                        "For pacing < 2s, sleep is fine."
                );
            }

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
                try {
                    return await executeTmuxForeground(
                        toolCallId,
                        command,
                        params,
                        signal,
                        onUpdate,
                        ctx,
                        state,
                        pi
                    );
                } catch {
                    // tmux spawn failed (not in git repo, server error, etc.)
                    // Fall through to direct-spawn path.
                }
            }

            // ── Direct spawn path (fallback when tmux unavailable) ───
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            mkdirSync(dirname(logPath), { recursive: true });

            const logFd = openSync(logPath, "w");
            const proc = spawn("bash", ["-c", command], {
                stdio: ["pipe", logFd, logFd],
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
            });
            closeSync(logFd);

            if (!proc.pid) {
                throw new Error("Failed to spawn process");
            }

            // Background signal — resolved by timeout timer or Ctrl+B
            let backgroundResolve: (() => void) | null = null;
            const backgroundSignal = new Promise<void>((resolve) => {
                backgroundResolve = resolve;
            });

            function triggerBackground(): void {
                backgroundResolve?.();
            }

            // Register as a foreground RunningProcess so Ctrl+B can find it
            const rp: RunningProcess = {
                toolCallId,
                proc,
                command,
                logPath,
                triggerBackground,
            };
            state.runningProcesses.set(toolCallId, rp);
            state.currentlyRunningToolCallId = toolCallId;

            // Register as foreground job in backgroundJobs
            state.backgroundJobs.set(jobId, {
                id: jobId,
                command,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: false,
            });

            // Build process result promise
            const procResult = new Promise<{
                code: number | null;
                interrupted: boolean;
            }>((resolve) => {
                proc.on("close", (code) => {
                    resolve({
                        code,
                        interrupted: code === 137 || code === 143,
                    });
                });
                proc.on("error", () => {
                    resolve({ code: 1, interrupted: false });
                });
            });

            // Abort handler
            if (signal) {
                signal.addEventListener("abort", () => {
                    killProcessGroup(proc.pid!, "SIGTERM");
                });
            }

            // Start timeout timer
            const timer = startTimeoutTimer(
                triggerBackground,
                command,
                state,
                toolCallId,
                typeof params.timeout === "number"
                    ? params.timeout * 1_000
                    : undefined
            );

            // Background hint
            const hintTimer = setTimeout(() => {
                ctx.ui.notify("⏱ Ctrl+B to background", "info");
            }, 2_000);
            hintTimer.unref();

            // File-polling for foreground progress
            const PROGRESS_POLL_MS = 1_000;
            let pollTimer: NodeJS.Timeout | undefined;
            const startPolling = (): void => {
                pollTimer = setInterval(() => {
                    try {
                        const content = readOutputTailSync(logPath, 4_096);
                        if (content && content !== "(no output yet)") {
                            onUpdate?.({
                                content: [
                                    { type: "text" as const, text: content },
                                ],
                                details: undefined,
                            });
                        }
                    } catch {
                        // File may not be readable yet
                    }
                }, PROGRESS_POLL_MS);
                pollTimer.unref();
            };

            try {
                // Wait for initial output or quick completion (2s threshold)
                const initialResult = await Promise.race([
                    procResult,
                    new Promise<null>((resolve) => {
                        const t = setTimeout(
                            resolve,
                            2_000
                        ) as unknown as NodeJS.Timeout;
                        t.unref();
                    }),
                ]);

                // Command completed quickly — return result
                if (initialResult !== null) {
                    state.backgroundJobs.delete(jobId);
                    const output = await readFile(logPath, "utf-8").catch(
                        () => ""
                    );
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: output || "(no output)",
                            },
                        ],
                        details: undefined,
                    };
                }

                // Command still running — start polling for progress
                startPolling();

                // Race: completion vs background signal
                const raceResult = await Promise.race([
                    procResult.then((r) => ({
                        type: "completed" as const,
                        ...r,
                    })),
                    backgroundSignal.then(() => ({
                        type: "backgrounded" as const,
                    })),
                ]);

                if (raceResult.type === "backgrounded") {
                    // Clean up foreground state
                    clearInterval(pollTimer);
                    clearTimeout(timer);
                    clearTimeout(hintTimer);
                    state.runningProcesses.delete(toolCallId);

                    // Register as background job with completion handlers
                    const job = registerBackgroundJob(
                        proc,
                        logPath,
                        command,
                        toolCallId,
                        state,
                        pi,
                        ctx
                    );

                    state.pendingDecisionJobId = job.id;

                    const duration = formatDuration(
                        typeof params.timeout === "number"
                            ? params.timeout * 1_000
                            : DEFAULT_TIMEOUT_MS
                    );
                    pi.sendMessage(
                        {
                            customType: "bg-timeout",
                            content:
                                `⏰ Command timed out after ${duration} and has been backgrounded as ${job.id}.\n` +
                                `Command: ${command}\n` +
                                `PID: ${job.pid}\n` +
                                `Output so far: ${job.logPath}\n\n` +
                                `Use the job_decide tool with jobId "${job.id}" to decide:\n` +
                                `- decision "check": inspect the output first\n` +
                                `- decision "keep": let it continue running\n` +
                                `- decision "kill": terminate it\n\n` +
                                `Do NOT use jobs action "attach" on this job — it will block indefinitely.`,
                            display: true,
                            details: {
                                jobId: job.id,
                                logPath: job.logPath,
                                command,
                            },
                        },
                        { deliverAs: "followUp", triggerTurn: true }
                    );

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Process backgrounded as ${job.id}\nCommand: ${command}\nPID: ${job.pid}\nOutput: ${job.logPath}`,
                            },
                        ],
                        details: undefined,
                    };
                }

                // Command completed normally
                clearInterval(pollTimer);
                clearTimeout(timer);
                clearTimeout(hintTimer);
                state.runningProcesses.delete(toolCallId);
                if (state.currentlyRunningToolCallId === toolCallId) {
                    state.currentlyRunningToolCallId = null;
                }
                // Remove foreground job registration
                state.backgroundJobs.delete(jobId);

                const output = await readFile(logPath, "utf-8").catch(() => "");

                if (
                    raceResult.code !== 0 &&
                    raceResult.code !== null &&
                    !raceResult.interrupted
                ) {
                    throw new Error(
                        output || `Command exited with code ${raceResult.code}`
                    );
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: output || "(no output)",
                        },
                    ],
                    details: undefined,
                };
            } finally {
                clearInterval(pollTimer);
                clearTimeout(timer);
                clearTimeout(hintTimer);
            }
        },
    });

    // ── bash_bg tool ────────────────────────────────────────────────────

    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Run a bash command in background immediately. Output is written to a per-session log file. " +
            "Use the jobs tool to check status and read output.",
        promptSnippet:
            "Run bash command in background without blocking conversation",
        promptGuidelines: [
            "Use bash_bg when you want to start a long-running command in background immediately.",
            "This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Command to run in background",
            }),
            notify: Type.Optional(
                Type.Boolean({
                    description: "Notify when complete (default: true)",
                })
            ),
        }),

        async execute(
            toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<undefined>> {
            const shouldNotify = params.notify !== false;

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
                const job = spawnBackgroundTmux(
                    params.command,
                    ctx.cwd,
                    toolCallId,
                    state,
                    pi,
                    ctx,
                    (jobId, command, logPath) =>
                        startStallWatchdog(jobId, command, logPath, pi, () => {
                            killTmuxJob(
                                state.backgroundJobs.get(jobId) ??
                                    ({
                                        id: jobId,
                                        command,
                                        pid: -1,
                                        startTime: Date.now(),
                                        status: "running",
                                        logPath,
                                        toolCallId,
                                        isBackgrounded: true,
                                    } satisfies BackgroundJob)
                            );
                        })
                );

                updateWidget(state, ctx);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Started background job ${job.id}\nCommand: ${params.command}\nOutput: ${job.logPath}`,
                        },
                    ],
                    details: undefined,
                };
            }

            // ── Direct spawn path (fallback) ──────────────────────────
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);

            const logFd = openSync(logPath, "w");
            const proc = spawn("bash", ["-c", params.command], {
                stdio: ["pipe", logFd, logFd],
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
            });
            closeSync(logFd);

            if (!proc.pid) {
                throw new Error("Failed to spawn background process");
            }

            const job: BackgroundJob = {
                id: jobId,
                command: params.command,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: true,
            };
            createJobDonePromise(job);
            state.backgroundJobs.set(jobId, job);

            const cancelStall = startStallWatchdog(
                jobId,
                params.command,
                logPath,
                pi,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job);
                }
            );

            proc.on("close", (code) => {
                cancelStall();
                markJobTerminal(
                    job,
                    code === 0 || code === null ? "completed" : "failed",
                    code ?? 0
                );
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            });

            proc.on("error", () => {
                cancelStall();
                markJobTerminal(job, "failed");
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            });

            updateWidget(state, ctx);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Started background job ${jobId}\nCommand: ${params.command}\nPID: ${proc.pid}\nOutput: ${logPath}`,
                    },
                ],
                details: undefined,
            };
        },
    });

    // ── jobs tool ───────────────────────────────────────────────────────

    pi.registerTool({
        name: "jobs",
        label: "Background Jobs",
        description:
            "List, inspect, kill, or attach to background jobs. Output is read from disk files.",
        promptSnippet: "Manage background jobs (list/output/kill/attach)",
        promptGuidelines: [
            "Use jobs with action 'list' to see all background jobs.",
            "Use jobs with action 'output' to read a job's output from its log file.",
            "Use jobs with action 'kill' to terminate a running background job.",
            "Use jobs with action 'attach' to wait for a running job and get its final output.",
        ],
        parameters: Type.Object({
            action: StringEnum(["list", "output", "kill", "attach"] as const, {
                description: "Action to perform",
            }),
            jobId: Type.Optional(
                Type.String({
                    description: "Job ID for output/kill/attach",
                })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description:
                        "For attach: wait for completion (default true)",
                })
            ),
        }),

        async execute(
            _toolCallId,
            params,
            signal,
            onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            switch (params.action) {
                case "list": {
                    const running = Array.from(state.backgroundJobs.values());
                    const recent = state.recentTerminalJobs.slice(-5).reverse();
                    const lines = [
                        ...running.map((j) => formatJobLine(j)),
                        ...recent.map((j) => formatJobLine(j)),
                    ];
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    lines.length > 0
                                        ? `Background Jobs:\n${lines.join("\n")}`
                                        : "No background jobs",
                            },
                        ],
                        details: undefined,
                    };
                }

                case "output": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=output");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);
                    const output = getTmuxContext(job)
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Output for ${job.id} (${job.status})\nLog: ${job.logPath}\n\n${output}`,
                            },
                        ],
                        details: undefined,
                    };
                }

                case "kill": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=kill");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);

                    // Tmux jobs don't have proc — kill via tmux window.
                    const tmuxCtx = getTmuxContext(job);
                    if (tmuxCtx) {
                        killTmuxJob(job);
                    } else if (job.proc && job.status === "running") {
                        killProcessGroup(job.proc.pid!, "SIGTERM");
                    } else {
                        throw new Error(`Job is not running: ${job.id}`);
                    }
                    silenceJobAfterKill(job);
                    clearPendingDecision(state, job);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: tmuxCtx
                                    ? `Killed tmux window ${tmuxCtx.windowId} for ${job.id}`
                                    : `Sent SIGTERM to ${job.id} (process group)`,
                            },
                        ],
                        details: undefined,
                    };
                }

                case "attach": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=attach");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);

                    const waitForCompletion = params.wait ?? true;
                    const skipWait =
                        state.pendingDecisionJobId === job.id &&
                        job.status === "running";

                    if (
                        job.status === "running" &&
                        waitForCompletion &&
                        !skipWait
                    ) {
                        if (!job.donePromise) createJobDonePromise(job);

                        // For direct-spawn jobs, check if OS process is already dead.
                        // Tmux jobs (pid === -1) skip this check — completion is
                        // detected via the exit-code sentinel file.
                        if (job.pid > 0) {
                            try {
                                process.kill(job.pid, 0);
                            } catch {
                                markJobTerminal(job, "failed");
                            }
                        }

                        onUpdate?.({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Attaching to ${job.id} (${job.status})...`,
                                },
                            ],
                            details: undefined,
                        });

                        // Race completion against abort so Esc cancels the attach
                        if (signal && !signal.aborted) {
                            const abortPromise = new Promise<void>(
                                (resolve) => {
                                    signal.addEventListener(
                                        "abort",
                                        () => resolve(),
                                        {
                                            once: true,
                                        }
                                    );
                                }
                            );
                            await Promise.race([job.donePromise, abortPromise]);
                        } else {
                            await job.donePromise;
                        }
                    }

                    const output = getTmuxContext(job)
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    job.outputConsumed = true;
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Attach finished for ${job.id}. Status: ${job.status}\nLog: ${job.logPath}\n\n${output}`,
                            },
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });

    // ── job_decide tool ─────────────────────────────────────────────────

    pi.registerTool({
        name: "job_decide",
        label: "Job Decision",
        description:
            "Decide what to do with a background job that timed out. Use this when prompted after a command is backgrounded.",
        promptSnippet: "Decide on a timed-out background job",
        promptGuidelines: [
            "Use job_decide with decision 'keep' to let the job continue running in the background.",
            "Use job_decide with decision 'kill' to terminate the job.",
            "Use job_decide with decision 'check' to see the job's current output before deciding.",
        ],
        parameters: Type.Object({
            jobId: Type.String({
                description: "The job ID to decide on",
            }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description:
                    "keep = let it run, kill = terminate it, check = inspect output first",
            }),
        }),

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            const job = lookupJob(state, params.jobId);
            if (!job) {
                state.pendingDecisionJobId = undefined;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Job ${params.jobId} not found.`,
                        },
                    ],
                    details: undefined,
                };
            }

            switch (params.decision) {
                case "kill": {
                    // Tmux jobs don't have proc — kill via tmux window.
                    const tmuxCtx = getTmuxContext(job);
                    if (tmuxCtx) {
                        killTmuxJob(job);
                    } else if (job.proc && job.status === "running") {
                        killProcessGroup(job.proc.pid!, "SIGTERM");
                    }
                    silenceJobAfterKill(job);
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [{ type: "text", text: `Killed ${job.id}.` }],
                        details: undefined,
                    };
                }
                case "keep": {
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Keeping ${job.id} running in the background. Use the jobs tool to check on it later.`,
                            },
                        ],
                        details: undefined,
                    };
                }
                case "check": {
                    const output = getTmuxContext(job)
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Output of ${job.id}:\n${output}`,
                            },
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });
}

// ─── Tmux foreground execution ──────────────────────────────────────

/**
 * Execute a bash command in the foreground using tmux.
 *
 * Spawns the command inside a tmux window and polls the exit-code
 * sentinel file for completion. On timeout, the tmux window stays
 * alive — no foreground→background race window.
 */
async function executeTmuxForeground(
    toolCallId: string,
    command: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: { cwd: string } & UiContext,
    state: TauState,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const jobId = `tmux-${process.pid}-${++state.jobCounter}`;
    let logPath: string;
    let tmuxCtx: import("./bash-tmux.ts").TmuxJobContext;

    try {
        const result = spawnForegroundTmux(command, ctx.cwd);
        logPath = result.logPath;
        tmuxCtx = result.tmuxCtx;
    } catch {
        // Not in a git repo — fall back to direct spawn.
        state.jobCounter--;
        throw new Error(
            "tmux backend requires a git repository. " +
                "Falling back to direct process management."
        );
    }

    // Register as foreground job
    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1, // tmux — no single PID
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: false,
    };
    createJobDonePromise(job);
    attachTmuxContext(job, tmuxCtx);
    state.backgroundJobs.set(jobId, job);

    // Ctrl+B background signal
    let backgroundResolve: (() => void) | null = null;
    const backgroundSignal = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
    });

    function triggerBackground(): void {
        backgroundResolve?.();
    }

    // Register so Ctrl+B can find this job
    // Tmux jobs don't have a ChildProcess, so we store a minimal RunningProcess
    // that can trigger backgrounding.
    state.runningProcesses.set(toolCallId, {
        toolCallId,
        proc: { pid: -1 } as never, // sentinel — not a real process
        command,
        logPath,
        triggerBackground,
    });
    state.currentlyRunningToolCallId = toolCallId;

    // Abort handler — kill tmux window
    if (signal) {
        signal.addEventListener("abort", () => {
            killTmuxJob(job);
        });
    }

    // Timeout timer
    const timeoutMs =
        typeof params.timeout === "number"
            ? params.timeout * 1_000
            : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
        // Non-interactive (print/`-p`/non-TTY): no agent loop to answer the
        // auto-background job_decide prompt, so let the command run to
        // completion instead of backgrounding or killing it on timeout.
        if (state.nonInteractive) return;
        if (!state.runningProcesses.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killTmuxJob(job);
            return;
        }
        triggerBackground();
    }, timeoutMs);
    timer.unref();

    // Background hint
    const hintTimer = setTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+B to background", "info");
    }, 2_000);
    hintTimer.unref();

    // Progress polling
    const PROGRESS_POLL_MS = 1_000;
    let pollTimer: NodeJS.Timeout | undefined;
    const startPolling = (): void => {
        pollTimer = setInterval(() => {
            try {
                const content = readOutputTailSync(logPath, 4_096);
                if (content && content !== "(no output yet)") {
                    onUpdate?.({
                        content: [{ type: "text" as const, text: content }],
                        details: undefined,
                    });
                }
            } catch {
                // File may not be readable yet
            }
        }, PROGRESS_POLL_MS);
        pollTimer.unref();
    };

    // Completion polling — check the exit-code sentinel
    const completionPromise = new Promise<number | null>((resolve) => {
        const check = setInterval(() => {
            const code = checkExitCode(tmuxCtx.exitCodeFile);
            if (code !== undefined) {
                clearInterval(check);
                resolve(code);
            }
        }, 200);
        check.unref();
    });

    try {
        // Wait for initial output or quick completion (2s threshold)
        const initialResult = await Promise.race([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = setTimeout(
                    resolve,
                    2_000
                ) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        // Command completed quickly
        if (initialResult !== null) {
            state.backgroundJobs.delete(jobId);
            const output = captureOutput(
                tmuxCtx.windowId,
                2000,
                tmuxCtx.outputFile
            );
            // Clean up tmux window. Keep the session alive so the next
            // spawnInTmux call reuses it via new-window instead of creating
            // a fresh session — avoids tmux server state accumulation across
            // hundreds of create/destroy cycles which causes fork()+waitpid()
            // deadlocks (child exits but parent waitpid never returns).
            killWindow(tmuxCtx.windowId);
            if (initialResult !== 0 && initialResult !== null) {
                throw new Error(
                    output || `Command exited with code ${initialResult}`
                );
            }
            return {
                content: [
                    { type: "text" as const, text: output || "(no output)" },
                ],
                details: undefined,
            };
        }

        // Command still running — start polling for progress
        startPolling();

        // Race: completion vs background signal
        const raceResult = await Promise.race([
            completionPromise.then((code) => ({
                type: "completed" as const,
                code,
            })),
            backgroundSignal.then(() => ({
                type: "backgrounded" as const,
                code: undefined as number | undefined,
            })),
        ]);

        if (raceResult.type === "backgrounded") {
            clearInterval(pollTimer);
            clearTimeout(timer);
            clearTimeout(hintTimer);
            state.runningProcesses.delete(toolCallId);

            // Mark as backgrounded — the completion poller in bash-tmux will handle notification.
            // Start the background completion poller.
            job.isBackgrounded = true;
            state.currentlyRunningToolCallId = null;

            // Start stall watchdog
            startStallWatchdog(jobId, command, logPath, pi, () => {
                killTmuxJob(job);
            });

            // Start background completion poller
            const bgPoller = setInterval(() => {
                const result = pollTmuxCompletion(job);
                if (!result.completed) return;
                clearInterval(bgPoller);
                markJobTerminal(
                    job,
                    result.exitCode === 0 || result.exitCode === null
                        ? "completed"
                        : "failed",
                    result.exitCode ?? 0
                );
                notifyTmuxCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            }, 500);
            bgPoller.unref();

            state.pendingDecisionJobId = jobId;

            const duration = formatDuration(timeoutMs);
            pi.sendMessage(
                {
                    customType: "bg-timeout",
                    content:
                        `⏰ Command timed out after ${duration} and has been backgrounded as ${jobId}.\n` +
                        `Command: ${command}\n` +
                        `Tmux window: ${tmuxCtx.windowId}\n` +
                        `Output so far: ${logPath}\n\n` +
                        `Use the job_decide tool with jobId "${jobId}" to decide:\n` +
                        `- decision "check": inspect the output first\n` +
                        `- decision "keep": let it continue running\n` +
                        `- decision "kill": terminate it\n\n` +
                        `You can attach to the tmux window with: tmux attach -t ${tmuxCtx.windowId}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );

            updateWidget(state, ctx);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Process backgrounded as ${jobId}\nCommand: ${command}\nTmux window: ${tmuxCtx.windowId}\nOutput: ${logPath}`,
                    },
                ],
                details: undefined,
            };
        }

        // Command completed normally
        clearInterval(pollTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
        state.runningProcesses.delete(toolCallId);
        if (state.currentlyRunningToolCallId === toolCallId) {
            state.currentlyRunningToolCallId = null;
        }
        state.backgroundJobs.delete(jobId);

        const output = captureOutput(
            tmuxCtx.windowId,
            2000,
            tmuxCtx.outputFile
        );
        killWindow(tmuxCtx.windowId);
        // Session is intentionally kept alive — reuse avoids tmux server
        // state accumulation that causes waitpid deadlocks.

        if (raceResult.code !== 0 && raceResult.code !== null) {
            throw new Error(
                output || `Command exited with code ${raceResult.code}`
            );
        }

        return {
            content: [{ type: "text" as const, text: output || "(no output)" }],
            details: undefined,
        };
    } finally {
        clearInterval(pollTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
    }
}

// ─── Helpers used by executeTmuxForeground ──────────────────────────

import { checkExitCode, killWindow } from "../tmux.ts";
