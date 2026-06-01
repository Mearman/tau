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

function makeState(overrides: Partial<PermissionState> = {}): PermissionState {
    return {
        mode: "allow",
        rules: [],
        additionalDirectories: new Set(),
        disableBypass: false,
        lastLoadedAt: Date.now(),
        sessionRules: [],
        askedCommands: new Set(),
        // Fast timeout for testing
        askTimeoutMs: 50,
        ...overrides,
    };
}

/** Mock ctx where the user never responds (promise hangs forever). */
function makeHangingCtx(): ExtensionContext {
    return {
        ui: {
            custom: async <T>(): Promise<T> => {
                return new Promise<T>(() => {}); // never resolves
            },
        },
    } as unknown as ExtensionContext;
}

/** Mock ctx where the user responds after a delay. */
function makeDelayedCtx(approve: boolean, delayMs: number): ExtensionContext {
    return {
        ui: {
            custom: async <T>(): Promise<T> => {
                await new Promise((r) => setTimeout(r, delayMs));
                return { approved: approve, feedback: "" } as T;
            },
        },
    } as unknown as ExtensionContext;
}

function makeBashEvent(command: string): ToolCallEvent {
    return {
        toolName: "bash",
        input: { command },
    } as ToolCallEvent;
}

const askNoVerify = {
    rule: "Bash(*--no-verify*)",
    behavior: "ask" as const,
    source: "userSettings" as const,
};

void describe("ask rule timeout", () => {
    void it("times out and rejects when the user does not respond", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeHangingCtx();
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, true);
        assert.match(
            result.reason ?? "",
            /timed out/i,
            "Reason should mention the timeout"
        );
    });

    void it("does not timeout when the user responds within the limit", async () => {
        const state = makeState({ rules: [askNoVerify] });
        // Respond after 10ms — well within the 50ms timeout
        const ctx = makeDelayedCtx(true, 10);
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });

    void it("waits indefinitely on retry (command in askedCommands)", async () => {
        const cmd = 'git commit --no-verify -m "test"';
        const state = makeState({
            rules: [askNoVerify],
            askedCommands: new Set([cmd]),
        });
        // User responds after 200ms — longer than the 50ms timeout,
        // but without a timeout this should succeed
        const ctx = makeDelayedCtx(true, 200);
        const event = makeBashEvent(cmd);

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(result.block, false);
    });

    void it("adds command to askedCommands on timeout", async () => {
        const cmd = 'git commit --no-verify -m "test"';
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeHangingCtx();
        const event = makeBashEvent(cmd);

        await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(state.askedCommands.has(cmd), true);
    });

    void it("removes command from askedCommands on approval", async () => {
        const cmd = 'git commit --no-verify -m "test"';
        const state = makeState({
            rules: [askNoVerify],
            askedCommands: new Set([cmd]),
        });
        const ctx = makeDelayedCtx(true, 10);
        const event = makeBashEvent(cmd);

        await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(state.askedCommands.has(cmd), false);
    });

    void it("removes command from askedCommands on rejection", async () => {
        const cmd = 'git commit --no-verify -m "test"';
        const state = makeState({
            rules: [askNoVerify],
            askedCommands: new Set([cmd]),
        });
        const ctx = makeDelayedCtx(false, 10);
        const event = makeBashEvent(cmd);

        await checkToolPermission(event, state, "/tmp", ctx);

        assert.equal(state.askedCommands.has(cmd), false);
    });

    void it("timeout message tells the model to retry if essential", async () => {
        const state = makeState({ rules: [askNoVerify] });
        const ctx = makeHangingCtx();
        const event = makeBashEvent('git commit --no-verify -m "test"');

        const result = await checkToolPermission(event, state, "/tmp", ctx);

        assert.match(
            result.reason ?? "",
            /retry.*essential|essential.*retry|essential.*wait indefinitely/i,
            "Reason should guide the model to retry if needed"
        );
    });
});
