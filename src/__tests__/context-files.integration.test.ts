import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { registerContextFiles } from "../features/context-files.ts";
import { TauState } from "../state.ts";

void describe("context-files register + events", () => {
    const testDir = path.join(tmpdir(), "tau-test-context-files-reg");

    beforeEach(() => {
        fs.mkdirSync(path.join(testDir, ".agents", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testDir, ".claude", "rules"), {
            recursive: true,
        });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    void it("registers session_start and before_agent_start handlers", () => {
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());
        assert.ok(handlers["session_start"]);
        assert.ok(handlers["before_agent_start"]);
    });

    void it("session_start notifies when context files found", async () => {
        fs.writeFileSync(
            path.join(testDir, "AGENTS.md"),
            "# Project instructions"
        );
        fs.writeFileSync(
            path.join(testDir, ".agents", "rules", "style.md"),
            "Use tabs"
        );
        fs.writeFileSync(path.join(testDir, "CLAUDE.local.md"), "# Local");

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const notifications: { message: string; level: string }[] = [];
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());

        const ctx = {
            cwd: testDir,
            ui: {
                notify: (message: string, level: string) => {
                    notifications.push({ message, level });
                },
            },
        } as never;

        await handlers["session_start"]({}, ctx);
        assert.ok(
            notifications.some((n) => n.message.includes("3 context file")),
            `Expected 3 context files in notification, got: ${JSON.stringify(notifications)}`
        );
    });

    void it("before_agent_start adds context to system prompt", async () => {
        fs.writeFileSync(
            path.join(testDir, "AGENTS.md"),
            "# Root instructions\nAlways use TypeScript"
        );
        fs.writeFileSync(
            path.join(testDir, ".claude", "rules", "naming.md"),
            "Use camelCase"
        );

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());

        // Trigger session_start
        const sessionCtx = {
            cwd: testDir,
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        // Trigger before_agent_start
        const result = (await handlers["before_agent_start"](
            { systemPrompt: "Original prompt" },
            {}
        )) as { systemPrompt: string } | undefined;

        assert.ok(result);
        assert.ok(result.systemPrompt.includes("Original prompt"));
        assert.ok(result.systemPrompt.includes("Always use TypeScript"));
        assert.ok(result.systemPrompt.includes("Use camelCase"));
        assert.ok(result.systemPrompt.includes("<project_instructions"));
    });

    void it("before_agent_start returns nothing when no context files", async () => {
        // Empty test dir with no .md files
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());

        const sessionCtx = {
            cwd: testDir,
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        const result = await handlers["before_agent_start"](
            { systemPrompt: "Original" },
            {}
        );
        assert.equal(result, undefined);
    });

    void it("includes @include resolved files in prompt", async () => {
        fs.mkdirSync(path.join(testDir, "shared"), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, "shared", "base.md"),
            "Base config: use pnpm"
        );
        fs.writeFileSync(
            path.join(testDir, "AGENTS.md"),
            "# Root\n@include @./shared/base.md"
        );

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());

        const sessionCtx = {
            cwd: testDir,
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        const result = (await handlers["before_agent_start"](
            { systemPrompt: "Base" },
            {}
        )) as { systemPrompt: string } | undefined;

        assert.ok(result);
        assert.ok(result.systemPrompt.includes("use pnpm"));
    });

    void it("strips HTML comments from prompt content", async () => {
        fs.writeFileSync(
            path.join(testDir, "AGENTS.md"),
            "# Instructions\n<!-- internal note -->\nReal content"
        );

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerContextFiles(pi, new TauState());

        const sessionCtx = {
            cwd: testDir,
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        const result = (await handlers["before_agent_start"](
            { systemPrompt: "Base" },
            {}
        )) as { systemPrompt: string } | undefined;

        assert.ok(result);
        assert.ok(!result.systemPrompt.includes("internal note"));
        assert.ok(result.systemPrompt.includes("Real content"));
    });
});
