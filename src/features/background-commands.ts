/**
 * Background commands and keyboard shortcuts.
 *
 * /bg, /fg, /jobs commands, Ctrl+B/X/J/Shift+Down shortcuts,
 * and the interactive tasks interface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob, UiContext } from "../types.ts";
import { backgroundProcess, updateWidget } from "./background.ts";
import {
    MAX_OUTPUT_PREVIEW_CHARS,
    createJobDonePromise,
    formatDuration,
    killProcessGroup,
    markJobTerminal,
    readOutputTail,
} from "../utils.ts";

// ── Background shortcut handler (Ctrl+B) ────────────────────────────

export async function handleBackgroundShortcut(
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): Promise<void> {
    if (state.agentBackgrounded) {
        state.agentBackgrounded = false;
        ctx.ui.setStatus("agent-backgrounded", undefined);
        updateWidget(state, ctx);
        ctx.ui.notify("▶ Resumed", "success");

        pi.sendMessage(
            {
                customType: "agent-resume",
                content: "Continuing where you left off.",
                display: true,
            },
            { deliverAs: "followUp", triggerTurn: true }
        );
        return;
    }

    let didBackgroundBash = false;
    if (state.currentlyRunningToolCallId) {
        const rp = state.runningProcesses.get(state.currentlyRunningToolCallId);
        if (rp && !rp.backgrounded) {
            backgroundProcess(rp, state, pi, ctx);
            didBackgroundBash = true;
        }
    }

    state.agentBackgrounded = true;
    ctx.ui.setStatus(
        "agent-backgrounded",
        ctx.ui.theme.fg("warning", "⏸ Backgrounded")
    );
    updateWidget(state, ctx);

    if (didBackgroundBash) {
        ctx.ui.notify("⏸ Backgrounded bash + agent. Ctrl+B to resume.", "info");
    } else {
        ctx.ui.notify("⏸ Backgrounded. Ctrl+B to resume.", "info");
    }
}

// ── Interactive task detail ──────────────────────────────────────────

async function showTaskDetail(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): Promise<void> {
    const duration = formatDuration(Date.now() - job.startTime);
    const statusIcon =
        job.status === "running"
            ? "◐"
            : job.status === "completed"
              ? "✅"
              : job.status === "failed"
                ? "❌"
                : "🛑";

    if (job.status === "running") {
        const actions = ["Attach (wait for completion)", "Show Output", "Kill"];
        const action = await ctx.ui.select(
            `${statusIcon} ${job.id} · ${job.command.slice(0, 50)} · ${duration}`,
            actions
        );
        if (action === undefined) return;

        if (action === actions[0]) {
            ctx.ui.setStatus("bg-fg", `Attaching to ${job.id}...`);
            if (!job.donePromise) createJobDonePromise(job);
            await job.donePromise;
            ctx.ui.setStatus("bg-fg", undefined);

            const output = await readOutputTail(
                job.logPath,
                MAX_OUTPUT_PREVIEW_CHARS
            );
            const fullText =
                `${job.id} · ${job.command}\n` +
                `Status: ${job.status} · Duration: ${formatDuration(Date.now() - job.startTime)}\n` +
                `Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;

            pi.sendMessage(
                {
                    customType: "bg-attach",
                    content: fullText,
                    display: true,
                    details: { jobId: job.id, logPath: job.logPath },
                },
                { deliverAs: "steer", triggerTurn: false }
            );
            ctx.ui.notify(`Attached ${job.id}`, "info");
        } else if (action === actions[1]) {
            const output = await readOutputTail(
                job.logPath,
                MAX_OUTPUT_PREVIEW_CHARS
            );
            await ctx.ui.editor(
                `${statusIcon} ${job.id}: ${job.command.slice(0, 50)}`,
                `Command: ${job.command}\n` +
                    `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Duration: ${duration} · Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`
            );
        } else if (action === actions[2]) {
            if (job.proc) killProcessGroup(job.proc.pid!, "SIGTERM");
            markJobTerminal(job, "killed");
            ctx.ui.notify(`Killed ${job.id}`, "info");
            updateWidget(state, ctx);
        }
    } else {
        const actions = ["Show Output", "Remove from List"];
        const action = await ctx.ui.select(
            `${statusIcon} ${job.id} · ${job.command.slice(0, 50)} · ${job.status}`,
            actions
        );
        if (action === undefined) return;

        if (action === actions[0]) {
            const output = await readOutputTail(
                job.logPath,
                MAX_OUTPUT_PREVIEW_CHARS
            );
            await ctx.ui.editor(
                `${statusIcon} ${job.id}: ${job.command.slice(0, 50)}`,
                `Command: ${job.command}\n` +
                    `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Status: ${job.status} · Exit code: ${job.exitCode ?? "n/a"}\n` +
                    `Duration: ${duration} · Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`
            );
        } else if (action === actions[1]) {
            state.backgroundJobs.delete(job.id);
            ctx.ui.notify(`Removed ${job.id}`, "info");
            updateWidget(state, ctx);
        }
    }
}

// ── Tasks interface ──────────────────────────────────────────────────

export async function showTasksInterface(
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): Promise<void> {
    const allJobs = Array.from(state.backgroundJobs.values());
    const runningJobs = allJobs.filter((j) => j.status === "running");
    const finishedJobs = allJobs.filter((j) => j.status !== "running");

    const items: string[] = [];
    if (state.agentBackgrounded) {
        items.push("◐ agent · backgrounded · Ctrl+B to resume");
    }
    for (const job of runningJobs) {
        const duration = formatDuration(Date.now() - job.startTime);
        items.push(`◐ ${job.id}: ${job.command.slice(0, 40)} · ${duration}`);
    }
    for (const job of finishedJobs) {
        const statusIcon =
            job.status === "completed"
                ? "✅"
                : job.status === "failed"
                  ? "❌"
                  : "🛑";
        items.push(`${statusIcon} ${job.id}: ${job.command.slice(0, 40)}`);
    }

    if (items.length === 0) {
        ctx.ui.notify("No background tasks", "info");
        return;
    }

    const choice = await ctx.ui.select("Background Tasks", items);
    if (choice === undefined) return;

    if (state.agentBackgrounded && choice === items[0]) {
        await handleBackgroundShortcut(state, pi, ctx);
        return;
    }

    const selectedJob = [...runningJobs, ...finishedJobs].find((j) =>
        choice?.includes(j.id)
    );
    if (selectedJob) {
        await showTaskDetail(selectedJob, state, pi, ctx);
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerBackgroundCommands(
    pi: ExtensionAPI,
    state: TauState
): void {
    pi.registerShortcut("ctrl+b", {
        description: "Background bash/agent, or resume backgrounded agent",
        handler: async (ctx) => {
            await handleBackgroundShortcut(state, pi, ctx);
        },
    });

    pi.registerShortcut("ctrl+j", {
        description: "Open background tasks",
        handler: async (ctx) => {
            await showTasksInterface(state, pi, ctx);
        },
    });

    pi.registerShortcut("shift+down", {
        description: "Open background tasks",
        handler: async (ctx) => {
            await showTasksInterface(state, pi, ctx);
        },
    });

    pi.registerShortcut("ctrl+x", {
        description: "Kill most recent running background task",
        handler: async (ctx) => {
            const runningJobs = Array.from(state.backgroundJobs.values())
                .filter((j) => j.status === "running")
                .sort((a, b) => b.startTime - a.startTime);

            if (runningJobs.length === 0) {
                ctx.ui.notify("No running tasks to kill", "warning");
                return;
            }

            const job = runningJobs[0];
            if (job.proc) killProcessGroup(job.proc.pid!, "SIGTERM");
            markJobTerminal(job, "killed");
            ctx.ui.notify(`Killed ${job.id}`, "info");
            updateWidget(state, ctx);
        },
    });

    pi.registerCommand("bg", {
        description: "Background bash/agent, or resume backgrounded agent",
        handler: async (_args, ctx) => {
            await handleBackgroundShortcut(state, pi, ctx);
        },
    });

    pi.registerCommand("fg", {
        description:
            "Attach to a background job (/fg [job-id] [--snapshot]); defaults to most recent running job",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const snapshot =
                parts.includes("--snapshot") || parts.includes("-s");
            const explicitJobId = parts.find((p) => !p.startsWith("-"));

            let job: BackgroundJob | undefined;
            if (explicitJobId) {
                job = state.backgroundJobs.get(explicitJobId);
                if (!job) {
                    ctx.ui.notify(`Job not found: ${explicitJobId}`, "error");
                    return;
                }
            } else {
                job = Array.from(state.backgroundJobs.values())
                    .filter((j) => j.status === "running")
                    .sort((a, b) => b.startTime - a.startTime)[0];

                if (!job) {
                    ctx.ui.notify(
                        "No running background jobs to attach. Usage: /fg [job-id] [--snapshot]",
                        "warning"
                    );
                    return;
                }
            }

            ctx.ui.setStatus(
                "bg-fg",
                `Attaching to ${job.id}${snapshot ? " (snapshot mode)" : ""}...`
            );
            try {
                if (!snapshot && job.status === "running") {
                    if (!job.donePromise) createJobDonePromise(job);
                    await job.donePromise;
                }

                const output = await readOutputTail(
                    job.logPath,
                    MAX_OUTPUT_PREVIEW_CHARS
                );
                const fullText =
                    `Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
                    `PID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;

                pi.sendMessage(
                    {
                        customType: "bg-attach",
                        content: fullText,
                        display: true,
                        details: {
                            jobId: job.id,
                            logPath: job.logPath,
                        },
                    },
                    { deliverAs: "steer", triggerTurn: false }
                );
                ctx.ui.notify(`Attached output posted for ${job.id}`, "info");
            } finally {
                ctx.ui.setStatus("bg-fg", undefined);
            }
        },
    });

    pi.registerCommand("jobs", {
        description: "Show and manage background tasks",
        handler: async (_args, ctx) => {
            await showTasksInterface(state, pi, ctx);
        },
    });
}
