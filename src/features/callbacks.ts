/**
 * Scheduled and external callbacks for pi.
 *
 * The agent often says "I'll check on it in a couple of minutes" but has no
 * native mechanism to follow through. This feature adds:
 *
 * 1. **Scheduled callbacks** — one-shot timers that deliver a message to the
 *    agent at a future time. Created by the `remind` tool (agent) or
 *    `/remind` command (user). Persisted to the session for restore on resume.
 *
 * 2. **External callbacks** — file-based IPC for external processes to
 *    deliver messages into an active pi session. External processes write
 *    JSON files to `~/.pi/callbacks/<session-id>/`. A filesystem watcher
 *    detects new files and delivers the message.
 *
 * Lifecycle:
 * - On session_start: restore pending callbacks from session entries
 * - On session_shutdown: persist pending callbacks, clean up watcher
 * - Timers fire via pi.sendUserMessage()
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface ScheduledCallback {
    id: string;
    message: string;
    /** ISO timestamp when this callback should fire. */
    fireAt: string;
    /** ISO timestamp when this callback was created. */
    createdAt: string;
    /** Who created this callback. */
    source: "agent" | "user" | "external";
    /** Whether this callback has been delivered. */
    fired: boolean;
    /** Timer handle (not persisted). */
    timer?: ReturnType<typeof setTimeout>;
}

// ─── Duration parsing ───────────────────────────────────────────────

const DURATION_RE = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;

export function parseDurationToMs(input: string): number | null {
    const match = input.match(DURATION_RE);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = match[2];
    const units: Record<string, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
    };
    return value * units[unit];
}

export function formatDuration(ms: number): string {
    const abs = Math.abs(ms);
    if (abs < 60_000) return `${Math.round(abs / 1_000)}s`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
    return `${Math.round(abs / 86_400_000)}d`;
}

export function formatRelative(isoDate: string): string {
    const ms = new Date(isoDate).getTime() - Date.now();
    if (ms <= 0) return "overdue";
    return `in ${formatDuration(ms)}`;
}

// ─── Callback directory (external IPC) ──────────────────────────────

function callbacksDir(sessionId: string): string {
    return join(homedir(), ".pi", "callbacks", sessionId);
}

// ─── Feature registration ───────────────────────────────────────────

export function registerCallbacks(pi: ExtensionAPI, state: TauState): void {
    let nextId = 1;
    const callbacks = new Map<string, ScheduledCallback>();
    let watcher: ReturnType<typeof watch> | null = null;
    let sessionId = "";

    // ── Core operations ────────────────────────────────────────────

    function generateId(): string {
        return `cb-${nextId++}`;
    }

    function scheduleCallback(cb: ScheduledCallback): void {
        callbacks.set(cb.id, cb);
        const delay = new Date(cb.fireAt).getTime() - Date.now();

        if (delay <= 0) {
            // Already due — fire immediately
            fireCallback(cb.id);
            return;
        }

        cb.timer = setTimeout(() => {
            fireCallback(cb.id);
        }, delay);

        // Don't let the timer prevent process exit
        if (cb.timer && typeof cb.timer === "object") {
            cb.timer.unref();
        }
    }

    function fireCallback(id: string): void {
        const cb = callbacks.get(id);
        if (!cb || cb.fired) return;

        cb.fired = true;
        if (cb.timer) {
            clearTimeout(cb.timer);
            cb.timer = undefined;
        }

        const elapsed = formatDuration(
            Date.now() - new Date(cb.createdAt).getTime()
        );

        pi.sendUserMessage(
            `<callback id="${cb.id}" source="${cb.source}" elapsed="${elapsed}">\n${cb.message}\n</callback>`,
            { deliverAs: "followUp" }
        );

        // Remove from map after firing
        callbacks.delete(id);

        // Update persisted state
        persistState();
    }

    function cancelCallback(id: string): boolean {
        const cb = callbacks.get(id);
        if (!cb || cb.fired) return false;

        if (cb.timer) {
            clearTimeout(cb.timer);
            cb.timer = undefined;
        }
        callbacks.delete(id);
        persistState();
        return true;
    }

    function cancelAll(): number {
        let count = 0;
        for (const cb of callbacks.values()) {
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
            count++;
        }
        callbacks.clear();
        persistState();
        return count;
    }

    function persistState(): void {
        const pending = Array.from(callbacks.values())
            .filter((cb) => !cb.fired)
            .map((cb) => ({
                id: cb.id,
                message: cb.message,
                fireAt: cb.fireAt,
                createdAt: cb.createdAt,
                source: cb.source,
            }));

        pi.appendEntry("callbacks-state", {
            callbacks: pending,
            nextId,
        });
    }

    // ── External callback watcher ──────────────────────────────────

    function startExternalWatcher(sid: string): void {
        const dir = callbacksDir(sid);
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            // Directory may already exist
        }

        try {
            watcher = watch(dir, (eventType, filename) => {
                if (!filename) return;
                if (eventType !== "rename" && eventType !== "change") return;
                if (!filename.endsWith(".json")) return;

                const filepath = join(dir, filename);
                try {
                    const raw = readFileSync(filepath, "utf-8");
                    const payload = JSON.parse(raw) as {
                        message: string;
                        source?: string;
                    };

                    if (payload.message) {
                        const cb: ScheduledCallback = {
                            id: generateId(),
                            message: payload.message,
                            fireAt: new Date().toISOString(),
                            createdAt: new Date().toISOString(),
                            source: "external",
                            fired: false,
                        };

                        // Fire immediately for external callbacks
                        callbacks.set(cb.id, cb);
                        fireCallback(cb.id);
                    }

                    // Clean up the file
                    try {
                        rmSync(filepath);
                    } catch {
                        // Already removed
                    }
                } catch {
                    // File might not be fully written yet — ignore
                }
            });
        } catch {
            // watch() may fail on some platforms — degrade gracefully
        }

        // Also process any files that already exist (from before pi started)
        processExistingCallbacks(sid);
    }

    function stopExternalWatcher(): void {
        if (watcher) {
            watcher.close();
            watcher = null;
        }
    }

    function processExistingCallbacks(sid: string): void {
        const dir = callbacksDir(sid);
        try {
            const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
            for (const filename of files) {
                const filepath = join(dir, filename);
                try {
                    const raw = readFileSync(filepath, "utf-8");
                    const payload = JSON.parse(raw) as {
                        message: string;
                        source?: string;
                    };

                    if (payload.message) {
                        const cb: ScheduledCallback = {
                            id: generateId(),
                            message: payload.message,
                            fireAt: new Date().toISOString(),
                            createdAt: new Date().toISOString(),
                            source: "external",
                            fired: false,
                        };
                        callbacks.set(cb.id, cb);
                        fireCallback(cb.id);
                    }
                    try {
                        rmSync(filepath);
                    } catch {
                        // Already removed
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        } catch {
            // Directory doesn't exist yet — that's fine
        }
    }

    // ── Session lifecycle ──────────────────────────────────────────

    pi.on("session_start", async (event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        nextId = 1;

        // Restore pending callbacks from the latest session entry.
        // Iterate in reverse to find the most recent callbacks-state
        // entry, which reflects the latest state (fired callbacks removed).
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                entry.customType === "callbacks-state"
            ) {
                const data = entry.data as {
                    callbacks?: Array<{
                        id: string;
                        message: string;
                        fireAt: string;
                        createdAt: string;
                        source: "agent" | "user" | "external";
                    }>;
                    nextId?: number;
                };

                if (data.callbacks) {
                    for (const cb of data.callbacks) {
                        const restored: ScheduledCallback = {
                            ...cb,
                            fired: false,
                        };
                        scheduleCallback(restored);
                    }
                }
                if (typeof data.nextId === "number") {
                    nextId = Math.max(nextId, data.nextId);
                }
                break;
            }
        }

        // Start watching for external callbacks
        startExternalWatcher(sessionId);
    });

    pi.on("session_shutdown", async () => {
        // Persist any pending callbacks
        persistState();

        // Stop watcher
        stopExternalWatcher();

        // Cancel all in-memory timers
        for (const cb of callbacks.values()) {
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
        }
        callbacks.clear();
    });

    // ── Agent tool: remind ──────────────────────────────────────────

    pi.registerTool({
        name: "remind",
        label: "Schedule Callback",
        description:
            "Schedule a future callback to check on a task. " +
            "Use when you say 'I'll check on it later' or 'let me come back to this'. " +
            "The callback delivers a message to you at the specified time, " +
            "prompting you to follow up. " +
            "Examples: remind in 2m to check the deploy, remind in 30s to review test results",
        promptSnippet: "Schedule a future callback to check on a task",
        promptGuidelines: [
            "Use remind when you promise to check on something later.",
            "Prefer shorter intervals (30s-5m) for monitoring tasks.",
            "The callback message should be specific about what to check.",
            "Do NOT use remind for things you can verify now.",
        ],
        parameters: Type.Object({
            message: Type.String({
                description:
                    "What to follow up on when the callback fires. Be specific.",
            }),
            in: Type.String({
                description:
                    'How long until the callback fires. Formats: "30s", "5m", "1h", "2d".',
            }),
        }),

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            if (!isFeatureEnabled(state, "callbacks")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Callbacks are disabled — run /tau to enable",
                        },
                    ],
                };
            }

            const delayMs = parseDurationToMs(params.in);
            if (delayMs === null) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Invalid duration "${params.in}". Use formats like "30s", "5m", "1h", "2d".`,
                        },
                    ],
                    details: undefined,
                };
            }

            const now = new Date();
            const fireAt = new Date(now.getTime() + delayMs);
            const id = generateId();

            const cb: ScheduledCallback = {
                id,
                message: params.message,
                fireAt: fireAt.toISOString(),
                createdAt: now.toISOString(),
                source: "agent",
                fired: false,
            };

            scheduleCallback(cb);
            persistState();

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Callback ${id} scheduled.\n` +
                            `Message: ${params.message}\n` +
                            `Fires: ${fireAt.toISOString()} (${formatDuration(delayMs)} from now)`,
                    },
                ],
                details: undefined,
            };
        },
    });

    // ── User command: /remind ───────────────────────────────────────

    pi.registerCommand("remind", {
        description:
            "Schedule a callback: /remind 2m check the deploy | /remind list | /remind cancel <id> | /remind cancel-all",
        handler: async (args, ctx: ExtensionCommandContext) => {
            if (!isFeatureEnabled(state, "callbacks")) {
                ctx.ui.notify(
                    "Callbacks are disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const trimmed = args.trim();

            if (trimmed === "list") {
                if (callbacks.size === 0) {
                    ctx.ui.notify("No pending callbacks.", "info");
                } else {
                    const lines = Array.from(callbacks.values())
                        .filter((cb) => !cb.fired)
                        .map((cb) => {
                            const relative = formatRelative(cb.fireAt);
                            return `  ${cb.id}: "${cb.message}" — ${relative} (${cb.source})`;
                        });
                    ctx.ui.notify(
                        `Pending callbacks:\n${lines.join("\n")}`,
                        "info"
                    );
                }
                return;
            }

            if (trimmed === "cancel-all" || trimmed === "clear") {
                const count = cancelAll();
                ctx.ui.notify(`Cancelled ${count} callback(s).`, "info");
                return;
            }

            const cancelMatch = trimmed.match(/^cancel\s+(\S+)$/);
            if (cancelMatch) {
                const id = cancelMatch[1];
                if (cancelCallback(id)) {
                    ctx.ui.notify(`Callback ${id} cancelled.`, "info");
                } else {
                    ctx.ui.notify(`Callback ${id} not found.`, "warning");
                }
                return;
            }

            // Parse: /remind <duration> <message>
            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) {
                ctx.ui.notify(
                    "Usage: /remind <duration> <message> | /remind list | /remind cancel <id>",
                    "warning"
                );
                return;
            }

            const delayMs = parseDurationToMs(parts[0]);
            if (delayMs === null) {
                ctx.ui.notify(
                    `Invalid duration "${parts[0]}". Use 30s, 5m, 1h, 2d.`,
                    "warning"
                );
                return;
            }

            const message = parts.slice(1).join(" ");
            const now = new Date();
            const fireAt = new Date(now.getTime() + delayMs);
            const id = generateId();

            const cb: ScheduledCallback = {
                id,
                message,
                fireAt: fireAt.toISOString(),
                createdAt: now.toISOString(),
                source: "user",
                fired: false,
            };

            scheduleCallback(cb);
            persistState();

            ctx.ui.notify(
                `Callback ${id} scheduled: "${message}" — fires ${formatDuration(delayMs)} from now.`,
                "info"
            );
        },
    });

    // ── External callback helper: /callback-dir ────────────────────

    pi.registerCommand("callback-dir", {
        description:
            "Print the directory where external processes can write callback files",
        handler: async (_args, ctx) => {
            if (!isFeatureEnabled(state, "callbacks")) {
                ctx.ui.notify(
                    "Callbacks are disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const dir = callbacksDir(ctx.sessionManager.getSessionId());
            ctx.ui.notify(
                `External callbacks: write JSON files to ${dir}\n` +
                    `Format: { "message": "your message" }`,
                "info"
            );
        },
    });
}
