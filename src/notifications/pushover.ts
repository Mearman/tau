/**
 * Pushover notification provider.
 *
 * Sends notifications via the Pushover REST API.
 * Supports persistent (priority 2, emergency) notifications that require
 * acknowledgement, and normal (priority 0) notifications.
 *
 * Credentials are resolved in order:
 * 1. Environment variables (PUSHOVER_USER_KEY, PUSHOVER_APP_TOKEN)
 * 2. Stored config from session entries
 *
 * @see https://pushover.net/api
 */

import type { NotificationProvider, NotificationRequest } from "./types.ts";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export const pushoverProvider: NotificationProvider = {
    id: "pushover",
    label: "Pushover",
    fields: [
        {
            name: "userKey",
            label: "User Key",
            required: true,
            hint: "Set PUSHOVER_USER_KEY env var, or ask the agent to configure",
            envVar: "PUSHOVER_USER_KEY",
        },
        {
            name: "appToken",
            label: "App Token",
            required: true,
            hint: "Set PUSHOVER_APP_TOKEN env var, or ask the agent to configure",
            envVar: "PUSHOVER_APP_TOKEN",
        },
    ],

    resolveConfig(
        storedConfig: Record<string, string>
    ): Record<string, string> {
        const resolved: Record<string, string> = {};
        for (const field of pushoverProvider.fields) {
            const envVal = field.envVar ? process.env[field.envVar] : undefined;
            resolved[field.name] = envVal || storedConfig[field.name] || "";
        }
        return resolved;
    },

    isConfigured(config: Record<string, string>): boolean {
        return config["userKey"] !== "" && config["appToken"] !== "";
    },

    send(request: NotificationRequest, config: Record<string, string>): void {
        const { title, body, persistent } = request;

        const payload = new URLSearchParams({
            user: config["userKey"] ?? "",
            token: config["appToken"] ?? "",
            message: body,
            title,
            // Priority 0 = normal, 2 = emergency (requires acknowledgement)
            priority: persistent ? "2" : "0",
        });

        // Emergency notifications require retry/expire parameters
        if (persistent) {
            // Retry every 60 seconds until acknowledged
            payload.set("retry", "60");
            // Expire after 1 hour if not acknowledged
            payload.set("expire", "3600");
        }

        fetch(PUSHOVER_API_URL, {
            method: "POST",
            body: payload,
        }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[tau] Pushover notification failed: ${message}`);
        });
    },
};
