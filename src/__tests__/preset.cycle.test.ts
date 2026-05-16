import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPreset } from "../features/preset.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function capturePreset() {
    const commands: Record<
        string,
        { handler: (...args: unknown[]) => unknown }
    > = {};
    const shortcuts: {
        key: string;
        handler: (...args: unknown[]) => unknown;
    }[] = [];
    const eventHandlers: Record<string, (...args: unknown[]) => unknown> = {};
    const flags: Record<string, unknown> = {};

    const pi = {
        registerCommand(
            name: string,
            def: { handler: (...args: unknown[]) => unknown }
        ) {
            commands[name] = def;
        },
        registerShortcut(
            key: string,
            def: { handler: (...args: unknown[]) => unknown }
        ) {
            shortcuts.push({ key, handler: def.handler });
        },
        registerFlag: () => {},
        getFlag(name: string) {
            return flags[name];
        },
        on(event: string, handler: (...args: unknown[]) => unknown) {
            eventHandlers[event] = handler;
        },
        appendEntry: () => {},
        setActiveTools: () => {},
        getActiveTools: () => ["read", "bash", "edit", "write"],
        getAllTools: () => [
            { name: "read" },
            { name: "bash" },
            { name: "edit" },
            { name: "write" },
        ],
        setThinkingLevel: () => {},
        getThinkingLevel: () => "off",
        async setModel() {
            return true;
        },
        sendMessage: () => {},
    } as never;

    registerPreset(pi);
    return { commands, shortcuts, eventHandlers, flags, pi };
}

const TEST_DIR = join(tmpdir(), "tau-test-preset-cycle");

void describe("preset cyclePreset", () => {
    void it("cycles through presets and back to none", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({ fast: { thinkingLevel: "low" } })
        );

        const { shortcuts, eventHandlers } = capturePreset();

        const notifications: { message: string }[] = [];
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: { fg: (_c: string, t: string) => t },
            },
            sessionManager: { getEntries: () => [], getBranch: () => [] },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        // Load presets
        await eventHandlers["session_start"]({}, ctx);

        // Cycle to first preset
        const cycleHandler = shortcuts.find((s) => s.key === "ctrl+shift+u");
        assert.ok(cycleHandler);
        await cycleHandler.handler(ctx);
        assert.ok(notifications.some((n) => n.message.includes("fast")));

        // Cycle to (none)
        await cycleHandler.handler(ctx);
        assert.ok(notifications.some((n) => n.message.includes("cleared")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });
});

void describe("preset showPresetSelector", () => {
    void it("opens selector UI when no args given and presets exist", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({ dev: { provider: "openai", model: "gpt-4" } })
        );

        const { commands, eventHandlers } = capturePreset();

        let customCalled = false;
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: () => {},
                setStatus: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    bold: (t: string) => t,
                },
                custom: async () => {
                    customCalled = true;
                    return null;
                },
            },
            sessionManager: { getEntries: () => [], getBranch: () => [] },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        await commands.preset.handler("", ctx);
        assert.ok(customCalled);

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("selects (none) in selector to clear preset", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({ dev: { thinkingLevel: "high" } })
        );

        const { commands, eventHandlers } = capturePreset();

        const notifications: { message: string }[] = [];
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: {
                    fg: (_c: string, t: string) => t,
                    bold: (t: string) => t,
                },
                custom: async () => "(none)",
            },
            sessionManager: { getEntries: () => [], getBranch: () => [] },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        await commands.preset.handler("", ctx);
        assert.ok(notifications.some((n) => n.message.includes("cleared")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("selects a preset in selector", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({ dev: { thinkingLevel: "high" } })
        );

        const { commands, eventHandlers } = capturePreset();

        const notifications: { message: string }[] = [];
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: {
                    fg: (_c: string, t: string) => t,
                    bold: (t: string) => t,
                },
                custom: async () => "dev",
            },
            sessionManager: { getEntries: () => [], getBranch: () => [] },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        await commands.preset.handler("", ctx);
        assert.ok(notifications.some((n) => n.message.includes("dev")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });
});
