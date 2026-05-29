/**
 * Plan mode tools — enter_plan_mode and exit_plan_mode.
 *
 * These are LLM-callable tools that manage the plan lifecycle.
 * `enter_plan_mode` requires user approval (permission system treats it as "ask").
 * `exit_plan_mode` presents the plan for review and starts execution.
 *
 * Also provides the `/plan` command and plan mode system prompt injection.
 */

import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { modeStatusText, modeColour } from "./permissions/index.js";
import {
    sessionSlug,
    createPlanFile,
    getPlanFilePath,
    readPlanFile,
} from "./plan-file.ts";
import { formatTaskTree, countIndependentBranches } from "./task.ts";
import { captureReload } from "./reload.ts";

// ─── Tool parameter schemas ─────────────────────────────────────────

const EnterPlanModeParams = Type.Object({
    title: Type.Optional(
        Type.String({
            description:
                "Short title for the plan. Defaults to the user's request summary.",
        })
    ),
    reason: Type.Optional(
        Type.String({
            description:
                "Why plan mode is being requested (shown to user for approval).",
        })
    ),
});

const ExitPlanModeParams = Type.Object({
    summary: Type.Optional(
        Type.String({
            description:
                "Brief summary of what the plan covers (shown in exit notification).",
        })
    ),
});

// ─── Execution modes ────────────────────────────────────────────────

export type ExecutionMode =
    | "continue"
    | "fresh"
    | "spawn"
    | "parallel"
    | "manual";

const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
    continue: "Continue in this session",
    fresh: "Fresh start (clear context)",
    spawn: "Spawn subagent",
    parallel: "Parallel (dispatch branches)",
    manual: "Manual (read plan when needed)",
};

// ─── Feature registration ───────────────────────────────────────────

export function registerPlanTools(pi: ExtensionAPI, state: TauState): void {
    // ── enter_plan_mode tool ──────────────────────────────────────

    pi.registerTool({
        name: "enter_plan_mode",
        label: "Enter Plan Mode",
        description:
            "Enter plan mode for read-only codebase exploration and planning. " +
            "Creates a plan file at .pi/plans/<slug>.md where the plan will be written. " +
            "In plan mode, only read tools and the plan file are accessible — no edits or writes. " +
            "Use this when the task is complex enough to warrant structured planning first.",
        parameters: EnterPlanModeParams,

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<PlanToolDetails>> {
            const sessionId = ctx.sessionManager.getSessionId();
            const slug = sessionSlug(sessionId);
            const title = params.title ?? `Plan ${slug}`;

            // Create plan file
            const planPath = createPlanFile(ctx.cwd, slug, title);

            // Store previous mode for restoration
            state.planSlug = slug;
            state.planPreviousMode = state.permissionMode;

            // Switch to plan mode
            state.permissionMode = "plan";
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

            // Update status bar
            if (ctx.hasUI) {
                const colour = modeColour("plan");
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(colour, modeStatusText("plan", true))
                );
            }

            // Persist plan state
            pi.appendEntry("plan-mode", {
                enabled: true,
                slug,
                previousMode: state.planPreviousMode,
            });

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Entered plan mode. Plan file: ${planPath}\n\n` +
                            `You can now explore the codebase with read-only tools. Build the plan:\n` +
                            `1. Explore the codebase using read, bash (read-only), grep, find\n` +
                            `2. Create tasks with the task tool to structure the implementation\n` +
                            `3. Write the narrative plan to ${planPath}\n` +
                            `4. Call exit_plan_mode when ready for user review\n\n` +
                            `Write operations are blocked except for the plan file and task tool.`,
                    },
                ],
                details: {
                    action: "enter",
                    planPath,
                    slug,
                },
            };
        },

        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("enter_plan_mode ")) +
                    theme.fg("dim", args.title ?? "(no title)"),
                0,
                0
            );
        },

        renderResult(result, _options, theme) {
            const details = result.details as PlanToolDetails | undefined;
            if (!details) return new Text("", 0, 0);
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg("muted", `Plan mode active — ${details.planPath}`),
                0,
                0
            );
        },
    });

    // ── exit_plan_mode tool ───────────────────────────────────────

    pi.registerTool({
        name: "exit_plan_mode",
        label: "Exit Plan Mode",
        description:
            "Exit plan mode and present the plan for user review. " +
            "The user will approve or reject the plan, then choose an execution mode. " +
            "Call this when the plan file is complete and the task tree is ready.",
        parameters: ExitPlanModeParams,

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<PlanToolDetails>> {
            const slug = state.planSlug;
            if (!slug) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: not in plan mode (no active plan slug).",
                        },
                    ],
                    details: { action: "exit", error: "not in plan mode" },
                };
            }

            const planPath = getPlanFilePath(ctx.cwd, slug);
            const planContent = readPlanFile(ctx.cwd, slug);

            // Present plan for review
            const summary = params.summary ?? "Plan is ready for review.";
            const taskTree =
                state.tasks.length > 0
                    ? `\n\nTask tree:\n${formatTaskTree(state.tasks)}`
                    : "\n\n(No tasks created during planning)";

            const reviewMessage = `**Plan Review**\n\n${summary}\n\nPlan file: \`${planPath}\`${taskTree}`;

            pi.sendMessage(
                {
                    customType: "plan-review",
                    content: reviewMessage,
                    display: true,
                },
                { triggerTurn: false }
            );

            // Ask user whether to approve the plan
            const approved = await ctx.ui.select(
                "Review plan — approve to proceed?",
                ["Approve", "Reject (continue planning)", "Cancel plan mode"]
            );

            if (approved === "Reject (continue planning)") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Plan rejected. Continue refining the plan in plan mode.",
                        },
                    ],
                    details: { action: "exit", rejected: true },
                };
            }

            if (approved === "Cancel plan mode") {
                cancelPlanMode(pi, state, ctx);
                return {
                    content: [
                        {
                            type: "text",
                            text: "Plan mode cancelled. Returned to previous mode.",
                        },
                    ],
                    details: { action: "exit", cancelled: true },
                };
            }

            // ── Approved: choose execution mode ───────────────────

            const execMode = await chooseExecutionMode(ctx, state);

            // Restore previous permission mode
            state.planExiting = true;
            const previousMode = state.planPreviousMode ?? "allow";
            state.permissionMode = previousMode;
            pi.setActiveTools(["read", "bash", "edit", "write"]);

            // Update status bar
            if (ctx.hasUI) {
                const colour = modeColour(previousMode);
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(colour, modeStatusText(previousMode, true))
                );
            }

            // Persist state
            pi.appendEntry("plan-mode", {
                enabled: false,
                slug,
                executing: true,
                executionMode: execMode,
            });

            const modeDescription = EXECUTION_MODE_LABELS[execMode];
            const planContentForInjection = planContent ?? "(empty plan file)";

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Plan approved. Execution mode: ${modeDescription}\n\n` +
                            `Plan file: ${planPath}\n` +
                            `Previous mode restored: ${previousMode}\n\n` +
                            `Begin executing the plan. Mark tasks in-progress before starting ` +
                            `and done when complete.`,
                    },
                ],
                details: {
                    action: "exit",
                    approved: true,
                    executionMode: execMode,
                    planPath,
                    planContent: planContentForInjection,
                },
            };
        },

        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("exit_plan_mode ")) +
                    theme.fg("dim", args.summary ?? ""),
                0,
                0
            );
        },

        renderResult(result, _options, theme) {
            const details = result.details as PlanToolDetails | undefined;
            if (!details) return new Text("", 0, 0);
            if (details.error) {
                return new Text(theme.fg("error", "✗ " + details.error), 0, 0);
            }
            if (details.rejected) {
                return new Text(
                    theme.fg("warning", "⏸ Plan rejected — continue planning"),
                    0,
                    0
                );
            }
            if (details.cancelled) {
                return new Text(theme.fg("dim", "⊘ Plan mode cancelled"), 0, 0);
            }
            const mode = details.executionMode ?? "continue";
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg(
                        "muted",
                        `Plan approved — ${EXECUTION_MODE_LABELS[mode]}`
                    ),
                0,
                0
            );
        },
    });

    // ── /plan command (updated to use new plan system) ────────────

    pi.registerCommand("plan", {
        description: "Toggle plan mode or show current plan",
        handler: async (args, ctx: ExtensionCommandContext) => {
            captureReload(state, ctx);
            const subcommand = args.trim().toLowerCase();

            if (subcommand === "show" && state.planSlug) {
                const content = readPlanFile(ctx.cwd, state.planSlug);
                if (content) {
                    ctx.ui.notify(content, "info");
                } else {
                    ctx.ui.notify("Plan file is empty or missing.", "warning");
                }
                return;
            }

            // Toggle plan mode
            if (state.permissionMode === "plan") {
                // Exit plan mode
                cancelPlanMode(pi, state, ctx);
            } else {
                // Enter plan mode
                const sessionId = ctx.sessionManager.getSessionId();
                const slug = sessionSlug(sessionId);
                const planPath = createPlanFile(ctx.cwd, slug);

                state.planSlug = slug;
                state.planPreviousMode = state.permissionMode;
                state.permissionMode = "plan";
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

                if (ctx.hasUI) {
                    const colour = modeColour("plan");
                    ctx.ui.setStatus(
                        "tau-perm-mode",
                        ctx.ui.theme.fg(colour, modeStatusText("plan", true))
                    );
                }

                pi.appendEntry("plan-mode", {
                    enabled: true,
                    slug,
                    previousMode: state.planPreviousMode,
                });

                ctx.ui.notify(`Plan mode enabled. Plan file: ${planPath}`);
            }
        },
    });
}

// ─── Execution mode selection ───────────────────────────────────────

async function chooseExecutionMode(
    ctx: ExtensionContext,
    state: TauState
): Promise<ExecutionMode> {
    // Get context usage to inform the "fresh start" decision
    const usage = ctx.getContextUsage();
    const usagePercent = usage?.percent;

    // Count independent task branches for parallel analysis
    const independentCount = countIndependentBranches(state.tasks);

    const options: string[] = [
        `Continue in this session${usagePercent != null && usagePercent > 50 ? ` (context: ${usagePercent}%)` : ""}`,
        `Fresh start (clear context, inject plan)`,
        `Spawn subagent (separate session)`,
        independentCount > 1
            ? `Parallel (${independentCount} independent branches)`
            : `Parallel (dispatch branches)`,
        `Manual (read plan when needed)`,
    ];

    const choice = await ctx.ui.select("Choose execution mode:", options);

    const modeMap: ExecutionMode[] = [
        "continue",
        "fresh",
        "spawn",
        "parallel",
        "manual",
    ];

    for (let i = 0; i < options.length; i++) {
        if (choice === options[i]) return modeMap[i];
    }

    // Default to continue
    return "continue";
}

/**
 * Count the number of independent task branches (root tasks with no
 * blocks/depends-on links between them).
 */
// countIndependentBranches moved to task.ts

// ─── Helpers ────────────────────────────────────────────────────────

function cancelPlanMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    const previousMode = state.planPreviousMode ?? "allow";
    state.permissionMode = previousMode;
    state.planSlug = undefined;
    state.planPreviousMode = undefined;
    state.planExiting = false;
    pi.setActiveTools(["read", "bash", "edit", "write"]);

    if (ctx.hasUI) {
        const colour = modeColour(previousMode);
        ctx.ui.setStatus(
            "tau-perm-mode",
            ctx.ui.theme.fg(colour, modeStatusText(previousMode, false))
        );
    }

    ctx.ui.notify("Plan mode disabled. Full access restored.", "info");

    pi.appendEntry("plan-mode", {
        enabled: false,
        slug: undefined,
        executing: false,
    });
}

// ─── Types ──────────────────────────────────────────────────────────

interface PlanToolDetails {
    action: "enter" | "exit";
    planPath?: string;
    slug?: string;
    error?: string;
    rejected?: boolean;
    cancelled?: boolean;
    approved?: boolean;
    executionMode?: ExecutionMode;
    planContent?: string;
}
