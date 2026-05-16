import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSummarize } from "../features/summarize.ts";

void describe("summarize /summarize command", () => {
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
        registerSummarize(pi);
        return { commandHandler };
    }

    void it("warns when no conversation text", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: true,
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
            sessionManager: {
                getBranch: () => [],
            },
        } as never;

        await commandHandler!("", ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("No conversation"))
        );
    });

    void it("warns when only system messages exist", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            hasUI: true,
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
            },
            sessionManager: {
                getBranch: () => [
                    {
                        type: "message",
                        message: { role: "system", content: "system prompt" },
                    },
                ],
            },
        } as never;

        await commandHandler!("", ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("No conversation"))
        );
    });
});
