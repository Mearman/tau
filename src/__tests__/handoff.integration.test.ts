import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerHandoff } from "../features/handoff.ts";

void describe("handoff /handoff command", () => {
    function captureCommand() {
        let commandHandler: ((...args: unknown[]) => unknown) | undefined;
        const pi = {
            registerCommand(
                _name: string,
                def: { handler: (...args: unknown[]) => unknown }
            ) {
                commandHandler = def.handler;
            },
        } as never;
        registerHandoff(pi);
        return { commandHandler };
    }

    void it("errors when no model selected", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: true,
            model: undefined,
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
        } as never;

        await commandHandler!("some goal", ctx);
        assert.ok(notifications.some((n) => n.message.includes("No model")));
    });

    void it("errors with empty goal", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: true,
            model: { provider: "openai", id: "gpt-4" },
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
        } as never;

        await commandHandler!("  ", ctx);
        assert.ok(notifications.some((n) => n.message.includes("Usage")));
    });

    void it("errors when no conversation", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: true,
            model: { provider: "openai", id: "gpt-4" },
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
            sessionManager: {
                getBranch: () => [],
            },
        } as never;

        await commandHandler!("fix the bug", ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("No conversation"))
        );
    });

    void it("errors in non-interactive mode", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: false,
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
        } as never;

        await commandHandler!("goal", ctx);
        assert.ok(notifications.some((n) => n.message.includes("interactive")));
    });
});
