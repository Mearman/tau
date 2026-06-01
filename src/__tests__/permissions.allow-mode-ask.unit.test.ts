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
        mode: "allow",
        rules: [],
        additionalDirectories: new Set(),
        disableBypass: false,
        lastLoadedAt: Date.now(),
        sessionRules: [],
        ...overrides,
    };
}

/** Build a mock ExtensionContext that auto-approves or auto-rejects prompts. */
function makeCtx(approve: boolean): ExtensionContext {
    return {
        ui: {
            custom: async <T>(): Promise<T> => {
                return {
                    approved: approve,
                    feedback: "",
                } as T;
            },
        },
    } as unknown as ExtensionContext;
}

/** Build a bash tool_call event. */
function makeBashEvent(command: string): ToolCallEvent {
    return {
        toolName: "bash",
        input: { command },
    } as ToolCallEvent;
}

void describe("checkToolPermission — ask rules in allow mode", () => {
    // Pattern that matches --no-verify anywhere in the command
    const askNoVerify = {
        rule: "Bash(*--no-verify*)",
        behavior: "ask" as const,
        source: "userSettings" as const,
    };

    void it("prompts for a bash command matching an ask rule even in allow mode", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeCtx(false); // reject the prompt
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
    });

    void it("auto-approves a command that does not match any ask rule", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeCtx(false);
        const event = makeBashEvent('git commit -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });

    void it("allows the command when the ask prompt is approved", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeCtx(true); // approve the prompt
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });
});
