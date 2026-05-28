/**
 * Shared mutable state for the Tau extension.
 *
 * All feature modules receive a reference to this single state instance,
 * giving them access to cross-cutting state without tight coupling to
 * specific feature modules.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { BackgroundJob, RunningProcess, Task } from "./types.ts";
import type { TodoItem } from "./plan-utils.ts";
import type {
    PermissionMode,
    PermissionRule,
} from "./features/permissions/types.js";

export class TauState {
    // ── Background jobs ──────────────────────────────────────────────

    backgroundJobs = new Map<string, BackgroundJob>();
    runningProcesses = new Map<string, RunningProcess>();
    jobCounter = 0;
    currentlyRunningToolCallId: string | null = null;
    agentBackgrounded = false;
    pendingDecisionJobId: string | undefined;

    /** Whether tmux is available for the tmux-backed bash backend. */
    tmuxAvailable = false;
    /** Whether the tmux-unavailable warning has been shown this session. */
    tmuxWarningShown = false;

    /** Lifetime counters for terminal jobs (for status bar summary). */
    completedJobCount = 0;
    failedJobCount = 0;

    /** Recent terminal jobs kept for `jobs output` lookups (max 20). */
    recentTerminalJobs: BackgroundJob[] = [];

    // ── Agent timing ─────────────────────────────────────────────────

    agentStartTime: number | undefined;
    agentTimer: ReturnType<typeof setInterval> | null = null;

    // ── Background agent context ──────────────────────────────────────

    /** Model context window in tokens. Used by agent_bg to choose fork vs summary. */
    contextWindowTokens?: number;

    // ── Reload bridge ──────────────────────────────────────────────────

    /**
     * Captured reload function from ExtensionCommandContext.
     * Tools only receive ExtensionContext (no reload), so we capture it
     * from the first command handler invocation and store it here.
     */
    commandContextReload?: () => Promise<void>;

    // ── Plan mode (legacy) ────────────────────────────────────────────

    /** @deprecated Legacy plan mode toggle — superseded by permission mode `plan` */
    planModeEnabled = false;
    /** @deprecated Legacy execution tracking — superseded by task status updates */
    planExecutionMode = false;
    /** @deprecated Legacy todo items — superseded by task tool */
    planItems: TodoItem[] = [];

    // ── Plan (new) ────────────────────────────────────────────────────

    /** Active plan file slug, derived from session ID. Set when plan mode is entered. */
    planSlug: string | undefined;
    /** The permission mode that was active before entering plan mode. */
    planPreviousMode: PermissionMode | undefined;
    /** Whether the model has called exit_plan_mode and execution is about to start. */
    planExiting = false;

    // ── Notifications ────────────────────────────────────────────────

    notificationPersistent = false;
    notificationRespectDnd = true;
    dndActive = false;
    dndLastCheck = 0;

    /** IDs of enabled notification providers. */
    enabledNotificationProviders = new Set<string>(["terminal"]);
    /** Per-provider credential/settings storage. */
    notificationProviderConfigs: Record<string, Record<string, string>> = {};

    // ── Task ──────────────────────────────────────────────────────────

    tasks: Task[] = [];
    nextTaskId = 1;

    // ── Tools selector ───────────────────────────────────────────────

    enabledTools = new Set<string>();
    allTools: ToolInfo[] = [];

    // ── Titlebar ─────────────────────────────────────────────────────

    titlebarTimer: ReturnType<typeof setInterval> | null = null;
    titlebarFrameIndex = 0;

    /** @deprecated Handoff disabled — kept for type compatibility with disabled handoff.ts */
    accessedFilePaths: string[] = [];

    // ── Permissions ─────────────────────────────────────────────────

    permissionMode: PermissionMode = "allow";
    permissionRules: PermissionRule[] = [];
    permissionAdditionalDirectories = new Set<string>();
    permissionDisableBypass = false;
    permissionLastLoadedAt = 0;
    permissionSessionRules: string[] = [];
    /** Timestamp when the permission mode hint should stop showing. 0 = never show. */
    permissionModeHintUntil = 0;
    /** Whether the user has interacted since session start. */
    hasInteracted = false;
}
