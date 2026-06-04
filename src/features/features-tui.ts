/**
 * Features TUI — interactive overlay for toggling tau features.
 *
 * Opens via `/tau` or `/tau features` (no verb). Shows a SettingsList
 * with one row per feature, displaying the effective value (on/off)
 * and the source layer. Enter cycles between on and off at the
 * "temporary" scope. For precise scope control, use the CLI:
 * `/tau features set <id> on|off --scope <scope>`.
 */

import {
    getSettingsListTheme,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    SettingsList,
    type SettingItem,
} from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { FEATURE_REGISTRY } from "./features-registry.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import { setFeatureOverride } from "./features-state.ts";

/**
 * Open the features TUI overlay. Returns when the user closes it.
 */
export async function showFeaturesTui(
    state: TauState,
    ctx: ExtensionCommandContext
): Promise<void> {
    await ctx.ui.custom((_tui, theme, _kb, done) => {
        const items: SettingItem[] = FEATURE_REGISTRY.map((f) => ({
            id: f.id,
            label: f.label,
            currentValue: isFeatureEnabled(state, f.id) ? "on" : "off",
            values: ["on", "off"],
        }));

        const container = new Container();
        container.addChild(
            new (class {
                render(_width: number) {
                    return [theme.fg("accent", theme.bold("Tau Features")), ""];
                }
                invalidate() {}
            })()
        );

        const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 20),
            getSettingsListTheme(),
            (id: string, newValue: string) => {
                const value = newValue === "on";
                setFeatureOverride(state, id, value, "temporary");
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
}
