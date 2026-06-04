/**
 * /tau command registration — wires the arg parser, autocomplete,
 * TUI overlay, and set/get/unset handlers into the pi command system.
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import {
    parseTauArgs,
    getTauCompletions,
    type AutocompleteItem,
} from "./features-cmd.ts";
import { showFeaturesTui } from "./features-tui.ts";
import { isFeatureEnabled, getFeatureSource } from "./features-helpers.ts";
import { setFeatureOverride, unsetFeatureOverride } from "./features-state.ts";
import { getFeatureDef } from "./features-registry.ts";

export function registerTauCommand(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("tau", {
        description: "Toggle tau features: set, get, unset, or open the TUI",
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const parsed = parseTauArgs(args);

            switch (parsed.kind) {
                case "list": {
                    await showFeaturesTui(state, ctx);
                    break;
                }
                case "get": {
                    const value = isFeatureEnabled(state, parsed.id);
                    const source = getFeatureSource(state, parsed.id);
                    const def = getFeatureDef(parsed.id);
                    ctx.ui.notify(
                        `${def?.label ?? parsed.id}: ${value ? "on" : "off"} (source: ${source})`,
                        "info"
                    );
                    break;
                }
                case "set": {
                    setFeatureOverride(
                        state,
                        parsed.id,
                        parsed.value,
                        parsed.scope,
                        { cwd: ctx.cwd }
                    );
                    const def = getFeatureDef(parsed.id);
                    ctx.ui.notify(
                        `${def?.label ?? parsed.id}: ${parsed.value ? "on" : "off"} at ${parsed.scope}`,
                        "info"
                    );
                    break;
                }
                case "unset": {
                    unsetFeatureOverride(state, parsed.id, parsed.scope, {
                        cwd: ctx.cwd,
                    });
                    const def = getFeatureDef(parsed.id);
                    const newValue = isFeatureEnabled(state, parsed.id);
                    ctx.ui.notify(
                        `${def?.label ?? parsed.id}: unset at ${parsed.scope} (now: ${newValue ? "on" : "off"})`,
                        "info"
                    );
                    break;
                }
                case "error": {
                    ctx.ui.notify(parsed.message, "warning");
                    break;
                }
            }
        },
        getArgumentCompletions(
            argumentPrefix: string
        ): AutocompleteItem[] | null {
            return getTauCompletions(argumentPrefix);
        },
    });
}
