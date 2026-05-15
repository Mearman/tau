/**
 * Shared mutable state for the Tau extension.
 *
 * All feature modules receive a reference to this single state instance,
 * giving them access to cross-cutting state without tight coupling to
 * specific feature modules.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { BackgroundJob, RunningProcess, Todo } from "./types.js";
import type { TodoItem } from "./plan-utils.js";

export class TauState {
    // ── Background jobs ──────────────────────────────────────────────

    backgroundJobs = new Map<string, BackgroundJob>();
    runningProcesses = new Map<string, RunningProcess>();
    jobCounter = 0;
    currentlyRunningToolCallId: string | null = null;
    agentBackgrounded = false;
    pendingDecisionJobId: string | undefined;

    // ── Agent timing ─────────────────────────────────────────────────

    agentStartTime: number | undefined;
    agentTimer: ReturnType<typeof setInterval> | null = null;

    // ── Plan mode ────────────────────────────────────────────────────

    planModeEnabled = false;
    planExecutionMode = false;
    planItems: TodoItem[] = [];

    // ── Notifications ────────────────────────────────────────────────

    notificationPersistent = false;
    notificationRespectDnd = true;
    dndActive = false;
    dndLastCheck = 0;

    // ── Todo ─────────────────────────────────────────────────────────

    todos: Todo[] = [];
    nextTodoId = 1;

    // ── Tools selector ───────────────────────────────────────────────

    enabledTools = new Set<string>();
    allTools: ToolInfo[] = [];

    // ── Titlebar ─────────────────────────────────────────────────────

    titlebarTimer: ReturnType<typeof setInterval> | null = null;
    titlebarFrameIndex = 0;
}
