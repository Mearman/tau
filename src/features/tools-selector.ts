/**
 * Tools selector feature — /tools command to enable/disable tools.
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
    Container,
    type SettingItem,
    SettingsList,
} from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { captureReload } from "./reload.ts";

// ─── State persistence ──────────────────────────────────────────────

export function persistToolsState(pi: ExtensionAPI, state: TauState): void {
    pi.appendEntry("tools-config", {
        enabledTools: Array.from(state.enabledTools),
    });
}

export function applyToolsSelection(pi: ExtensionAPI, state: TauState): void {
    pi.setActiveTools(Array.from(state.enabledTools));
}

export function restoreToolsFromBranch(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    state.allTools = pi.getAllTools();
    const branchEntries = ctx.sessionManager.getBranch();
    let savedTools: string[] | undefined;
    for (const entry of branchEntries) {
        if (entry.type === "custom" && entry.customType === "tools-config") {
            const data = entry.data as { enabledTools?: string[] } | undefined;
            if (data?.enabledTools) savedTools = data.enabledTools;
        }
    }
    if (savedTools) {
        const allToolNames = state.allTools.map((t) => t.name);
        state.enabledTools = new Set(
            savedTools.filter((t) => allToolNames.includes(t))
        );
        applyToolsSelection(pi, state);
    } else {
        state.enabledTools = new Set(pi.getActiveTools());
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerToolsSelector(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("tools", {
        description: "Enable/disable tools",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            captureReload(state, ctx);
            state.allTools = pi.getAllTools();

            await ctx.ui.custom((_tui, theme, _kb, done) => {
                const items: SettingItem[] = state.allTools.map((tool) => ({
                    id: tool.name,
                    label: tool.name,
                    currentValue: state.enabledTools.has(tool.name)
                        ? "enabled"
                        : "disabled",
                    values: ["enabled", "disabled"],
                }));

                const container = new Container();
                container.addChild(
                    new (class {
                        render(_width: number) {
                            return [
                                theme.fg(
                                    "accent",
                                    theme.bold("Tool Configuration")
                                ),
                                "",
                            ];
                        }
                        invalidate() {}
                    })()
                );

                const settingsList = new SettingsList(
                    items,
                    Math.min(items.length + 2, 15),
                    getSettingsListTheme(),
                    (id: string, newValue: string) => {
                        if (newValue === "enabled") state.enabledTools.add(id);
                        else state.enabledTools.delete(id);
                        applyToolsSelection(pi, state);
                        persistToolsState(pi, state);
                    },
                    () => {
                        done(undefined);
                    }
                );

                container.addChild(settingsList);

                return {
                    render(width: number) {
                        return container.render(width);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        settingsList.handleInput?.(data);
                    },
                };
            });
        },
    });
}
