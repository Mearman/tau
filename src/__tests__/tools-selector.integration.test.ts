import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerToolsSelector } from "../features/tools-selector.ts";
import { TauState } from "../state.ts";

void describe("tools-selector /tools command", () => {
    function captureCommand() {
        let commandHandler: ((...args: unknown[]) => unknown) | undefined;
        const state = new TauState();
        state.enabledTools = new Set(["read", "bash"]);
        state.allTools = [
            { name: "read", description: "read", parameters: {} },
            { name: "bash", description: "bash", parameters: {} },
            { name: "edit", description: "edit", parameters: {} },
            { name: "write", description: "write", parameters: {} },
        ] as never;

        const pi = {
            registerCommand(
                _name: string,
                def: { handler: (...args: unknown[]) => unknown }
            ) {
                commandHandler = def.handler;
            },
            getAllTools: () => state.allTools,
            getActiveTools: () => [...state.enabledTools],
            setActiveTools: (tools: string[]) => {
                state.enabledTools = new Set(tools);
            },
            appendEntry: () => {},
        } as never;

        registerToolsSelector(pi, state);
        return { commandHandler, state, pi };
    }

    void it("renders tools settings UI", async () => {
        const { commandHandler } = captureCommand();

        let customCalled = false;
        const ctx = {
            ui: {
                custom: async () => {
                    customCalled = true;
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
        assert.ok(customCalled);
    });
});
