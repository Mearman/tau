/**
 * Custom footer feature — /footer command to toggle a token-usage and
 * git-branch footer via ctx.ui.setFooter().
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

/** Colour name for a given utilisation level (green → amber → red). */
function levelColour(pct: number): string {
    if (pct >= 85) return "error";
    if (pct >= 60) return "warning";
    return "success";
}

/**
 * Draw a fixed-width block-character bar, coloured by level.
 * `█` filled, `░` empty, clamped to 0–100.
 */
function drawBar(
    pct: number,
    width: number,
    theme: { fg(colour: string, text: string): string }
): string {
    const clamped = Math.min(100, Math.max(0, pct));
    const filled = Math.round((clamped / 100) * width);
    return theme.fg(
        levelColour(clamped),
        "█".repeat(filled) + "░".repeat(width - filled)
    );
}

export function registerCustomFooter(pi: ExtensionAPI, state: TauState): void {
    let enabled = false;

    pi.registerCommand("footer", {
        description: "Toggle custom footer",
        handler: async (_args, ctx) => {
            if (!isFeatureEnabled(state, "custom-footer")) {
                ctx.ui.notify(
                    "Custom footer is disabled — run /tau to enable",
                    "info"
                );
                return;
            }
            enabled = !enabled;

            if (enabled) {
                ctx.ui.setFooter((tui, theme, footerData) => {
                    const unsub = footerData.onBranchChange(() =>
                        tui.requestRender()
                    );

                    return {
                        dispose: unsub,
                        invalidate() {},
                        render(width: number): string[] {
                            let input = 0;
                            let output = 0;
                            let cost = 0;
                            for (const e of ctx.sessionManager.getBranch()) {
                                if (
                                    e.type === "message" &&
                                    e.message.role === "assistant"
                                ) {
                                    const m = e.message as {
                                        usage: {
                                            input: number;
                                            output: number;
                                            cost: { total: number };
                                        };
                                    };
                                    input += m.usage.input;
                                    output += m.usage.output;
                                    cost += m.usage.cost.total;
                                }
                            }

                            const branch = footerData.getGitBranch();
                            const fmt = (n: number) =>
                                n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
                            const lines: string[] = [];
                            const barWidth = 10;
                            const label = (s: string) => theme.fg("dim", s);

                            // Context window bar
                            const cu = ctx.getContextUsage();
                            if (cu && cu.percent != null) {
                                lines.push(
                                    truncateToWidth(
                                        `${label("Context  ")}${drawBar(
                                            cu.percent,
                                            barWidth,
                                            theme
                                        )}${label(
                                            ` ${Math.round(cu.percent)}%`
                                        )}`,
                                        width
                                    )
                                );
                            }

                            // Session tokens bar (relative to one context window)
                            const sessionTokens = input + output;
                            if (cu?.contextWindow && sessionTokens > 0) {
                                const sPct = Math.min(
                                    100,
                                    (sessionTokens / cu.contextWindow) * 100
                                );
                                lines.push(
                                    truncateToWidth(
                                        `${label("Session  ")}${drawBar(
                                            sPct,
                                            barWidth,
                                            theme
                                        )}${label(` ${fmt(sessionTokens)}`)}`,
                                        width
                                    )
                                );
                            }

                            // Weekly subscription quota bar
                            const rl = state.agentSdkRateLimit;
                            if (rl?.utilization != null) {
                                const window =
                                    rl.rateLimitType === "five_hour"
                                        ? "5h"
                                        : rl.rateLimitType === "seven_day" ||
                                            rl.rateLimitType ===
                                                "seven_day_opus" ||
                                            rl.rateLimitType ===
                                                "seven_day_sonnet"
                                          ? "7d"
                                          : (rl.rateLimitType ?? "");
                                lines.push(
                                    truncateToWidth(
                                        `${label("Weekly   ")}${drawBar(
                                            rl.utilization,
                                            barWidth,
                                            theme
                                        )}${label(
                                            ` ${Math.round(rl.utilization)}%${
                                                window ? " " + window : ""
                                            }`
                                        )}`,
                                        width
                                    )
                                );
                            }

                            // Token usage + model + branch info line
                            const left = theme.fg(
                                "dim",
                                `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`
                            );
                            const branchStr = branch ? ` (${branch})` : "";
                            const right = theme.fg(
                                "dim",
                                `${ctx.model?.id || "no-model"}${branchStr}`
                            );
                            const pad = " ".repeat(
                                Math.max(
                                    1,
                                    width -
                                        visibleWidth(left) -
                                        visibleWidth(right)
                                )
                            );
                            lines.push(
                                truncateToWidth(left + pad + right, width)
                            );
                            return lines;
                        },
                    };
                });
                ctx.ui.notify("Custom footer enabled", "info");
            } else {
                ctx.ui.setFooter(undefined);
                ctx.ui.notify("Default footer restored", "info");
            }
        },
    });
}
