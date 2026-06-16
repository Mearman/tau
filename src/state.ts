/**
 * Shared mutable state for the Tau extension.
 *
 * All feature modules receive a reference to this single state instance,
 * giving them access to cross-cutting state without tight coupling to
 * specific feature modules.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type {
    BackgroundJob,
    RunningProcess,
    Task,
    WorkflowRun,
} from "./types.ts";
import type { GoalState } from "./types.ts";
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

    /**
     * Whether pi is running non-interactively (print/`-p` mode, or stdin is not
     * a TTY). When true there is no interactive agent loop to answer the
     * auto-background `job_decide` prompt, so the bash tool must NOT
     * auto-background on timeout — it runs the command to completion instead.
     */
    nonInteractive = false;

    // ── Goal ────────────────────────────────────────────────────────

    /** The active goal, if any. Set by /goal command, persisted in session entries. */
    activeGoal: GoalState | undefined;

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

    // ── Plan ──────────────────────────────────────────────────────

    /** Active plan file ID (timestamp-title stem), if in plan mode. Set when plan mode is entered. */
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

    // ── Feature toggle overrides ─────────────────────────────────────
    // Three in-memory layers (temporary, session) plus three file-based
    // layers (cwd, project, global). The `thread` layer is reconstructed
    // from the most recent `tau-features-thread` session entry on the
    // current branch at `session_start` and `session_tree`, so it does
    // not live on state directly. See `features-state.ts` for the
    // restore logic.

    featureOverridesTemporary: Map<string, boolean> | undefined = undefined;
    featureOverridesSession: Map<string, boolean> | undefined = undefined;
    featureOverridesThread: Map<string, boolean> | undefined = undefined;
    cwdFeatures: Record<string, boolean> | undefined = undefined;
    projectFeatures: Record<string, boolean> | undefined = undefined;
    globalFeatures: Record<string, boolean> | undefined = undefined;

    // ── Workflow ──────────────────────────────────────────────────────

    /** The active workflow run, if any. */
    activeWorkflow: WorkflowRun | undefined;

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
    /** Commands that timed out on ask prompts. On retry these wait indefinitely. */
    permissionAskedCommands = new Set<string>();
    /** Timestamp when the permission mode hint should stop showing. 0 = never show. */
    permissionModeHintUntil = 0;
    /** Whether the user has interacted since session start. */
    hasInteracted = false;

    // ── Agent SDK provider (session mode) ────────────────────────────
    // Per-pi-session cursor for the SDK session-resume mode. The SDK session
    // holds the real assistant turns; each turn the provider sends only the
    // new user/tool-result messages since `sentCount`, so the SDK accumulates
    // a proper alternating transcript. Keyed by pi's session id.
    agentSdkSessions = new Map<
        string,
        { sdkSessionId: string | undefined; sentCount: number; head: string }
    >();
}
