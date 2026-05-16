import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerClaudeRules } from "../features/claude-rules.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

void describe("claude-rules register + events", () => {
    const TEST_DIR = join(tmpdir(), "tau-test-claude-rules-reg");

    void it("registers session_start and before_agent_start handlers", () => {
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerClaudeRules(pi);
        assert.ok(handlers["session_start"]);
        assert.ok(handlers["before_agent_start"]);
    });

    void it("session_start notifies when rules found", async () => {
        mkdirSync(join(TEST_DIR, ".claude", "rules"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".claude", "rules", "test.md"),
            "# Test Rule"
        );

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const notifications: { message: string; level: string }[] = [];
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerClaudeRules(pi);

        const ctx = {
            cwd: TEST_DIR,
            ui: {
                notify: (message: string, level: string) => {
                    notifications.push({ message, level });
                },
            },
        } as never;

        await handlers["session_start"]({}, ctx);
        assert.ok(notifications.some((n) => n.message.includes("1 rule")));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("before_agent_start adds rules to system prompt", async () => {
        mkdirSync(join(TEST_DIR, ".claude", "rules"), { recursive: true });
        writeFileSync(
            join(TEST_DIR, ".claude", "rules", "naming.md"),
            "Use camelCase"
        );

        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerClaudeRules(pi);

        // First trigger session_start to load rules
        const sessionCtx = {
            cwd: TEST_DIR,
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        // Then trigger before_agent_start
        const result = (await handlers["before_agent_start"](
            { systemPrompt: "Original prompt" },
            {}
        )) as { systemPrompt: string } | undefined;
        assert.ok(result);
        assert.ok(result.systemPrompt.includes("Project Rules"));
        assert.ok(result.systemPrompt.includes("naming.md"));

        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    void it("before_agent_start returns nothing when no rules", async () => {
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                handlers[event] = handler;
            },
        } as never;

        registerClaudeRules(pi);

        // Trigger session_start with a dir that has no .claude/rules
        const sessionCtx = {
            cwd: "/nonexistent",
            ui: { notify: () => {} },
        } as never;
        await handlers["session_start"]({}, sessionCtx);

        const result = await handlers["before_agent_start"](
            { systemPrompt: "Original" },
            {}
        );
        // No rules → should return undefined or no systemPrompt modification
        assert.equal(result, undefined);
    });
});
