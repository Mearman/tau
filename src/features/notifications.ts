/**
 * Notifications feature — agent completion notifications with DnD support.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
    Container,
    type SettingItem,
    SettingsList,
} from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import {
    isSystemDndActive,
    lastAssistantText,
    notify,
    truncateNotificationBody,
} from "../utils.ts";

// ─── Feature registration ───────────────────────────────────────────

export function registerNotifications(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("notifications", {
        description: "Configure notifications (DnD / persistence)",
        handler: async (_args, ctx) => {
            const systemDnd = await isSystemDndActive();

            await ctx.ui.custom((_tui, theme, _kb, done) => {
                const items: SettingItem[] = [
                    {
                        id: "notifications-persistent",
                        label: "Persistent (stay until dismissed)",
                        currentValue: state.notificationPersistent
                            ? "persistent"
                            : "auto",
                        values: ["persistent", "auto"],
                    },
                    {
                        id: "notifications-respect-dnd",
                        label: "Respect system DnD",
                        currentValue: state.notificationRespectDnd
                            ? "enabled"
                            : "disabled",
                        values: ["enabled", "disabled"],
                    },
                ];

                const container = new Container();
                container.addChild(
                    new (class {
                        render(_width: number) {
                            const lines = [
                                theme.fg(
                                    "accent",
                                    theme.bold("Notification Settings")
                                ),
                                "",
                            ];
                            if (systemDnd && state.notificationRespectDnd) {
                                lines.push(
                                    theme.fg(
                                        "warning",
                                        "  System DnD: active → suppressed"
                                    )
                                );
                                lines.push("");
                            }
                            return lines;
                        }
                        invalidate() {}
                    })()
                );

                const settingsList = new SettingsList(
                    items,
                    Math.min(items.length + 2, 15),
                    getSettingsListTheme(),
                    (_id: string, newValue: string) => {
                        if (newValue === "persistent" || newValue === "auto") {
                            state.notificationPersistent =
                                newValue === "persistent";
                        } else {
                            state.notificationRespectDnd =
                                newValue === "enabled";
                        }
                        pi.appendEntry("notifications-config", {
                            persistent: state.notificationPersistent,
                            respectDnd: state.notificationRespectDnd,
                        });
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

// ─── Notification helpers (called from lifecycle) ───────────────────

export async function shouldNotify(state: TauState): Promise<boolean> {
    if (state.notificationRespectDnd) {
        const dnd = await isSystemDndActive();
        if (dnd) return false;
    }
    return true;
}

export function sendNotification(
    state: TauState,
    messages: {
        role: string;
        content?: string | { type: string; text?: string }[];
    }[]
): void {
    const body = lastAssistantText(messages);
    const notificationBody = body
        ? truncateNotificationBody(body)
        : "Ready for input";
    notify("Pi", notificationBody, state.notificationPersistent);
}
