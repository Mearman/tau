/**
 * Tests for the loop's tick-firing behavior — verifying that ticks
 * trigger a new turn when the agent is idle and queue as a follow-up
 * when the agent is busy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Mock pi ────────────────────────────────────────────────────────

interface MockPi {
    commands: Map<
        string,
        {
            description: string;
            handler: (...args: unknown[]) => Promise<void>;
        }
    >;
    events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
    sentMessages: Array<{ text: string; options?: unknown }>;
    registerCommand: (
        name: string,
        options: {
            description: string;
            handler: (...args: unknown[]) => Promise<void>;
        }
    ) => void;
    on: (
        event: string,
        handler: (event: unknown, ctx: unknown) => unknown
    ) => void;
    sendUserMessage: (text: string, options?: unknown) => void;
    registerShortcut: (
        key: string,
        options: {
            description?: string;
            handler: (ctx: unknown) => Promise<void> | void;
        }
    ) => void;
}

function createMockPi(): MockPi {
    const commands = new Map<
        string,
        {
            description: string;
            handler: (...args: unknown[]) => Promise<void>;
        }
    >();
    const events = new Map<
        string,
        Array<(event: unknown, ctx: unknown) => unknown>
    >();
    const sentMessages: MockPi["sentMessages"] = [];

    return {
        commands,
        events,
        sentMessages,
        registerCommand(name, options) {
            commands.set(name, options);
        },
        on(event, handler) {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        },
        sendUserMessage(text, options?) {
            sentMessages.push({ text, options });
        },
        registerShortcut(_key, _options) {
            // No-op for tests
        },
    };
}

function asApi(pi: MockPi): ExtensionAPI {
    return pi as unknown as ExtensionAPI;
}

function getCommandHandler(pi: MockPi, name: string) {
    const cmd = pi.commands.get(name);
    assert.ok(cmd, `command ${name} should be registered`);
    return cmd.handler;
}

async function getEventHandler(
    pi: MockPi,
    event: string,
    index = 0
): Promise<(event: unknown, ctx: unknown) => unknown> {
    const handlers = pi.events.get(event);
    assert.ok(handlers, `${event} handlers should be registered`);
    assert.ok(
        handlers.length > index,
        `${event} needs at least ${index + 1} handlers`
    );
    return handlers[index];
}

function makeAgentEndEvent(assistantText: string) {
    return {
        messages: [
            {
                role: "assistant",
                content: [{ type: "text", text: assistantText }],
                stopReason: "stop",
            },
        ],
    };
}

const noopCtx = {
    ui: {
        notify: (_msg: string, _level?: string) => {},
    },
} as unknown;

// ─── Tests ──────────────────────────────────────────────────────────

void describe("loop tick behaviour", () => {
    void it("sends the first count tick without deliverAs when agent is idle", async () => {
        const mod = await import("../features/loop.ts");
        const pi = createMockPi();
        mod.registerLoop(asApi(pi), {} as never);

        const handler = getCommandHandler(pi, "loop");
        await handler("1 do something", noopCtx);

        // The first tick is fired via setTimeout(0) inside startLoop. Wait
        // for it before asserting.
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(pi.sentMessages.length, 1);
        const first = pi.sentMessages[0];
        assert.equal(
            first.options,
            undefined,
            "idle ticks must not pass deliverAs so the SDK triggers a new turn"
        );
        assert.ok(
            first.text.includes("<tick>"),
            "tick message should include tick tag"
        );
        assert.ok(
            first.text.includes("do something"),
            "tick message should include the loop prompt"
        );

        // Clean up: stop all loops so setInterval/setTimeout timers don't
        // keep the process alive after the test.
        await handler("stop", noopCtx);
    });

    void it("sends the first interval tick without deliverAs when agent is idle", async () => {
        const mod = await import("../features/loop.ts");
        const pi = createMockPi();
        mod.registerLoop(asApi(pi), {} as never);

        const handler = getCommandHandler(pi, "loop");
        await handler("5m check the deploy", noopCtx);

        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(pi.sentMessages.length, 1);
        const first = pi.sentMessages[0];
        assert.equal(first.options, undefined);
        assert.ok(first.text.includes("check the deploy"));

        await handler("stop", noopCtx);
    });

    void it("sends the first infinite tick without deliverAs when fired after agent_end", async () => {
        // For infinite loops, the tick is queued inside the agent_end handler
        // and fired 500ms later via setTimeout. By that point the agent is
        // idle, so the tick should trigger a new turn.
        const mod = await import("../features/loop.ts");
        const pi = createMockPi();
        mod.registerLoop(asApi(pi), {} as never);

        const handler = getCommandHandler(pi, "loop");
        await handler("do something", noopCtx);

        // For infinite mode, no tick is fired from startLoop. The first tick
        // comes from the second agent_end handler (the first one just tracks
        // the agent's idle state).
        const agentEndHandler = await getEventHandler(pi, "agent_end", 1);
        await agentEndHandler(makeAgentEndEvent("working on it"), {
            hasPendingMessages: () => false,
        });

        // The pending tick fires after TICK_DELAY_MS (500ms). Wait
        // long enough for the setTimeout(0) inside the agent_end handler
        // to mark the agent as idle, then for TICK_DELAY_MS to elapse.
        await new Promise((resolve) => setTimeout(resolve, 700));

        assert.equal(pi.sentMessages.length, 1);
        const only = pi.sentMessages[0];
        assert.equal(
            only.options,
            undefined,
            "post-agent-end infinite tick should not pass deliverAs (agent is idle)"
        );

        await handler("stop", noopCtx);
    });
});
