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

function createMockCtx(
    hasUI: boolean = true,
    idle: boolean = true,
    pendingMessages: boolean = false
) {
    return {
        hasUI,
        isIdle: () => idle,
        hasPendingMessages: () => pendingMessages,
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

function getNotificationsCtx(opts?: {
    hasUI?: boolean;
    idle?: boolean;
    pendingMessages?: boolean;
}) {
    const notifications: string[] = [];
    const ctx = createMockCtx(
        opts?.hasUI ?? true,
        opts?.idle ?? true,
        opts?.pendingMessages ?? false
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
    const handlers = nn(pi.events.get(event), `${event} handlers`);
    assert.ok(handlers.length > 0, `${event} needs handlers`);
    return handlers[0];
}

/** Build a mock agent_end event with the given assistant messages. */
function makeAgentEndEvent(
    assistantMessages: Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
        stopReason?: string;
    }>
) {
    return {
        messages: assistantMessages.map((m) => ({
            role: m.role,
            content: m.content,
            stopReason: m.stopReason ?? "stop",
        })),
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

void describe("goal feature", () => {
    void it("exports registerGoal function", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(typeof mod.registerGoal, "function");
    });

    void it("exports checkGoalCompletion function", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(typeof mod.checkGoalCompletion, "function");
    });

    void it("registerGoal registers the /goal command", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());
        assert.ok(pi.commands.has("goal"));
    });

    void it("registerGoal subscribes to all required events", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());

        assert.ok(pi.events.has("session_start"));
        assert.ok(pi.events.has("before_agent_start"));
        assert.ok(pi.events.has("agent_end"));
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
        assert.ok(
            notifications.some((n) => n.includes("Goal set: all tests pass"))
        );
        assert.ok(pi.sentMessages.length > 0);
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

        assert.equal(state.activeGoal!.condition, "new goal");
        assert.ok(notifications.some((n) => n.includes("Goal updated")));
        assert.ok(notifications.some((n) => n.includes("old goal")));
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

// ─── Completion detection tests ─────────────────────────────────────

void describe("goal checkGoalCompletion", () => {
    void it("returns 'met' for goal achieved", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("The goal is achieved. All tests pass."),
            "met"
        );
    });

    void it("returns 'met' for condition satisfied", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("The condition is now satisfied."),
            "met"
        );
    });

    void it("returns 'met' for task complete", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(mod.checkGoalCompletion("The task is complete."), "met");
    });

    void it("returns 'met' for nothing more to do", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("There is nothing more to do."),
            "met"
        );
    });

    void it("returns 'impossible' for goal impossible", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("The goal is impossible to achieve."),
            "impossible"
        );
    });

    void it("returns 'impossible' for unable to complete", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("I am unable to complete the goal."),
            "impossible"
        );
    });

    void it("returns null for in-progress text", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(
            mod.checkGoalCompletion("I am still working on the task."),
            null
        );
    });

    void it("returns null for empty text", async () => {
        const mod = await import("../features/goal.ts");
        assert.equal(mod.checkGoalCompletion(""), null);
    });
});

// ─── agent_end continuation tests ───────────────────────────────────

void describe("goal agent_end continuation", () => {
    void it("sends continuation message when goal is not met", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 0,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "I made some progress but the build is still failing.",
                    },
                ],
                stopReason: "stop",
            },
        ]);
        const ctx = getNotificationsCtx().ctx;

        await handler(event, ctx);

        // Should have sent a continuation message
        const followUps = pi.sentMessages.filter(
            (m) =>
                m.options &&
                (m.options as Record<string, string>).deliverAs === "followUp"
        );
        assert.ok(followUps.length > 0, "should send followUp continuation");
        assert.ok(
            followUps[0].text.includes("fix the build"),
            "continuation should mention the goal"
        );
        // Goal should still be active with incremented iterations
        assert.ok(state.activeGoal);
        assert.equal(state.activeGoal.iterations, 1);
    });

    void it("clears goal and notifies when agent says goal is met", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 3,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "The build is passing. Goal condition is met.",
                    },
                ],
                stopReason: "stop",
            },
        ]);
        const { ctx, notifications } = getNotificationsCtx();

        await handler(event, ctx);

        assert.equal(state.activeGoal, undefined, "goal should be cleared");
        assert.ok(
            notifications.some(
                (n) =>
                    n.includes("Goal achieved") && n.includes("fix the build")
            )
        );
        // No continuation message should have been sent
        const followUps = pi.sentMessages.filter(
            (m) =>
                m.options &&
                (m.options as Record<string, string>).deliverAs === "followUp"
        );
        assert.equal(followUps.length, 0);
    });

    void it("clears goal when agent says it's impossible", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 2,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "The goal is impossible — the dependency is unpublished.",
                    },
                ],
                stopReason: "stop",
            },
        ]);
        const { ctx, notifications } = getNotificationsCtx();

        await handler(event, ctx);

        assert.equal(state.activeGoal, undefined);
        assert.ok(
            notifications.some(
                (n) => n.includes("impossible") && n.includes("fix the build")
            )
        );
    });

    void it("does nothing when no goal is active", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        mod.registerGoal(asApi(pi), createState());

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [{ type: "text", text: "All done!" }],
                stopReason: "stop",
            },
        ]);
        const ctx = getNotificationsCtx().ctx;

        await handler(event, ctx);

        assert.equal(pi.sentMessages.length, 0);
    });

    void it("does nothing when agent made tool calls (not a real stop)", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 0,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [{ type: "toolCall", name: "bash" }],
                stopReason: "toolUse",
            },
        ]);
        const ctx = getNotificationsCtx().ctx;

        await handler(event, ctx);

        // No continuation — the tool loop handles it
        const followUps = pi.sentMessages.filter(
            (m) =>
                m.options &&
                (m.options as Record<string, string>).deliverAs === "followUp"
        );
        assert.equal(followUps.length, 0);
        assert.equal(state.activeGoal!.iterations, 0);
    });

    void it("does nothing when there are pending messages", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 0,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [{ type: "text", text: "Still working on it." }],
                stopReason: "stop",
            },
        ]);
        const { ctx } = getNotificationsCtx({ pendingMessages: true });

        await handler(event, ctx);

        const followUps = pi.sentMessages.filter(
            (m) =>
                m.options &&
                (m.options as Record<string, string>).deliverAs === "followUp"
        );
        assert.equal(followUps.length, 0);
    });

    void it("does nothing for non-clean stop reasons", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 0,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Here is my analysis so far." },
                ],
                stopReason: "maxTokens",
            },
        ]);
        const ctx = getNotificationsCtx().ctx;

        await handler(event, ctx);

        const followUps = pi.sentMessages.filter(
            (m) =>
                m.options &&
                (m.options as Record<string, string>).deliverAs === "followUp"
        );
        assert.equal(followUps.length, 0);
    });

    void it("persists iteration count to session on continuation", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 2,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const event = makeAgentEndEvent([
            {
                role: "assistant",
                content: [{ type: "text", text: "Still working on the fix." }],
                stopReason: "stop",
            },
        ]);
        const ctx = getNotificationsCtx().ctx;

        await handler(event, ctx);

        const goalEntries = pi.entries.filter(
            (e: { customType: string }) => e.customType === "tau-goal-state"
        );
        assert.ok(goalEntries.length > 0);
        const last = goalEntries[goalEntries.length - 1] as unknown as {
            data: { iterations: number };
        };
        assert.equal(last.data.iterations, 3);
    });

    void it("continuation count increments each turn", async () => {
        const mod = await import("../features/goal.ts");
        const pi = createMockPi();
        const state = createState({
            condition: "fix the build",
            setAt: Date.now(),
            iterations: 0,
        });
        mod.registerGoal(asApi(pi), state);

        const handler = await getEventHandler(pi, "agent_end");
        const ctx = getNotificationsCtx().ctx;

        // Simulate 3 turns of the agent not meeting the goal
        for (let turn = 1; turn <= 3; turn++) {
            pi.sentMessages.length = 0;
            const event = makeAgentEndEvent([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Turn ${turn}: still working on the fix.`,
                        },
                    ],
                    stopReason: "stop",
                },
            ]);

            await handler(event, ctx);

            const followUps = pi.sentMessages.filter(
                (m) =>
                    m.options &&
                    (m.options as Record<string, string>).deliverAs ===
                        "followUp"
            );
            assert.ok(
                followUps.length > 0,
                `turn ${turn}: should send continuation`
            );
            assert.ok(
                followUps[0].text.includes(`turn ${turn}`),
                `turn ${turn}: message should reference turn number`
            );
            assert.equal(state.activeGoal.iterations, turn);
        }
    });
});
