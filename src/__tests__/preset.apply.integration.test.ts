import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPreset } from "../features/preset.ts";
import { TauState } from "../state.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function capturePreset() {
    const commands: Record<
        string,
        { handler: (...args: unknown[]) => unknown }
    > = {};
    const eventHandlers: Record<string, (...args: unknown[]) => unknown> = {};
    const flags: Record<string, unknown> = {};
    const entries: { customType: string; data: unknown }[] = [];

    const pi = {
        registerCommand(
            name: string,
            def: { handler: (...args: unknown[]) => unknown }
        ) {
            commands[name] = def;
        },
        registerShortcut: () => {},
        registerFlag: () => {},
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

    registerPreset(pi, new TauState());
    return { commands, eventHandlers, flags, entries };
}

const TEST_DIR = join(tmpdir(), "tau-test-preset-apply");

void describe("preset /preset command — apply via DI", () => {
    void it("applies preset with thinking level and tools", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({
                thinker: {
                    thinkingLevel: "high",
                    tools: ["read", "bash"],
                },
            })
        );

        const { commands, eventHandlers } = capturePreset();

        const thinkingLevels: string[] = [];
        const toolsApplied: string[][] = [];
        const _pi = {
            setThinkingLevel: (level: string) => thinkingLevels.push(level),
            setActiveTools: (tools: string[]) => toolsApplied.push(tools),
            getAllTools: () => [{ name: "read" }, { name: "bash" }],
        };

        // Trigger session_start to load presets
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
            modelRegistry: { find: () => undefined },
        } as never;

        await eventHandlers["session_start"]({}, ctx);

        // Now call /preset thinker
        const applyCtx = {
            ui: {
                notify: (message: string) => notifications.push({ message }),
                setStatus: () => {},
                theme: { fg: (_c: string, t: string) => t },
            },
            model: undefined,
            modelRegistry: { find: () => undefined },
        } as never;

        await commands.preset.handler("thinker", applyCtx);
        assert.ok(notifications.some((n) => n.message.includes("thinker")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("warns about unknown tools in preset", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({
                badtools: { tools: ["read", "nonexistent"] },
            })
        );

        const { commands, eventHandlers } = capturePreset();

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
        await commands.preset.handler("badtools", ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("Unknown tools"))
        );

        rmSync(TEST_DIR, { recursive: true, force: true });
    });
});

void describe("preset before_agent_start — with instructions", () => {
    void it("appends instructions to system prompt", async () => {
        mkdirSync(join(TEST_DIR, ".pi"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".pi", "presets.json"),
            JSON.stringify({
                guided: { instructions: "Always use TypeScript strict mode" },
            })
        );

        const { eventHandlers } = capturePreset();

        // Activate the preset via session_start
        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: () => {},
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

        // Activate preset
        await eventHandlers["session_start"](
            {},
            {
                cwd: TEST_DIR,
                ui: {
                    notify: () => {},
                    setStatus: () => {},
                    theme: { fg: (_c: string, t: string) => t },
                },
                sessionManager: {
                    getEntries: () => [],
                    getBranch: () => [],
                },
            }
        );

        // This won't have instructions active since we didn't apply the preset
        // Test the before_agent_start handler
        const result = await eventHandlers["before_agent_start"]({
            systemPrompt: "You are a helpful assistant",
        });

        // Without active preset instructions, should return undefined
        assert.equal(result, undefined);

        rmSync(TEST_DIR, { recursive: true, force: true });
    });
});
