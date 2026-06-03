/**
 * Notifications feature — agent completion notifications with DnD support
 * and pluggable provider architecture.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
    Container,
    type SettingItem,
    SettingsList,
} from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import {
    isSystemDndActive,
    lastAssistantText,
    truncateNotificationBody,
} from "../utils.ts";
import { allProviders, dispatch } from "../notifications/registry.ts";
import type { NotificationProvider } from "../notifications/types.ts";

// ─── Persistence ────────────────────────────────────────────────────

function persistNotificationConfig(pi: ExtensionAPI, state: TauState): void {
    pi.appendEntry("notifications-config", {
        persistent: state.notificationPersistent,
        respectDnd: state.notificationRespectDnd,
        enabledProviders: [...state.enabledNotificationProviders],
        providerConfigs: state.notificationProviderConfigs,
    });
}

// ─── Settings UI construction ───────────────────────────────────────

function buildSettingsItems(
    pi: ExtensionAPI,
    state: TauState,
    requestRebuild: () => void
): SettingItem[] {
    const items: SettingItem[] = [
        {
            id: "notifications-persistent",
            label: "Persistent (stay until dismissed)",
            currentValue: state.notificationPersistent ? "persistent" : "auto",
            values: ["persistent", "auto"],
        },
        {
            id: "notifications-respect-dnd",
            label: "Respect system DnD",
            currentValue: state.notificationRespectDnd ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
        },
    ];

    // Provider enable/disable toggles
    for (const provider of allProviders()) {
        const isEnabled = state.enabledNotificationProviders.has(provider.id);
        items.push({
            id: `provider-toggle-${provider.id}`,
            label: `${provider.label} notifications`,
            currentValue: isEnabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
        });

        // Per-provider credential fields — only shown when enabled
        if (isEnabled && provider.fields.length > 0) {
            items.push(providerFieldsItem(pi, state, provider, requestRebuild));
        }
    }

    return items;
}

/**
 * Build a setting item that opens a sub-settings list for provider credentials.
 * Shows the source of each field (env var vs stored vs not set).
 */
function providerFieldsItem(
    pi: ExtensionAPI,
    state: TauState,
    provider: NotificationProvider,
    requestRebuild: () => void
): SettingItem {
    const stored = state.notificationProviderConfigs[provider.id] ?? {};
    const resolved = provider.resolveConfig(stored);
    const configured = provider.isConfigured(resolved);

    return {
        id: `provider-config-${provider.id}`,
        label: `  ${provider.label} credentials`,
        currentValue: configured ? "✓ configured" : "✗ not configured",
        submenu: (_currentValue, submenuDone) => {
            const fieldItems: SettingItem[] = provider.fields.map((field) => {
                const envVal = field.envVar
                    ? process.env[field.envVar]
                    : undefined;
                const storedVal = stored[field.name] ?? "";
                const hasValue = (envVal ?? storedVal) !== "";

                let displayValue: string;
                if (envVal) {
                    displayValue = `✓ ${field.envVar}`;
                } else if (storedVal) {
                    displayValue = maskSecret(storedVal);
                } else {
                    displayValue = "(not set)";
                }

                return {
                    id: `provider-field-${provider.id}-${field.name}`,
                    label: field.label,
                    description: field.hint,
                    currentValue: displayValue,
                    // When a stored value exists, cycling clears it.
                    // The main way to set values is env vars or asking
                    // the agent to configure them.
                    values: hasValue
                        ? [displayValue, "(clear)"]
                        : ["(not set)"],
                };
            });

            return new SettingsList(
                fieldItems,
                Math.min(fieldItems.length + 2, 15),
                getSettingsListTheme(),
                (fieldId: string, newValue: string) => {
                    const prefix = `provider-field-${provider.id}-`;
                    const fieldName = fieldId.slice(prefix.length);

                    if (newValue === "(clear)") {
                        if (!state.notificationProviderConfigs[provider.id]) {
                            state.notificationProviderConfigs[provider.id] = {};
                        }
                        state.notificationProviderConfigs[provider.id][
                            fieldName
                        ] = "";
                        persistNotificationConfig(pi, state);
                        requestRebuild();
                    }
                    // "(not set)" is a no-op — nothing to change
                },
                () => {
                    submenuDone(undefined);
                }
            );
        },
    };
}

/** Mask all but the first and last characters of a secret. */
function maskSecret(value: string): string {
    if (value.length <= 4) return "••••";
    return `${value[0]}${"•".repeat(value.length - 2)}${value[value.length - 1]}`;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerNotifications(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("notifications", {
        description: "Configure notifications (providers, DnD, persistence)",
        handler: async (_args, ctx) => {
            if (!isFeatureEnabled(state, "notifications")) {
                ctx.ui.notify(
                    "Notifications are disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const systemDnd = await isSystemDndActive();

            await ctx.ui.custom((_tui, theme, _kb, done) => {
                let settingsList: SettingsList | undefined;

                const rebuildSettings = () => {
                    settingsList = new SettingsList(
                        buildSettingsItems(pi, state, () => rebuildSettings()),
                        15,
                        getSettingsListTheme(),
                        (id: string, newValue: string) => {
                            if (id === "notifications-persistent") {
                                state.notificationPersistent =
                                    newValue === "persistent";
                                persistNotificationConfig(pi, state);
                                return;
                            }

                            if (id === "notifications-respect-dnd") {
                                state.notificationRespectDnd =
                                    newValue === "enabled";
                                persistNotificationConfig(pi, state);
                                return;
                            }

                            // Provider toggle
                            const togglePrefix = "provider-toggle-";
                            if (id.startsWith(togglePrefix)) {
                                const providerId = id.slice(
                                    togglePrefix.length
                                );
                                if (newValue === "enabled") {
                                    state.enabledNotificationProviders.add(
                                        providerId
                                    );
                                } else {
                                    state.enabledNotificationProviders.delete(
                                        providerId
                                    );
                                }
                                persistNotificationConfig(pi, state);
                                // Rebuild to show/hide credential fields
                                rebuildSettings();
                                return;
                            }
                        },
                        () => {
                            done(undefined);
                        }
                    );
                };

                // Initial build
                rebuildSettings();

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

                container.addChild(
                    new (class {
                        render(width: number) {
                            return settingsList?.render(width) ?? [];
                        }
                        invalidate() {
                            settingsList?.invalidate();
                        }
                        handleInput(data: string) {
                            settingsList?.handleInput?.(data);
                        }
                    })()
                );

                return {
                    render(width: number) {
                        return container.render(width);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        settingsList?.handleInput?.(data);
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
    }[],
    title: string = "Pi"
): void {
    const body = lastAssistantText(messages);
    const notificationBody = body
        ? truncateNotificationBody(body)
        : "Ready for input";

    dispatch(
        state.enabledNotificationProviders,
        state.notificationProviderConfigs,
        {
            title,
            body: notificationBody,
            persistent: state.notificationPersistent,
        }
    );
}
