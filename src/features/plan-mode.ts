/**
 * Plan mode feature — read-only exploration mode with execution tracking.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { NORMAL_MODE_TOOLS } from "../utils.ts";
import { markCompletedSteps } from "../plan-utils.ts";
import { sessionSlug, createPlanFile } from "./plan-file.ts";
import type { PermissionMode } from "./permissions/types.js";
import { modeStatusText, modeColour } from "./permissions/index.js";

function isAssistantMessage(m: {
    role: string;
    content?: unknown;
}): m is AssistantMessage {
    return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
    return message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

export function updatePlanStatus(state: TauState, ctx: ExtensionContext): void {
    if (state.planExecutionMode && state.planItems.length > 0) {
        const completed = state.planItems.filter((t) => t.completed).length;
        ctx.ui.setStatus(
            "plan-mode",
            ctx.ui.theme.fg(
                "accent",
                `📋 ${completed}/${state.planItems.length}`
            )
        );
    } else if (state.planModeEnabled) {
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
        ctx.ui.setStatus("plan-mode", undefined);
    }

    if (state.planExecutionMode && state.planItems.length > 0) {
        const lines = state.planItems.map((item) => {
            if (item.completed) {
                return (
                    ctx.ui.theme.fg("success", "☑ ") +
                    ctx.ui.theme.fg(
                        "muted",
                        ctx.ui.theme.strikethrough(item.text)
                    )
                );
            }
            return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
        });
        ctx.ui.setWidget("plan-todos", lines);
    } else {
        ctx.ui.setWidget("plan-todos", undefined);
    }
}

export function togglePlanMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    if (state.planModeEnabled || state.permissionMode === "plan") {
        // Exit plan mode — restore previous permission mode
        state.planModeEnabled = false;
        state.planExecutionMode = false;
        state.planItems = [];
        state.planSlug = undefined;

        const previousMode: PermissionMode = state.planPreviousMode ?? "allow";
        state.permissionMode = previousMode;
        state.planPreviousMode = undefined;
        pi.setActiveTools(NORMAL_MODE_TOOLS);

        if (ctx.hasUI) {
            const colour = modeColour(previousMode);
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(colour, modeStatusText(previousMode, false))
            );
        }
        ctx.ui.notify("Plan mode disabled. Full access restored.");
    } else {
        // Enter plan mode — create plan file
        const sessionId = ctx.sessionManager.getSessionId();
        const slug = sessionSlug(sessionId);
        const planPath = createPlanFile(ctx.cwd, slug);

        state.planPreviousMode = state.permissionMode;
        state.planModeEnabled = true;
        state.permissionMode = "plan";
        state.planSlug = slug;
        state.planExecutionMode = false;
        state.planItems = [];
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
        ctx.ui.notify(`Plan mode enabled. Plan file: ${planPath}`);
    }
    updatePlanStatus(state, ctx);
}

// ─── Feature registration ───────────────────────────────────────────

export function registerPlanMode(pi: ExtensionAPI, state: TauState): void {
    pi.registerFlag("plan", {
        description: "Start in plan mode (read-only exploration)",
        type: "boolean",
        default: false,
    });

    pi.registerCommand("plan", {
        description: "Toggle plan mode (read-only exploration)",
        handler: async (_args, ctx) => {
            togglePlanMode(pi, state, ctx);
        },
    });

    pi.registerShortcut(Key.ctrlAlt("p"), {
        description: "Toggle plan mode",
        handler: async (ctx) => {
            togglePlanMode(pi, state, ctx);
        },
    });
}

// Re-export helpers used by index.ts lifecycle handlers
export { isAssistantMessage, getTextContent, markCompletedSteps };
