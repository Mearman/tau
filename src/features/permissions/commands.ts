/**
 * Permission mode commands and keybindings.
 *
 * Provides:
 * - /perm — cycle or set permission mode, show current rules
 * - Ctrl+Shift+P — cycle permission mode
 * - Status bar indicator for non-default modes
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { TauState } from "../../state.js";
import type { PermissionMode } from "./types.js";
import {
    nextMode,
    modeStatusText,
    modeColour,
    PERMISSION_MODES,
    MODE_TITLES,
    MODE_SHORT_TITLES,
} from "./modes.js";
import { isBypassAvailable } from "./modes.js";

export function registerPermissions(pi: ExtensionAPI, state: TauState): void {
    // ── /perm command ─────────────────────────────────────────────

    pi.registerCommand("perm", {
        description: "Permission mode: cycle, set, or inspect",
        handler: async (args, ctx) => {
            const subcommand = args.trim().toLowerCase();

            if (!subcommand || subcommand === "status") {
                // Show current mode and rules
                const modeTitle = MODE_TITLES[state.permissionMode];
                const ruleSummary =
                    state.permissionRules.length > 0
                        ? state.permissionRules
                              .map(
                                  (r: {
                                      behavior: string;
                                      rule: string;
                                      source: string;
                                  }) =>
                                      `  ${r.behavior.padEnd(5)} ${r.rule}  (${r.source})`
                              )
                              .join("\n")
                        : "  (none)";

                ctx.ui.notify(
                    `Permission mode: ${modeTitle}\nRules:\n${ruleSummary}`,
                    "info"
                );
                return;
            }

            if (subcommand === "cycle") {
                cycleMode(pi, state, ctx);
                return;
            }

            // Try to set a specific mode
            const target = PERMISSION_MODES.find(
                (m) =>
                    m.toLowerCase() === subcommand ||
                    MODE_SHORT_TITLES[m].toLowerCase() === subcommand
            );

            if (target) {
                if (
                    target === "allow" &&
                    !isBypassAvailable(state.permissionDisableBypass)
                ) {
                    ctx.ui.notify(
                        "allow mode is disabled by settings.",
                        "warning"
                    );
                    return;
                }
                setMode(pi, state, ctx, target);
                return;
            }

            // Unknown subcommand — show help
            const modeList = PERMISSION_MODES.filter((m) =>
                m === "allow"
                    ? isBypassAvailable(state.permissionDisableBypass)
                    : true
            )
                .map((m) => `  ${m} (${MODE_SHORT_TITLES[m]})`)
                .join("\n");

            ctx.ui.notify(
                `Usage: /perm [status|cycle|<mode>]\n\nModes:\n${modeList}`,
                "info"
            );
        },
    });

    // ── Ctrl+Shift+P — cycle permission mode ──────────────────────

    pi.registerShortcut(Key.tab, {
        description: "Cycle permission mode",
        handler: async (ctx) => {
            cycleMode(pi, state, ctx);
        },
    });
}

// ── Mode cycling ─────────────────────────────────────────────────────

function cycleMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    const next = nextMode(
        state.permissionMode,
        isBypassAvailable(state.permissionDisableBypass)
    );
    setMode(pi, state, ctx, next);
}

function setMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext,
    mode: PermissionMode
): void {
    const prev = state.permissionMode;
    state.permissionMode = mode;

    // Update tool sets based on mode
    if (mode === "plan") {
        pi.setActiveTools([
            "read",
            "bash",
            "grep",
            "find",
            "ls",
            "questionnaire",
        ]);
        // Also sync legacy plan mode flag
        state.planModeEnabled = true;
    } else if (prev === "plan") {
        pi.setActiveTools(["read", "bash", "edit", "write"]);
        state.planModeEnabled = false;
    }

    // Update status bar
    if (ctx.hasUI) {
        if (mode === "ask") {
            ctx.ui.setStatus("tau-perm-mode", undefined);
        } else {
            const colour = modeColour(mode);
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(colour, modeStatusText(mode))
            );
        }
    }

    const title = MODE_TITLES[mode];
    ctx.ui.notify(`Permission mode: ${title}`, "info");
}
