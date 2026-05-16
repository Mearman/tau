/**
 * Background jobs feature — bash override, bash_bg, jobs, job_decide tools.
 *
 * Handles background process management, auto-timeout, stall detection,
 * and the pill-bar status widget.
 */

import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync, statSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
    formatDuration,
    generateJobId,
    killProcessGroup,
    logPathForJob,
    looksLikePrompt,
    markJobTerminal,
    readOutputTail,
    readOutputTailSync,
    formatJobLine,
} from "../utils.ts";

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

function startStallWatchdog(
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
        pills.push(`◐ ${job.id}: ${job.command.slice(0, 25)} (${duration})`);
    }
    ctx.ui.setWidget("background-jobs", pills);

    const completedJobs = allJobs.filter(
        (job) => job.status === "completed"
    ).length;
    const failedJobs = allJobs.filter((job) => job.status === "failed").length;

    let statusText = `${runningJobs.length} running`;
    if (completedJobs > 0) statusText += `, ${completedJobs} done`;
    if (failedJobs > 0) statusText += `, ${failedJobs} failed`;

    ctx.ui.setStatus(
        "background-jobs",
        ctx.ui.theme.fg("accent", `◐ ${statusText}`)
    );
}

/**
 * Look up a job by ID. Tries exact match first, then falls back to
 * prepending "job-" to handle LLMs that strip the prefix.
 */
export function lookupJob(
    state: TauState,
    jobId: string
): BackgroundJob | undefined {
    return (
        state.backgroundJobs.get(jobId) ??
        state.backgroundJobs.get(`job-${jobId}`)
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

/** Send a structured completion notification to the agent. */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (job.outputConsumed) return;
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
}

// ── Background a running foreground process ────────────────────────

export function backgroundProcess(
    rp: RunningProcess,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    const jobId = generateJobId(++state.jobCounter);
    const logPath = logPathForJob(jobId);

    const job: BackgroundJob = {
        id: jobId,
        command: rp.command,
        pid: rp.proc.pid!,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc: rp.proc,
        toolCallId: rp.toolCallId,
    };
    createJobDonePromise(job);

    rp.backgrounded = true;
    state.backgroundJobs.set(jobId, job);
    state.currentlyRunningToolCallId = null;

    if (rp.stdoutListener)
        rp.proc.stdout?.removeListener("data", rp.stdoutListener);
    if (rp.stderrListener)
        rp.proc.stderr?.removeListener("data", rp.stderrListener);

    rp.logStream = createWriteStream(logPath, { flags: "w" });
    rp.logStream.write(rp.output);
    rp.proc.stdout?.pipe(rp.logStream, { end: false });
    rp.proc.stderr?.pipe(rp.logStream, { end: false });

    const cancelStall = startStallWatchdog(
        jobId,
        rp.command,
        logPath,
        pi,
        () => {
            if (rp.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
            silenceJobAfterKill(state.backgroundJobs.get(jobId)!);
        }
    );

    rp.proc.on("close", () => {
        cancelStall();
        if (rp.logStream) {
            rp.logStream.end();
            rp.logStream = undefined;
        }
    });

    if (rp.resolve) {
        rp.resolve({
            content: [
                {
                    type: "text" as const,
                    text: `Process backgrounded as ${jobId}\nCommand: ${rp.command}\nPID: ${job.pid}\nOutput: ${logPath}`,
                },
            ],
            details: undefined,
        });
    }

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    updateWidget(state, ctx);
}

// ── Default timeout timer ─────────────────────────────────────────

function startTimeoutTimer(
    rp: RunningProcess,
    state: TauState,
    pi: ExtensionAPI,
    ctx: ExtensionContext
): NodeJS.Timeout {
    const timer = setTimeout(() => {
        if (state.currentlyRunningToolCallId !== rp.toolCallId) return;
        if (rp.backgrounded) return;

        backgroundProcess(rp, state, pi, ctx);

        const job = Array.from(state.backgroundJobs.values()).find(
            (j) => j.toolCallId === rp.toolCallId
        );
        if (!job) return;

        state.pendingDecisionJobId = job.id;

        const duration = formatDuration(DEFAULT_TIMEOUT_MS);
        pi.sendMessage(
            {
                customType: "bg-timeout",
                content:
                    `⏰ Command timed out after ${duration} and has been backgrounded as ${job.id}.\n` +
                    `Command: ${rp.command}\n` +
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
                    command: rp.command,
                },
            },
            { deliverAs: "followUp", triggerTurn: true }
        );
    }, DEFAULT_TIMEOUT_MS);
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

            return new Promise<AgentToolResult<BashToolDetails | undefined>>(
                (resolve, reject) => {
                    const proc = spawn("bash", ["-c", command], {
                        stdio: ["pipe", "pipe", "pipe"],
                        cwd: ctx.cwd,
                        detached: true,
                        env: { ...process.env },
                    });

                    if (!proc.pid) {
                        reject(new Error("Failed to spawn process"));
                        return;
                    }

                    const rp: RunningProcess = {
                        toolCallId,
                        proc,
                        command,
                        backgrounded: false,
                        output: "",
                        resolve: resolve as (
                            result: AgentToolResult<unknown>
                        ) => void,
                        reject,
                    };

                    state.runningProcesses.set(toolCallId, rp);
                    state.currentlyRunningToolCallId = toolCallId;

                    function handleData(data: Buffer): void {
                        const chunk = data.toString();
                        rp.output += chunk;
                        onUpdate?.({
                            content: [
                                { type: "text" as const, text: rp.output },
                            ],
                            details: undefined,
                        });
                    }

                    const stdoutListener = (data: Buffer) => handleData(data);
                    const stderrListener = (data: Buffer) => handleData(data);
                    rp.stdoutListener = stdoutListener;
                    rp.stderrListener = stderrListener;
                    proc.stdout?.on("data", stdoutListener);
                    proc.stderr?.on("data", stderrListener);

                    proc.on("close", (code) => {
                        state.runningProcesses.delete(toolCallId);
                        if (state.currentlyRunningToolCallId === toolCallId) {
                            state.currentlyRunningToolCallId = null;
                        }
                        if (rp.logStream) {
                            rp.logStream.end();
                            rp.logStream = undefined;
                        }

                        if (rp.backgrounded) {
                            const job = Array.from(
                                state.backgroundJobs.values()
                            ).find((j) => j.toolCallId === toolCallId);
                            if (job) {
                                markJobTerminal(
                                    job,
                                    code === 0 || code === null
                                        ? "completed"
                                        : "failed",
                                    code ?? 0
                                );
                                clearPendingDecision(state, job);
                                notifyCompletion(job, state, pi, ctx);
                                updateWidget(state, ctx);
                            }
                        } else {
                            resolve({
                                content: [
                                    {
                                        type: "text" as const,
                                        text: rp.output || "(no output)",
                                    },
                                ],
                                details: undefined,
                            });
                        }
                    });

                    proc.on("error", (err) => {
                        state.runningProcesses.delete(toolCallId);
                        if (state.currentlyRunningToolCallId === toolCallId) {
                            state.currentlyRunningToolCallId = null;
                        }
                        if (rp.logStream) {
                            rp.logStream.end();
                            rp.logStream = undefined;
                        }

                        if (rp.backgrounded) {
                            const job = Array.from(
                                state.backgroundJobs.values()
                            ).find((j) => j.toolCallId === toolCallId);
                            if (job) {
                                markJobTerminal(job, "failed");
                                clearPendingDecision(state, job);
                                notifyCompletion(job, state, pi, ctx);
                                updateWidget(state, ctx);
                            }
                        } else {
                            reject(err);
                        }
                    });

                    if (signal) {
                        signal.addEventListener("abort", () => {
                            if (!rp.backgrounded) {
                                killProcessGroup(proc.pid!, "SIGTERM");
                                state.runningProcesses.delete(toolCallId);
                                if (
                                    state.currentlyRunningToolCallId ===
                                    toolCallId
                                ) {
                                    state.currentlyRunningToolCallId = null;
                                }
                                reject(new Error("Command cancelled"));
                            }
                        });
                    }

                    startTimeoutTimer(rp, state, pi, ctx);

                    const hintTimer = setTimeout(() => {
                        ctx.ui.notify("⏱ Ctrl+B to background", "info");
                    }, 2_000);
                    hintTimer.unref();
                    rp.proc.on("close", () => {
                        clearTimeout(hintTimer);
                    });
                }
            );
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
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            const shouldNotify = params.notify !== false;

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
                    const jobs = Array.from(state.backgroundJobs.values());
                    const lines = jobs.map((j) => formatJobLine(j));
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
                    const output = await readOutputTail(
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
                    if (job.status !== "running" || !job.proc) {
                        throw new Error(`Job is not running: ${job.id}`);
                    }
                    killProcessGroup(job.proc.pid!, "SIGTERM");
                    silenceJobAfterKill(job);
                    clearPendingDecision(state, job);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Sent SIGTERM to ${job.id} (process group)`,
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

                        onUpdate?.({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Attaching to ${job.id} (${job.status})...`,
                                },
                            ],
                            details: undefined,
                        });

                        await job.donePromise;
                    }

                    const output = await readOutputTail(
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
                    if (job.proc && job.status === "running") {
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
                    const output = await readOutputTail(
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
