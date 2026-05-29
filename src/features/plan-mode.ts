/**
 * Plan mode feature — toggle and /plan command registration.
 *
 * The permission system's "plan" mode is the single source of truth for
 * plan-mode state. This module provides the user-facing toggles:
 * - /plan command
 * - Ctrl+Alt+P shortcut
 * - --plan CLI flag
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import type { PermissionMode } from "./permissions/types.js";
import { modeStatusText, modeColour } from "./permissions/index.js";
import { sessionSlug, createPlanFile } from "./plan-file.ts";
import { NORMAL_MODE_TOOLS } from "../utils.ts";

function updatePlanStatus(state: TauState, ctx: ExtensionContext): void {
    if (state.permissionMode === "plan") {
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "⏸ planning"));
    } else {
        ctx.ui.setStatus("plan-mode", undefined);
    }
    ctx.ui.setWidget("plan-todos", undefined);
}

export function togglePlanMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    if (state.permissionMode === "plan") {
        const previousMode: PermissionMode = state.planPreviousMode ?? "allow";
        state.permissionMode = previousMode;
        state.planSlug = undefined;
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
        const sessionId = ctx.sessionManager.getSessionId();
        const slug = sessionSlug(sessionId);
        const planPath = createPlanFile(ctx.cwd, slug);

        state.planPreviousMode = state.permissionMode;
        state.permissionMode = "plan";
        state.planSlug = slug;
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
