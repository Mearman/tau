/**
 * Tau (τ) — Quality-of-Life Extension for pi
 *
 * Background tasks, notifications, plan mode, presets, and other enhancements.
 *
 * Tools: bash (overridden), bash_bg, jobs, job_decide, task,
 *        enter_plan_mode, exit_plan_mode
 * Commands: /bg, /fg, /jobs, /tasks, /tools, /plan, /perm, /bookmark,
 *           /unbookmark, /context, /footer, /notifications, /preset,
 *           /session-name, /summarize
 * Shortcuts: Ctrl+B (background/resume), Ctrl+J / Shift+Down (tasks),
 *            Ctrl+X (kill), Ctrl+Alt+P (plan mode), Ctrl+Shift+U (preset cycle),
 *            Ctrl+Shift+M (permission mode cycle), Ctrl+Shift+T (thinking level)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TauState } from "./state.ts";
import { cleanupStaleLogs } from "./utils.ts";
import { isSafeCommand } from "./plan-utils.ts";
import {
    initPermissionState,
    reloadSettingsIfNeeded,
    checkToolPermission,
    modeStatusText,
    modeColour,
} from "./features/permissions/index.js";
import {
    startTitlebarSpinner,
    stopTitlebarSpinner,
    startAgentTimer,
    stopAgentTimer,
    showAgentTurnComplete,
} from "./features/titlebar.ts";

// Existing features
import { registerBackgroundJobs } from "./features/background.ts";
import { registerBackgroundCommands } from "./features/background-commands.ts";
import { registerAgentBackground } from "./features/agent-background.ts";
import { registerPlanMode } from "./features/plan-mode.ts";
import {
    registerTask,
    reconstructTaskState,
    formatTaskTree,
} from "./features/task.ts";
import {
    registerToolsSelector,
    restoreToolsFromBranch,
} from "./features/tools-selector.ts";
import {
    registerNotifications,
    shouldNotify,
    sendNotification,
} from "./features/notifications.ts";

// New integrations
import { registerBookmark } from "./features/bookmark.ts";
import { registerClaudeRules } from "./features/claude-rules.ts";
import { registerCustomFooter } from "./features/custom-footer.ts";
import { registerGitCheckpoint } from "./features/git-checkpoint.ts";
import { registerGithubAutocomplete } from "./features/github-autocomplete.ts";
// Handoff disabled — import { registerHandoff } from "./features/handoff.ts";
import { registerPreset } from "./features/preset.ts";
import { registerLoop } from "./features/loop.ts";
import { registerSessionName } from "./features/session-name.ts";
import { registerSummarize } from "./features/summarize.ts";
import { registerContext } from "./features/context.ts";
import { registerWebBrowse } from "./features/web-browse/index.ts";
import { registerReloadTool } from "./features/reload.ts";
import { registerCallbacks } from "./features/callbacks.ts";
import { registerPermissions } from "./features/permissions/commands.js";
import { registerPlanTools } from "./features/plan-tools.js";
import { isTmuxAvailable } from "./tmux.ts";
import {
    cleanupTmuxRunDir,
    cleanupStaleTmuxRunDirs,
    attachTmuxContext,
} from "./features/bash-tmux.ts";
import { checkExitCode } from "./tmux.ts";

export default function (pi: ExtensionAPI) {
    const state = new TauState();

    // ── Register all features ─────────────────────────────────────────

    registerBackgroundJobs(pi, state);
    registerBackgroundCommands(pi, state);
    registerAgentBackground(pi, state);
    registerPlanMode(pi, state);
    registerTask(pi, state);
    registerToolsSelector(pi, state);
    registerNotifications(pi, state);
    registerBookmark(pi);
    registerClaudeRules(pi);
    registerCustomFooter(pi);
    registerGitCheckpoint(pi);
    registerGithubAutocomplete(pi);
    // registerHandoff(pi, state); // disabled
    registerPreset(pi);
    registerLoop(pi);
    registerSessionName(pi);
    registerSummarize(pi);
    registerContext(pi);
    registerWebBrowse(pi);
    registerReloadTool(pi, state);
    registerCallbacks(pi, state);
    registerPermissions(pi, state);
    registerPlanTools(pi, state);

    // ── Agent events (cross-cutting) ──────────────────────────────────

    pi.on("agent_start", async (_event, ctx) => {
        startTitlebarSpinner(pi, state, ctx);
        state.agentStartTime = Date.now();
        startAgentTimer(state, ctx);
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        // Agent backgrounding
        if (state.agentBackgrounded) {
            return { block: true, reason: "" };
        }

        // Pending job decision: block unrelated tools
        if (
            state.pendingDecisionJobId !== undefined &&
            event.toolName !== "job_decide" &&
            event.toolName !== "jobs" &&
            event.toolName !== "bash"
        ) {
            const job = state.backgroundJobs.get(state.pendingDecisionJobId);
            const status =
                job?.status === "running"
                    ? "still running"
                    : (job?.status ?? "unknown");
            return {
                block: true,
                reason: `A background job (${state.pendingDecisionJobId}) is awaiting your decision (${status}). Use job_decide or jobs first.`,
            };
        }

        // ── Permission system ──────────────────────────────────────

        // Reload settings if stale
        const permState = await reloadSettingsIfNeeded(
            {
                mode: state.permissionMode,
                rules: state.permissionRules,
                additionalDirectories: state.permissionAdditionalDirectories,
                disableBypass: state.permissionDisableBypass,
                lastLoadedAt: state.permissionLastLoadedAt,
                sessionRules: state.permissionSessionRules,
                askedCommands: state.permissionAskedCommands,
                planSlug: state.planSlug,
            },
            ctx.cwd
        );
        state.permissionMode = permState.mode;
        state.permissionRules = permState.rules;
        state.permissionAdditionalDirectories = permState.additionalDirectories;
        state.permissionDisableBypass = permState.disableBypass;
        state.permissionLastLoadedAt = permState.lastLoadedAt;
        state.permissionSessionRules = permState.sessionRules;
        state.permissionAskedCommands = permState.askedCommands;

        // Run the permission pipeline
        const permResult = await checkToolPermission(
            event,
            permState,
            ctx.cwd,
            ctx
        );
        if (permResult.block) {
            return permResult;
        }

        // The permission system's plan mode handles bash filtering.
        // This legacy guard is kept only for the --plan CLI flag path.
        if (state.permissionMode === "plan" && event.toolName === "bash") {
            const command = event.input.command as string;
            if (!isSafeCommand(command)) {
                return {
                    block: true,
                    reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
                };
            }
        }

        return {};
    });

    // Handoff disabled — file path tracking removed
    // pi.on("tool_result", async (event) => {
    //     if (
    //         (event.toolName === "read" ||
    //             event.toolName === "edit" ||
    //             event.toolName === "write") &&
    //         typeof event.input.path === "string"
    //     ) {
    //         state.accessedFilePaths.push(event.input.path);
    //     }
    // });

    pi.on("turn_start", async (_event, ctx) => {
        if (state.agentStartTime !== undefined && !state.agentTimer)
            startAgentTimer(state, ctx);

        // First user interaction — clear the shortcut hint from status bar
        if (!state.hasInteracted) {
            state.hasInteracted = true;
            state.permissionModeHintUntil = 0;
            if (ctx.hasUI) {
                const colour = modeColour(state.permissionMode);
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(
                        colour,
                        modeStatusText(state.permissionMode, false)
                    )
                );
            }
        }
    });

    pi.on("turn_end", async (_event, _ctx) => {
        // Stop the elapsed timer between turns
        if (state.agentTimer) {
            clearInterval(state.agentTimer);
            state.agentTimer = null;
        }
    });

    // Plan-mode: inject context before agent starts
    pi.on("before_agent_start", async () => {
        if (state.permissionMode === "plan" && state.planSlug) {
            const planPath = `.pi/plans/${state.planSlug}.md`;
            const taskTree =
                state.tasks.length > 0
                    ? `\n\nCurrent task tree:\n${formatTaskTree(state.tasks)}`
                    : "";
            return {
                message: {
                    customType: "plan-mode-context",
                    content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for structured planning.

Restrictions:
- Only read-only tools are available (read, bash, grep, find, ls)
- Bash is restricted to an allowlist of read-only commands
- The ONLY writable file is the plan file at: ${planPath}
- The task tool is fully available — use it to structure the implementation

Your job is to:
1. Explore the codebase using read-only tools
2. Build a structured task tree using the task tool:
   - Create a root task for the overall goal
   - Decompose into subtasks with child-of links
   - Add blocks/depends-on links for ordering constraints
   - Tasks without dependency links between them are parallel candidates
3. Write the narrative plan to ${planPath}
4. Call exit_plan_mode when the plan is ready for user approval

The plan file should include: Context, Approach, Files to modify,
Existing code to reuse (with paths), and Verification steps.${taskTree}`,
                    display: false,
                },
            };
        }
    });

    // Plan-mode: filter out stale context when not active
    pi.on("context", async (event) => {
        if (state.permissionMode === "plan") return;

        return {
            messages: event.messages.filter((m) => {
                const msg = m as AgentMessage & {
                    customType?: string;
                };
                if (msg.customType === "plan-mode-context") return false;
                if (msg.role !== "user") return true;

                const content = msg.content;
                if (typeof content === "string")
                    return !content.includes("[PLAN MODE ACTIVE]");
                if (Array.isArray(content)) {
                    return !content.some(
                        (c) =>
                            c.type === "text" &&
                            c.text?.includes("[PLAN MODE ACTIVE]")
                    );
                }
                return true;
            }),
        };
    });

    pi.on("session_tree", async (_event, ctx) => {
        reconstructTaskState(state, ctx);
        restoreToolsFromBranch(pi, state, ctx);
    });

    // ── Session lifecycle ─────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setStatus("tau-turn", ctx.ui.theme.fg("dim", "Ready"));

        // ── Tmux detection ───────────────────────────────────────────
        state.tmuxAvailable = isTmuxAvailable();
        if (!state.tmuxAvailable && !state.tmuxWarningShown) {
            state.tmuxWarningShown = true;
            ctx.ui.notify(
                "⚠️ tmux not found — using direct process management",
                "warning"
            );
        }

        // Clean up run directories and tmux sessions from dead pi processes
        if (state.tmuxAvailable) {
            cleanupStaleTmuxRunDirs();
        }

        // Restore background-tasks state
        const entries = ctx.sessionManager.getEntries();
        for (const entry of entries) {
            if (
                entry.type === "custom" &&
                entry.customType === "background-tasks-state"
            ) {
                const data = entry.data as {
                    jobs?: [
                        string,
                        Omit<
                            import("./types.js").BackgroundJob,
                            "proc" | "donePromise" | "resolveDone"
                        >,
                    ][];
                    jobCounter?: number;
                };
                if (data.jobs) {
                    for (const [id, jobData] of data.jobs) {
                        if (jobData.status === "running") {
                            // Tmux jobs store context in an ad-hoc `tmux` property
                            // that survives serialisation.
                            const tmux: unknown = (
                                jobData as unknown as Record<string, unknown>
                            ).tmux;
                            if (
                                typeof tmux === "object" &&
                                tmux !== null &&
                                "exitCodeFile" in tmux
                            ) {
                                // Tmux job — check sentinel file instead of pid
                                const exitCodeFile = (
                                    tmux as { exitCodeFile: string }
                                ).exitCodeFile;
                                const code = checkExitCode(exitCodeFile);
                                if (code !== undefined) {
                                    jobData.status = "completed";
                                    jobData.exitCode = code;
                                }
                                // else: still running — reattach the context
                                attachTmuxContext(
                                    jobData,
                                    tmux as import("./features/bash-tmux.js").TmuxJobContext
                                );
                            } else {
                                // Direct-spawn job — check if pid is alive
                                try {
                                    process.kill(jobData.pid, 0);
                                } catch {
                                    jobData.status = "completed";
                                }
                            }
                        }
                        state.backgroundJobs.set(id, jobData);
                    }
                }
                if (typeof data.jobCounter === "number") {
                    state.jobCounter = Math.max(
                        state.jobCounter,
                        data.jobCounter
                    );
                }
                break;
            }
        }

        // Restore plan-mode state from CLI flag
        if (pi.getFlag("plan") === true) {
            state.permissionMode = "plan";
        }

        // Restore plan-mode state from session entries
        const planModeEntry = entries
            .filter(
                (e: { type: string; customType?: string }) =>
                    e.type === "custom" && e.customType === "plan-mode"
            )
            .pop() as
            | {
                  data?: {
                      enabled?: boolean;
                      slug?: string;
                      previousMode?: import("./features/permissions/types.js").PermissionMode;
                  };
              }
            | undefined;

        if (planModeEntry?.data) {
            if (planModeEntry.data.enabled) {
                state.permissionMode = "plan";
            }
            state.planSlug = planModeEntry.data.slug;
            state.planPreviousMode = planModeEntry.data.previousMode;
        }

        if (state.permissionMode === "plan") {
            pi.setActiveTools([
                "read",
                "bash",
                "grep",
                "find",
                "ls",
                "questionnaire",
                "task",
                "enter_plan_mode",
                "exit_plan_mode",
            ]);
        }

        // Restore task state
        reconstructTaskState(state, ctx);

        // Restore tools-selector state
        restoreToolsFromBranch(pi, state, ctx);

        // ── Permission state initialisation ────────────────────────
        const permState = await initPermissionState(ctx.cwd);
        state.permissionMode = permState.mode;
        state.permissionRules = permState.rules;
        state.permissionAdditionalDirectories = permState.additionalDirectories;
        state.permissionDisableBypass = permState.disableBypass;
        state.permissionLastLoadedAt = permState.lastLoadedAt;
        state.permissionSessionRules = permState.sessionRules;
        state.permissionAskedCommands = permState.askedCommands;

        // ── Mode indicator in status bar (with shortcut hint at startup) ──
        if (ctx.hasUI) {
            const colour = modeColour(state.permissionMode);
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(
                    colour,
                    modeStatusText(state.permissionMode, true)
                )
            );
            state.permissionModeHintUntil = Date.now() + 10000;
            setTimeout(() => {
                if (Date.now() >= state.permissionModeHintUntil) {
                    ctx.ui.setStatus(
                        "tau-perm-mode",
                        ctx.ui.theme.fg(
                            modeColour(state.permissionMode),
                            modeStatusText(state.permissionMode, false)
                        )
                    );
                }
            }, 10000);
        }

        // Restore notification config
        for (const entry of ctx.sessionManager.getBranch()) {
            if (
                entry.type === "custom" &&
                entry.customType === "notifications-config"
            ) {
                const data = entry.data as
                    | {
                          persistent?: boolean;
                          respectDnd?: boolean;
                          enabledProviders?: string[];
                          providerConfigs?: Record<
                              string,
                              Record<string, string>
                          >;
                      }
                    | undefined;
                if (data) {
                    state.notificationPersistent = data.persistent ?? false;
                    state.notificationRespectDnd = data.respectDnd ?? true;
                    if (data.enabledProviders) {
                        state.enabledNotificationProviders = new Set(
                            data.enabledProviders
                        );
                    }
                    if (data.providerConfigs) {
                        state.notificationProviderConfigs =
                            data.providerConfigs;
                    }
                }
                break;
            }
        }

        cleanupStaleLogs();
    });

    pi.on("agent_end", async (event, ctx) => {
        // Stop timers and clear start time — guaranteed cleanup before
        // any fallible logic below. The interval's self-terminating guard
        // will also catch a surviving interval on its next tick.
        stopTitlebarSpinner(pi, state, ctx);
        showAgentTurnComplete(state, ctx);
        state.agentStartTime = undefined;

        // ── Notification ──────────────────────────────────────────────
        const doNotify = await shouldNotify(state);
        if (doNotify) {
            const sessionName = pi.getSessionName();
            const cwdBasename = ctx.cwd.split("/").pop() ?? "";
            const title = sessionName
                ? `Pi · ${sessionName}`
                : `Pi · ${cwdBasename}`;
            sendNotification(state, event.messages, title);
        }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopTitlebarSpinner(pi, state, ctx);
        stopAgentTimer(state);
        state.agentStartTime = undefined;

        cleanupTmuxRunDir();

        pi.appendEntry("background-tasks-state", {
            jobs: Array.from(state.backgroundJobs.entries()).map(
                ([id, job]) => [
                    id,
                    {
                        ...job,
                        proc: undefined,
                        donePromise: undefined,
                        resolveDone: undefined,
                    },
                ]
            ),
            jobCounter: state.jobCounter,
        });
    });
}
