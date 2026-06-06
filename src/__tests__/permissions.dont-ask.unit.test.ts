import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    checkToolPermission,
    type PermissionState,
} from "../features/permissions/index.ts";
import type {
    ToolCallEvent,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Build a minimal PermissionState for testing. */
function makeState(overrides: Partial<PermissionState> = {}): PermissionState {
    return {
        mode: "dontAsk",
        rules: [],
        additionalDirectories: new Set(),
        disableBypass: false,
        lastLoadedAt: Date.now(),
        sessionRules: [],
        askedCommands: new Set(),
        ...overrides,
    };
}

/** Build a bash tool_call event. */
function makeBashEvent(command: string): ToolCallEvent {
    return {
        toolName: "bash",
        input: { command },
    } as ToolCallEvent;
}

/** Build an edit tool_call event. */
function makeEditEvent(path: string): ToolCallEvent {
    return {
        toolName: "edit",
        input: { path },
    } as ToolCallEvent;
}

/** Build a mock ExtensionContext — should never be called in dontAsk mode. */
function makeCtx(): ExtensionContext {
    return {
        ui: {
            custom: async () => {
                // dontAsk mode should never prompt the user
                throw new Error("dontAsk mode must not prompt the user");
            },
        },
    } as unknown as ExtensionContext;
}

void describe("checkToolPermission — dontAsk mode", () => {
    const askNoVerify = {
        rule: "Bash(git *--no-verify*)",
        behavior: "ask" as const,
        source: "userSettings" as const,
    };

    const denyForcePush = {
        rule: "Bash(git push *--force*)",
        behavior: "deny" as const,
        source: "userSettings" as const,
    };

    const allowGitStatus = {
        rule: "Bash(git status:*)",
        behavior: "allow" as const,
        source: "userSettings" as const,
    };

    void it("blocks git push --no-verify without prompting", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeCtx();
        const event = makeBashEvent("git push --no-verify");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.ok(result.reason?.includes("dontAsk"));
    });

    void it("blocks git commit --no-verify without prompting", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeCtx();
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.ok(result.reason?.includes("dontAsk"));
    });

    void it("still enforces deny rules", async () => {
        const state = makeState({ rules: [denyForcePush] });
        const ctx = makeCtx();
        const event = makeBashEvent("git push --force-with-lease");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.ok(result.reason?.includes("denied by rule"));
    });

    void it("auto-approves commands matching an allow rule", async () => {
        const state = makeState({ rules: [allowGitStatus] });
        const ctx = makeCtx();
        const event = makeBashEvent("git status --short");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });

    void it("auto-approves commands with no matching rules and a matching allow rule", async () => {
        const state = makeState({ rules: [allowGitStatus] });
        const ctx = makeCtx();
        const event = makeBashEvent("git status");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });

    void it("blocks unmatched commands that would need a prompt", async () => {
        const state = makeState({ rules: [] });
        const ctx = makeCtx();
        const event = makeBashEvent("rm -rf /tmp/something");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.ok(result.reason?.includes("dontAsk"));
    });

    void it("blocks file edits that would need a prompt", async () => {
        const state = makeState({ rules: [] });
        const ctx = makeCtx();
        const event = makeEditEvent("/tmp/test.ts");

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.ok(result.reason?.includes("dontAsk"));
    });
});
