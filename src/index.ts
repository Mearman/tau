/**
 * Tau (τ) — Quality-of-Life Extension for pi
 *
 * Background tasks, notifications, plan mode, presets, and other enhancements.
 *
 * Tools: bash (overridden), bash_bg, jobs, job_decide, task
 * Commands: /bg, /fg, /jobs, /tasks, /tools, /plan, /bookmark, /unbookmark,
 *           /context, /footer, /handoff, /notifications, /preset, /session-name, /summarize
 * Shortcuts: Ctrl+B (background/resume), Ctrl+J / Shift+Down (tasks),
 *            Ctrl+X (kill), Ctrl+Alt+P (plan mode), Ctrl+Shift+U (preset cycle)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TauState } from "./state.ts";
import {
    cleanupStaleLogs,
    NORMAL_MODE_TOOLS,
    PLAN_MODE_TOOLS,
} from "./utils.ts";
import {
    isSafeCommand,
    extractTodoItems,
    markCompletedSteps,
} from "./plan-utils.ts";
import {
    isAssistantMessage,
    getTextContent,
    updatePlanStatus,
} from "./features/plan-mode.ts";
import {
    startTitlebarSpinner,
    stopTitlebarSpinner,
    startAgentTimer,
    stopAgentTimer,
} from "./features/titlebar.ts";

// Existing features
import { registerBackgroundJobs } from "./features/background.ts";
import { registerBackgroundCommands } from "./features/background-commands.ts";
import { registerAgentBackground } from "./features/agent-background.ts";
import { registerPlanMode } from "./features/plan-mode.ts";
import { registerTask, reconstructTaskState } from "./features/task.ts";
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
import { registerHandoff } from "./features/handoff.ts";
import { registerPreset } from "./features/preset.ts";
import { registerLoop } from "./features/loop.ts";
import { registerSessionName } from "./features/session-name.ts";
import { registerSummarize } from "./features/summarize.ts";
import { registerContext } from "./features/context.ts";
import { registerWebBrowse } from "./features/web-browse/index.ts";
import { registerReloadTool } from "./features/reload.ts";

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
    registerHandoff(pi);
    registerPreset(pi);
    registerLoop(pi);
    registerSessionName(pi);
    registerSummarize(pi);
    registerContext(pi);
    registerWebBrowse(pi);
    registerReloadTool(pi, state);

    // ── Agent events (cross-cutting) ──────────────────────────────────

    pi.on("agent_start", async (_event, ctx) => {
        startTitlebarSpinner(pi, state, ctx);
        state.agentStartTime = Date.now();
        startAgentTimer(state, ctx);
    });

    pi.on("tool_call", async (event): Promise<ToolCallEventResult> => {
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

        // Plan-mode: block destructive bash commands
        if (state.planModeEnabled && event.toolName === "bash") {
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

    pi.on("turn_start", async (_event, ctx) => {
        if (state.agentStartTime !== undefined && !state.agentTimer)
            startAgentTimer(state, ctx);
    });

    pi.on("turn_end", async (event, ctx) => {
        // Stop the elapsed timer between turns
        if (state.agentTimer) {
            clearInterval(state.agentTimer);
            state.agentTimer = null;
        }

        // Plan-mode progress tracking
        if (state.planExecutionMode && state.planItems.length > 0) {
            if (isAssistantMessage(event.message)) {
                const text = getTextContent(event.message);
                if (markCompletedSteps(text, state.planItems) > 0) {
                    updatePlanStatus(state, ctx);
                }
            }
        }
    });

    // Plan-mode: inject context before agent starts
    pi.on("before_agent_start", async () => {
        if (state.planModeEnabled) {
            return {
                message: {
                    customType: "plan-mode-context",
                    content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
                    display: false,
                },
            };
        }

        if (state.planExecutionMode && state.planItems.length > 0) {
            const remaining = state.planItems.filter((t) => !t.completed);
            const todoList = remaining
                .map((t) => `${t.step}. ${t.text}`)
                .join("\n");
            return {
                message: {
                    customType: "plan-execution-context",
                    content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
                    display: false,
                },
            };
        }
    });

    // Plan-mode: filter out stale context when not active
    pi.on("context", async (event) => {
        if (state.planModeEnabled) return;

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
                            try {
                                process.kill(jobData.pid, 0);
                            } catch {
                                jobData.status = "completed";
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

        // Restore plan-mode state
        if (pi.getFlag("plan") === true) {
            state.planModeEnabled = true;
        }

        const planModeEntry = entries
            .filter(
                (e: { type: string; customType?: string }) =>
                    e.type === "custom" && e.customType === "plan-mode"
            )
            .pop() as
            | {
                  data?: {
                      enabled: boolean;
                      todos?: import("./plan-utils.js").TodoItem[];
                      executing?: boolean;
                  };
              }
            | undefined;

        if (planModeEntry?.data) {
            state.planModeEnabled =
                planModeEntry.data.enabled ?? state.planModeEnabled;
            state.planItems = planModeEntry.data.todos ?? state.planItems;
            state.planExecutionMode =
                planModeEntry.data.executing ?? state.planExecutionMode;
        }

        // On resume: re-scan messages to rebuild plan completion state
        if (
            planModeEntry !== undefined &&
            state.planExecutionMode &&
            state.planItems.length > 0
        ) {
            let executeIndex = -1;
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i] as {
                    type: string;
                    customType?: string;
                };
                if (entry.customType === "plan-mode-execute") {
                    executeIndex = i;
                    break;
                }
            }
            const messages: import("@earendil-works/pi-ai").AssistantMessage[] =
                [];
            for (let i = executeIndex + 1; i < entries.length; i++) {
                const entry = entries[i];
                if (
                    entry.type === "message" &&
                    "message" in entry &&
                    isAssistantMessage(entry.message)
                ) {
                    messages.push(entry.message);
                }
            }
            const allText = messages.map(getTextContent).join("\n");
            markCompletedSteps(allText, state.planItems);
        }

        if (state.planModeEnabled) {
            pi.setActiveTools(PLAN_MODE_TOOLS);
        }
        updatePlanStatus(state, ctx);

        // Restore task state
        reconstructTaskState(state, ctx);

        // Restore tools-selector state
        restoreToolsFromBranch(pi, state, ctx);

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
        stopTitlebarSpinner(pi, state, ctx);
        stopAgentTimer(state, ctx);
        state.agentStartTime = undefined;

        // ── Plan-mode: completion detection ──────────────────────────
        if (state.planExecutionMode && state.planItems.length > 0) {
            if (state.planItems.every((t) => t.completed)) {
                const completedList = state.planItems
                    .map((t) => `~~${t.text}~~`)
                    .join("\n");
                pi.sendMessage(
                    {
                        customType: "plan-complete",
                        content: `**Plan Complete!** ✓\n\n${completedList}`,
                        display: true,
                    },
                    { triggerTurn: false }
                );
                state.planExecutionMode = false;
                state.planItems = [];
                pi.setActiveTools(NORMAL_MODE_TOOLS);
                updatePlanStatus(state, ctx);
                pi.appendEntry("plan-mode", {
                    enabled: false,
                    todos: [],
                    executing: false,
                });
            } else {
                pi.appendEntry("plan-mode", {
                    enabled: state.planModeEnabled,
                    todos: state.planItems,
                    executing: state.planExecutionMode,
                });
            }
        } else if (state.planModeEnabled && ctx.hasUI) {
            const lastAssistant = [...event.messages]
                .reverse()
                .find(isAssistantMessage);
            if (lastAssistant) {
                const extracted = extractTodoItems(
                    getTextContent(lastAssistant)
                );
                if (extracted.length > 0) state.planItems = extracted;
            }

            if (state.planItems.length > 0) {
                const todoListText = state.planItems
                    .map((t, i) => `${i + 1}. ☐ ${t.text}`)
                    .join("\n");
                pi.sendMessage(
                    {
                        customType: "plan-todo-list",
                        content: `**Plan Steps (${state.planItems.length}):**\n\n${todoListText}`,
                        display: true,
                    },
                    { triggerTurn: false }
                );
            }

            const choice = await ctx.ui.select("Plan mode - what next?", [
                state.planItems.length > 0
                    ? "Execute the plan (track progress)"
                    : "Execute the plan",
                "Stay in plan mode",
                "Refine the plan",
            ]);

            if (choice?.startsWith("Execute")) {
                state.planModeEnabled = false;
                state.planExecutionMode = state.planItems.length > 0;
                pi.setActiveTools(NORMAL_MODE_TOOLS);
                updatePlanStatus(state, ctx);

                const execMessage =
                    state.planItems.length > 0
                        ? `Execute the plan. Start with: ${state.planItems[0].text}`
                        : "Execute the plan you just created.";
                pi.sendMessage(
                    {
                        customType: "plan-mode-execute",
                        content: execMessage,
                        display: true,
                    },
                    { triggerTurn: true }
                );
            } else if (choice === "Refine the plan") {
                const refinement = await ctx.ui.editor("Refine the plan:", "");
                if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
            }
        }

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
