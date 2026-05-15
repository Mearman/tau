/**
 * Bookmark feature — /bookmark and /unbookmark commands for labelling
 * entries in the tree view for easy navigation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerBookmark(pi: ExtensionAPI): void {
    pi.registerCommand("bookmark", {
        description: "Bookmark last message (usage: /bookmark [label])",
        handler: async (args, ctx) => {
            const label = args.trim() || `bookmark-${Date.now()}`;

            const entries = ctx.sessionManager.getEntries();
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                if (
                    entry.type === "message" &&
                    entry.message.role === "assistant"
                ) {
                    pi.setLabel(entry.id, label);
                    ctx.ui.notify(`Bookmarked as: ${label}`, "info");
                    return;
                }
            }

            ctx.ui.notify("No assistant message to bookmark", "warning");
        },
    });

    pi.registerCommand("unbookmark", {
        description: "Remove bookmark from last labelled entry",
        handler: async (_args, ctx) => {
            const entries = ctx.sessionManager.getEntries();
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                const label = ctx.sessionManager.getLabel(entry.id);
                if (label) {
                    pi.setLabel(entry.id, undefined);
                    ctx.ui.notify(`Removed bookmark: ${label}`, "info");
                    return;
                }
            }
            ctx.ui.notify("No bookmarked entry found", "warning");
        },
    });
}
