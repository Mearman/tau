/**
 * Session name feature — /session-name command to set friendly names
 * that appear in the session selector.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

export function registerSessionName(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("session-name", {
        description:
            "Set or show session name (usage: /session-name [new name])",
        handler: async (args, ctx) => {
            if (!isFeatureEnabled(state, "session-name")) {
                ctx.ui.notify(
                    "Session name is disabled — run /tau to enable",
                    "info"
                );
                return;
            }
            const name = args.trim();

            if (name) {
                pi.setSessionName(name);
                ctx.ui.notify(`Session named: ${name}`, "info");
            } else {
                const current = pi.getSessionName();
                ctx.ui.notify(
                    current ? `Session: ${current}` : "No session name set",
                    "info"
                );
            }
        },
    });
}
