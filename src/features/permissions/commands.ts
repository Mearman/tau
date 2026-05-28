/**
 * Permission mode commands and keybindings.
 *
 * Provides:
 * - /perm — cycle or set permission mode, show current rules, add rules
 * - Shift+Tab — cycle permission mode
 * - Ctrl+Shift+T — cycle thinking level (replaces Shift+Tab which is now permission cycling)
 * - Status bar indicator for current permission mode
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
import { writeRuleToSettings } from "./config.js";
import type { PermissionUpdateDestination } from "./types.js";

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

            // /perm add <rule> [destination]
            if (subcommand.startsWith("add ")) {
                const parts = subcommand.slice(4).trim().split(/\s+/);
                const rule = parts[0];
                const destArg = (parts[1] ?? "session").toLowerCase();
                const destMap: Record<string, PermissionUpdateDestination> = {
                    session: "session",
                    local: "localSettings",
                    project: "projectSettings",
                    user: "userSettings",
                    always: "userSettings",
                };
                const dest = destMap[destArg];

                if (!rule) {
                    ctx.ui.notify(
                        "Usage: /perm add <rule> [session|local|project|always]",
                        "warning"
                    );
                    return;
                }

                if (!dest) {
                    ctx.ui.notify(
                        `Unknown destination "${destArg}". Use: session, local, project, always`,
                        "warning"
                    );
                    return;
                }

                if (dest === "session") {
                    if (!state.permissionSessionRules.includes(rule)) {
                        state.permissionSessionRules.push(rule);
                        state.permissionRules.push({
                            rule,
                            behavior: "allow",
                            source: "session",
                        });
                    }
                    ctx.ui.notify(`Added session rule: ${rule}`, "info");
                } else {
                    const ok = writeRuleToSettings(rule, dest, ctx.cwd);
                    if (ok) {
                        ctx.ui.notify(`Added ${destArg} rule: ${rule}`, "info");
                    } else {
                        ctx.ui.notify(
                            `Failed to write rule to settings file`,
                            "error"
                        );
                    }
                }
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
                `Usage: /perm [status|cycle|add|<mode>]\n\nModes:\n${modeList}\n\nAdd rule: /perm add <rule> [session|local|project|always]`,
                "info"
            );
        },
    });

    // ── Shift+Tab — cycle permission mode ──────────────────────

    pi.registerShortcut(Key.shift("tab"), {
        description: "Cycle permission mode",
        handler: async (ctx) => {
            cycleMode(pi, state, ctx);
        },
    });

    // ── Ctrl+Shift+T — cycle thinking level ────────────────────
    // Replaces Shift+Tab (which was app.thinking.cycle) now that
    // Shift+Tab is used for permission mode cycling.

    const THINKING_LEVELS = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
    ] as const;

    pi.registerShortcut(Key.ctrlShift("t"), {
        description: "Cycle thinking level",
        handler: async (_ctx) => {
            const current = pi.getThinkingLevel();
            const idx = THINKING_LEVELS.indexOf(current);
            const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
            pi.setThinkingLevel(next);
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
        const colour = modeColour(mode);
        ctx.ui.setStatus(
            "tau-perm-mode",
            ctx.ui.theme.fg(colour, modeStatusText(mode))
        );
    }

    const title = MODE_TITLES[mode];
    ctx.ui.notify(`Permission mode: ${title}`, "info");
}
