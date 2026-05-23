/**
 * Background agent — spawn a detached pi process for autonomous task execution.
 *
 * Extracts the original prompt and last assistant message from the session,
 * constructs a continuation prompt, and spawns `pi -p` in the background.
 *
 * When pi's SessionManager supports session forking, a fork-and-resume path
 * will be added that lets the background agent continue the full conversation.
 */

import { spawn } from "node:child_process";
import {
    createWriteStream,
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import type { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import {
    createJobDonePromise,
    generateJobId,
    killProcessGroup,
    logPathForJob,
    markJobTerminal,
} from "../utils.ts";
import {
    silenceJobAfterKill,
    startStallWatchdog,
    clearPendingDecision,
    notifyCompletion,
    updateWidget,
} from "./background.ts";

// ─── Context continuity ─────────────────────────────────────────────

/** Maximum fraction of context window that a forked session can consume. */
const MAX_CONTEXT_FRACTION = 0.4;

/**
 * Choose between fork-and-resume and summary-only.
 * Below MAX_CONTEXT_FRACTION, fork would be safe — the agent has room to continue.
 * Above, summary-only gives it more context headroom.
 *
 * Currently both paths use summary-only. When session forking is available,
 * the fork path will use `pi --resume <fork>` instead.
 */
export function chooseBackgroundPath(
    conversationBytes: number,
    contextWindowTokens: number
): "fork" | "summary" {
    const estimatedTokens = conversationBytes / 4;
    const fraction = estimatedTokens / contextWindowTokens;
    return fraction < MAX_CONTEXT_FRACTION ? "fork" : "summary";
}

/** Messages that carry a content field (user/assistant/toolResult). */
interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

/** Type guard: does this session entry carry a message with a content field? */
function isContentMessageEntry(
    entry: SessionEntry
): entry is SessionEntry & { message: ContentMessage } {
    if (entry.type !== "message") return false;
    if (!("message" in entry)) return false;
    const msg = (entry as { message: unknown }).message;
    if (typeof msg !== "object" || msg === null) return false;
    return "content" in msg;
}

/** Extract text from a content field (string or array of content blocks). */
function extractTextFromContent(
    content: string | { type: string; text?: string }[]
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b): b is { type: string; text: string } =>
                typeof b === "object" &&
                b !== null &&
                b.type === "text" &&
                typeof b.text === "string"
        )
        .map((b) => b.text)
        .join("\n");
}

/**
 * Extract the last assistant message text from session entries.
 */
function extractLastAssistantSummary(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (
            isContentMessageEntry(entry) &&
            entry.message.role === "assistant"
        ) {
            return extractTextFromContent(entry.message.content).slice(-2000);
        }
    }
    return "";
}

/**
 * Extract the original user prompt from session entries.
 */
function extractOriginalPrompt(entries: SessionEntry[]): string {
    for (const entry of entries) {
        if (isContentMessageEntry(entry) && entry.message.role === "user") {
            return extractTextFromContent(entry.message.content).slice(0, 2000);
        }
    }
    return "";
}

/**
 * Estimate the byte size of the conversation from session entries.
 */
function estimateConversationBytes(entries: SessionEntry[]): number {
    let bytes = 0;
    for (const entry of entries) {
        if (isContentMessageEntry(entry)) {
            bytes += extractTextFromContent(entry.message.content).length;
        }
    }
    return bytes;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerAgentBackground(
    pi: ExtensionAPI,
    state: TauState
): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description:
            "Spawn a separate pi process to handle a task in the background. " +
            "Constructs a continuation prompt from the current conversation " +
            "context and the specified task. " +
            "Use the jobs tool to check status and read output.",
        promptSnippet:
            "Delegate a task to a background pi process with context continuity",
        promptGuidelines: [
            "Use agent_bg for tasks that can run independently without the current conversation.",
            "The background agent gets a summary of the original task and where you left off.",
            "Use the jobs tool to check on progress. You will be notified when it finishes.",
        ],
        parameters: Type.Object({
            prompt: Type.String({
                description: "Task for the background agent",
            }),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Working directory (defaults to current directory)",
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
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            // Decide context path
            const entries = ctx.sessionManager.getEntries();
            const conversationBytes = estimateConversationBytes(entries);
            const contextWindowTokens = state.contextWindowTokens ?? 32_768;
            const path = chooseBackgroundPath(
                conversationBytes,
                contextWindowTokens
            );

            // Build continuation prompt
            const summary = extractLastAssistantSummary(entries);
            const originalPrompt = extractOriginalPrompt(entries);

            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "",
                "## Original task",
                params.prompt,
                ...(originalPrompt
                    ? ["", "## Previous user context", originalPrompt]
                    : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "",
                "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${jobId}.md`;
            writeFileSync(promptFile, promptContent);

            const spawnArgs = ["-p", "--no-session", `@${promptFile}`];

            const proc = spawn("pi", spawnArgs, {
                cwd: params.cwd ?? ctx.cwd,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!proc.pid) {
                try {
                    unlinkSync(promptFile);
                } catch {
                    /* ignore */
                }
                throw new Error("Failed to spawn background agent process");
            }

            // Pipe output to log file
            const logStream = createWriteStream(logPath, { flags: "w" });
            proc.stdout?.pipe(logStream, { end: false });
            proc.stderr?.pipe(logStream, { end: false });

            const job: BackgroundJob = {
                id: jobId,
                command: `pi -p (background agent)`,
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
                job.command,
                logPath,
                pi,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job);
                }
            );

            const cleanupFiles = [promptFile];

            proc.on("close", (code) => {
                cancelStall();
                logStream.end();
                markJobTerminal(
                    job,
                    code === 0 || code === null ? "completed" : "failed",
                    code ?? 0
                );
                clearPendingDecision(state, job);
                notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
                for (const f of cleanupFiles) {
                    try {
                        unlinkSync(f);
                    } catch {
                        /* already gone */
                    }
                }
            });

            proc.on("error", () => {
                cancelStall();
                logStream.end();
                markJobTerminal(job, "failed");
                clearPendingDecision(state, job);
                notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
                for (const f of cleanupFiles) {
                    try {
                        unlinkSync(f);
                    } catch {
                        /* already gone */
                    }
                }
            });

            updateWidget(state, ctx);

            const pathLabel =
                path === "fork" ? "fork-and-resume" : "summary-only";
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Started background agent ${jobId} (${pathLabel})\n` +
                            `Prompt: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "…" : ""}\n` +
                            `PID: ${proc.pid}\n` +
                            `Output: ${logPath}\n` +
                            `Context: ${(conversationBytes / 1024).toFixed(0)} KB / ${contextWindowTokens} tokens`,
                    },
                ],
                details: undefined,
            };
        },
    });
}
