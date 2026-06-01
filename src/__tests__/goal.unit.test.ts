import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { GoalState } from "../types.ts";

// ─── Mock pi ────────────────────────────────────────────────────────

interface MockPi {
    commands: Map<
        string,
        { description: string; handler: (...args: unknown[]) => Promise<void> }
    >;
    events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
    entries: Array<{ type: string; customType: string; data: unknown }>;
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
    appendEntry: (customType: string, data: unknown) => void;
    sendUserMessage: (text: string, options?: unknown) => void;
}

function createMockPi(): MockPi {
    const commands = new Map<
        string,
        { description: string; handler: (...args: unknown[]) => Promise<void> }
    >();
    const events = new Map<
        string,
        Array<(event: unknown, ctx: unknown) => unknown>
    >();
    const entries: MockPi["entries"] = [];
    const sentMessages: MockPi["sentMessages"] = [];

    return {
        commands,
        events,
        entries,
        sentMessages,
        registerCommand(name, options) {
            commands.set(name, options);
        },
        on(event, handler) {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        },
        appendEntry(customType, data) {
            entries.push({ type: "custom", customType, data });
        },
        sendUserMessage(text, options?) {
            sentMessages.push({ text, options });
        },
    };
}

function asApi(pi: MockPi): ExtensionAPI {
    return pi as unknown as ExtensionAPI;
}

// ─── Mock context ───────────────────────────────────────────────────

function createMockCtx(hasUI: boolean = true, idle: boolean = true) {
    return {
        hasUI,
        isIdle: () => idle,
        cwd: "/tmp/test",
        ui: {
            notify: (_msg: string, _level?: string) => {},
            setStatus: (_name: string, _content: unknown) => {},
            theme: { fg: (_c: string, t: string) => t },
        },
        sessionManager: {
            getEntries: () => [],
            getSessionId: () => "test-session",
        },
    } as unknown;
}

// ─── Helpers ────────────────────────────────────────────────────────

function createState(goal?: GoalState): TauState {
    return { activeGoal: goal } as unknown as TauState;
}

function nn<T>(value: T | undefined | null, msg?: string): T {
    assert.ok(value, msg);
    return value;
}

function getNotificationsCtx(createArgs?: { hasUI?: boolean; idle?: boolean }) {
    const notifications: string[] = [];
    const ctx = createMockCtx(
        createArgs?.hasUI ?? true,
        createArgs?.idle ?? true
    );
    (ctx.ui as { notify: (msg: string, level?: string) => void }).notify = (
        msg: string
    ) => {
        notifications.push(msg);
    };
    return { ctx, notifications };
}

async function getEventHandler(
    pi: MockPi,
    event: string
): Promise<(event: unknown, ctx: unknown) => unknown> {
    const handlers = nn(pi.events.get(event), `${event} handlers should exist`);
    assert.ok(handlers.length > 0, `${event} should have at least one handler`);
    return handlers[0];
}

// ─── Tests ──────────────────────────────────────────────────────────

void describe("goal feature", () => {
    void it("exports registerGoal function", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(typeof mod.registerGoal, "function");
    });

    void it("registerGoal registers the /goal command", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState();
        mod.registerGoal(asApi(pi), state);

        assert.ok(pi.commands.has("goal"));
    });

    void it("registerGoal subscribes to session_start, before_agent_start, and turn_end", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState();
        mod.registerGoal(asApi(pi), state);

        assert.ok(pi.events.has("session_start"));
        assert.ok(pi.events.has("before_agent_start"));
        assert.ok(pi.events.has("turn_end"));
    });

    void it("/goal with no args shows 'No goal set' when no goal active", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("", ctx);

        assert.ok(notifications.some((n) => n.includes("No goal set")));
    });

    void it("/goal <condition> sets the goal and notifies", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState();
        mod.registerGoal(asApi(pi), state);

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("all tests pass", ctx);

        assert.ok(state.activeGoal);
        assert.equal(state.activeGoal.condition, "all tests pass");
        assert.equal(state.activeGoal.iterations, 0);
        assert.ok(state.activeGoal.setAt > 0);
        assert.ok(
            notifications.some((n) => n.includes("Goal set: all tests pass"))
        );
        assert.ok(pi.sentMessages.length > 0);
        assert.ok(pi.sentMessages[0].text.includes("all tests pass"));
    });

    void it("/goal with existing goal shows 'Goal updated'", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "old goal",
            setAt: Date.now() - 1000,
            iterations: 3,
        });
        mod.registerGoal(asApi(pi), state);

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("new goal", ctx);

        const goal = nn(state.activeGoal);
        assert.equal(goal.condition, "new goal");
        assert.ok(notifications.some((n) => n.includes("Goal updated")));
        assert.ok(notifications.some((n) => n.includes("old goal")));
        assert.ok(pi.sentMessages.length > 0);
        assert.ok(pi.sentMessages[0].text.includes("new goal"));
    });

    void it("/goal <condition> does not trigger turn when agent is busy", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState();
        mod.registerGoal(asApi(pi), state);

        const cmd = nn(pi.commands.get("goal"));
        const { ctx } = getNotificationsCtx({ idle: false });

        await cmd.handler("finish the work", ctx);

        assert.ok(state.activeGoal);
        assert.equal(pi.sentMessages.length, 0);
    });

    void it("/goal clear clears the active goal", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "finish the task",
            setAt: Date.now(),
            iterations: 5,
        });
        mod.registerGoal(asApi(pi), state);

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("clear", ctx);

        assert.equal(state.activeGoal, undefined);
        assert.ok(notifications.some((n) => n.includes("Goal cleared")));
    });

    void it("/goal clear with no active goal notifies", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("clear", ctx);

        assert.ok(
            notifications.some((n) => n.includes("No active goal to clear"))
        );
    });

    void it("/goal (no args) shows current goal status", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "write all tests",
            setAt: Date.now() - 60_000,
            iterations: 2,
        });
        mod.registerGoal(asApi(pi), state);

        const cmd = nn(pi.commands.get("goal"));
        const { ctx, notifications } = getNotificationsCtx();

        await cmd.handler("", ctx);

        assert.ok(notifications.some((n) => n.includes("write all tests")));
        assert.ok(notifications.some((n) => n.includes("2 turns")));
    });

    void it("before_agent_start injects goal context when goal is active", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 1,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "before_agent_start");
        const result = await handler(
            { systemPrompt: "Original prompt" },
            createMockCtx()
        );

        assert.ok(result);
        const r = result as { systemPrompt: string };
        assert.ok(r.systemPrompt.includes("ACTIVE GOAL"));
        assert.ok(r.systemPrompt.includes("fix the build"));
        assert.ok(r.systemPrompt.includes("Original prompt"));
    });

    void it("before_agent_start returns nothing when no goal active", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());

        const handler = await getEventHandler(pi, "before_agent_start");
        const result = await handler(
            { systemPrompt: "Original prompt" },
            createMockCtx()
        );

        assert.equal(result, undefined);
    });

    void it("turn_end increments iteration counter and persists", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "test goal",
            setAt: Date.now(),
            iterations: 2,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "turn_end");
        await handler({}, createMockCtx());

        const goal = nn(state.activeGoal);
        assert.equal(goal.iterations, 3);

        const goalEntries = pi.entries.filter(
            (e: { customType: string }) => e.customType === "tau-goal-state"
        );
        assert.ok(goalEntries.length > 0);
        const last = goalEntries[goalEntries.length - 1] as unknown as {
            data: { iterations: number };
        };
        assert.equal(last.data.iterations, 3);
    });

    void it("turn_end does nothing when no goal active", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const testState = createState();
        mod.registerGoal(asApi(pi), testState);

        const handler = await getEventHandler(pi, "turn_end");
        await handler({}, createMockCtx());

        assert.equal(testState.activeGoal, undefined);
    });

    void it("session_start restores goal from session entries", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState();
        mod.registerGoal(asApi(pi), state);

        const { ctx, notifications } = getNotificationsCtx();
        (
            ctx.sessionManager as unknown as { getEntries: () => unknown[] }
        ).getEntries = () => [
            {
                type: "custom",
                customType: "tau-goal-state",
                data: {
                    condition: "resume goal",
                    setAt: 1000,
                    iterations: 5,
                },
            },
        ];

        const handler = await getEventHandler(pi, "session_start");
        await handler({}, ctx);

        const goal = nn(state.activeGoal);
        assert.equal(goal.condition, "resume goal");
        assert.equal(goal.iterations, 5);
        assert.ok(notifications.some((n) => n.includes("Goal restored")));
    });
});
