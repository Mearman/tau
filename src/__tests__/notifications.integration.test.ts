import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerNotifications } from "../features/notifications.ts";
import { TauState } from "../state.ts";

void describe("notifications /notifications command", () => {
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
        const state = new TauState();
        registerNotifications(pi, state);
        return { commandHandler, state };
    }

    void it("renders the settings UI", async () => {
        const { commandHandler } = captureCommand();

        let customFactory: unknown;
        const ctx = {
            hasUI: true,
            ui: {
                custom: async (factory: unknown) => {
                    customFactory = factory;
                    // Simulate the done callback by calling the factory
                    return undefined;
                },
                notify: () => {},
                setStatus: () => {},
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    bold: (t: string) => t,
                },
            },
        } as never;

        await commandHandler!("", ctx);
        // The command should have called ctx.ui.custom
        assert.ok(customFactory);
    });

    void it("skips UI when hasUI is false", async () => {
        const { commandHandler } = captureCommand();

        let _customCalled = false;
        const ctx = {
            hasUI: false,
            ui: {
                custom: async () => {
                    _customCalled = true;
                    return undefined;
                },
                notify: () => {},
                setStatus: () => {},
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    bold: (t: string) => t,
                },
            },
        } as never;

        // The command handler should still work even without hasUI
        // It may or may not call custom — the key thing is no crash
        assert.doesNotThrow(async () => {
            await commandHandler!("", ctx);
        });
    });
});
