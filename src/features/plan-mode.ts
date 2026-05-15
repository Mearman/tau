/**
 * Plan mode feature — read-only exploration mode with execution tracking.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { TauState } from "../state.js";
import { NORMAL_MODE_TOOLS, PLAN_MODE_TOOLS } from "../utils.js";
import { markCompletedSteps } from "../plan-utils.js";

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
    state.planModeEnabled = !state.planModeEnabled;
    state.planExecutionMode = false;
    state.planItems = [];

    if (state.planModeEnabled) {
        pi.setActiveTools(PLAN_MODE_TOOLS);
        ctx.ui.notify(
            `Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`
        );
    } else {
        pi.setActiveTools(NORMAL_MODE_TOOLS);
        ctx.ui.notify("Plan mode disabled. Full access restored.");
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
