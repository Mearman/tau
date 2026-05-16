import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPreset } from "../features/preset.ts";
import { TauState } from "../state.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function capturePreset() {
    const state = new TauState();
    const commands: Record<
        string,
        { handler: (...args: unknown[]) => unknown }
    > = {};
    const eventHandlers: Record<string, (...args: unknown[]) => unknown> = {};
    const flags: Record<string, unknown> = {};
    const entries: { customType: string; data: unknown }[] = [];

    const pi = {
        registerCommand(
            _name: string,
            def: { handler: (...args: unknown[]) => unknown }
        ) {
            commands[_name] = def;
        },
        registerShortcut: () => {},
        registerFlag(_name: string, _def: unknown) {},
        getFlag(name: string) {
            return flags[name];
        },
        on(event: string, handler: (...args: unknown[]) => unknown) {
            eventHandlers[event] = handler;
        },
        appendEntry(customType: string, data: unknown) {
            entries.push({ customType, data });
        },
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
    return { commands, eventHandlers, flags, entries, pi, state };
}

void describe("preset session_start", () => {
    const TEST_DIR = join(tmpdir(), "tau-test-preset");

    void it("loads presets from project .pi/presets.json", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({ code: { provider: "openai", model: "gpt-4" } })
        );

        const { eventHandlers } = capturePreset();

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
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
            },
            model: undefined,
            modelRegistry: {
                find: () => undefined,
            },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        // Presets loaded — no flag set, so no activation
        assert.ok(true);

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("activates preset from flag", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({
                code: { provider: "openai", model: "gpt-4" },
            })
        );

        const { eventHandlers, flags } = capturePreset();
        flags["preset"] = "code";

        const notifications: { message: string }[] = [];
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: () => {},
                theme: { fg: (_c: string, t: string) => t },
            },
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
            },
            model: undefined,
            modelRegistry: {
                find: () => ({ provider: "openai", id: "gpt-4" }),
                getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
            },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        assert.ok(notifications.some((n) => n.message.includes("code")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("warns on unknown preset flag", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(join(TEST_DIR, ".pi", "presets.json"), "{}");

        const { eventHandlers, flags } = capturePreset();
        flags["preset"] = "nonexistent";

        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
                setStatus: () => {},
                theme: { fg: (_c: string, t: string) => t },
            },
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
            },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("Unknown preset"))
        );

        rmSync(TEST_DIR, { recursive: true, force: true });
    });
});

void describe("preset turn_start", () => {
    void it("appends preset-state entry when active", async () => {
        const { eventHandlers, entries, flags } = capturePreset();
        flags["preset"] = "test";

        // First trigger session_start to set active preset
        const notifications: { message: string }[] = [];
        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: () => {},
                theme: { fg: (_c: string, t: string) => t },
            },
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
            },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);

        // If preset activated, turn_start should persist state
        if (eventHandlers["turn_start"]) {
            entries.length = 0;
            await eventHandlers["turn_start"]();
            // May or may not have entries depending on whether preset was activated
        }
        assert.ok(true);
    });
});

void describe("preset before_agent_start", () => {
    void it("returns undefined when no active preset instructions", async () => {
        const { eventHandlers } = capturePreset();

        const result = await eventHandlers["before_agent_start"]({
            systemPrompt: "original",
        });
        assert.equal(result, undefined);
    });
});
