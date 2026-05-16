import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerHandoff } from "../features/handoff.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

void describe("handoff /handoff command — with conversation", () => {
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

    void it("generates handoff when model and conversation present", async () => {
        const { commandHandler } = captureCommand();
        const notifications: { message: string; level: string }[] = [];
        let customCalled = false;

        const ctx = {
            hasUI: true,
            model: { provider: "openai", id: "gpt-4" },
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
                custom: async <T>(_factory: unknown): Promise<T> => {
                    customCalled = true;
                    // The factory creates a loader and generates a prompt.
                    // We can't fully exercise it without a real LLM, but
                    // calling it exercises the handler path up to the LLM call.
                    return null as T;
                },
                editor: async () => "edited prompt",
            },
            sessionManager: {
                getBranch: () => [
                    {
                        type: "message",
                        id: "e1",
                        parentId: "p1",
                        timestamp: new Date(0).toISOString(),
                        message: {
                            role: "user",
                            content: "fix the bug",
                            timestamp: 0,
                        },
                    } as SessionEntry,
                    {
                        type: "message",
                        id: "e2",
                        parentId: "p1",
                        timestamp: new Date(0).toISOString(),
                        message: {
                            role: "assistant",
                            content: [
                                { type: "text", text: "I found the bug" },
                            ],
                            timestamp: 1,
                        },
                    } as SessionEntry,
                ],
                getSessionFile: () => "/tmp/test-session.json",
            },
            modelRegistry: {
                getApiKeyAndHeaders: async () => ({
                    ok: true,
                    apiKey: "test-key",
                    headers: {},
                }),
            },
            newSession: async () => ({ cancelled: true }),
        } as never;

        await commandHandler!("fix the remaining issues", ctx);
        // The handler should have triggered custom UI
        assert.ok(customCalled);
    });
});
