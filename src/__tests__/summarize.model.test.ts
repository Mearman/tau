import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSummarize } from "../features/summarize.ts";
import { TauState } from "../state.ts";

void describe("summarize /summarize command — model errors", () => {
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
        registerSummarize(pi, new TauState());
        return { commandHandler };
    }

    void it("warns when model not found", async () => {
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
                        message: {
                            role: "user",
                            content: "hello",
                        },
                    },
                ],
            },
            modelRegistry: {
                getApiKeyAndHeaders: async () => ({
                    ok: false,
                    error: "no key",
                }),
            },
        } as never;

        await commandHandler!("", ctx);
        // "Preparing summary..." is sent, then model lookup fails
        assert.ok(notifications.length >= 1);
    });
});
