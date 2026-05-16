import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updatePlanStatus, togglePlanMode } from "../features/plan-mode.ts";
import { TauState } from "../state.ts";
import type { TodoItem } from "../plan-utils.ts";

void describe("updatePlanStatus", () => {
    void it("shows plan mode status when enabled with no items", () => {
        const state = new TauState();
        state.planModeEnabled = true;
        state.planExecutionMode = false;
        state.planItems = [];

        const statusSet: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) => {
                    statusSet.push({ name, content });
                },
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    strikethrough: (t: string) => t,
                },
            },
        } as never;

        updatePlanStatus(state, ctx);
        assert.ok(
            statusSet.some(
                (s) => s.name === "plan-mode" && s.content !== undefined
            )
        );
    });

    void it("shows execution progress when items exist", () => {
        const state = new TauState();
        state.planModeEnabled = false;
        state.planExecutionMode = true;
        state.planItems = [
            { step: 1, text: "First", completed: true },
            { step: 2, text: "Second", completed: false },
        ] as TodoItem[];

        const statusSet: { name: string; content: unknown }[] = [];
        const widgetSet: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) => {
                    statusSet.push({ name, content });
                },
                setWidget: (name: string, content: unknown) => {
                    widgetSet.push({ name, content });
                },
                theme: {
                    fg: (_c: string, t: string) => t,
                    strikethrough: (t: string) => t,
                },
            },
        } as never;

        updatePlanStatus(state, ctx);
        assert.ok(
            statusSet.some(
                (s) => s.name === "plan-mode" && s.content !== undefined
            )
        );
        assert.ok(
            widgetSet.some(
                (w) => w.name === "plan-todos" && w.content !== undefined
            )
        );
    });

    void it("clears status when plan mode is off", () => {
        const state = new TauState();
        state.planModeEnabled = false;
        state.planExecutionMode = false;
        state.planItems = [];

        const statusSet: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) => {
                    statusSet.push({ name, content });
                },
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    strikethrough: (t: string) => t,
                },
            },
        } as never;

        updatePlanStatus(state, ctx);
        assert.ok(
            statusSet.some(
                (s) => s.name === "plan-mode" && s.content === undefined
            )
        );
    });
});

void describe("togglePlanMode", () => {
    void it("enables plan mode and sets tools", () => {
        const state = new TauState();
        state.planModeEnabled = false;

        const toolsSet: string[][] = [];
        const notifications: string[] = [];
        const pi = {
            setActiveTools: (tools: string[]) => toolsSet.push(tools),
        } as never;

        const ctx = {
            ui: {
                notify: (msg: string) => notifications.push(msg),
                setStatus: () => {},
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    strikethrough: (t: string) => t,
                },
            },
        } as never;

        togglePlanMode(pi, state, ctx);

        assert.equal(state.planModeEnabled, true);
        assert.equal(state.planExecutionMode, false);
        assert.equal(state.planItems.length, 0);
        assert.equal(toolsSet.length, 1);
        assert.ok(notifications.some((n) => n.includes("Plan mode enabled")));
    });

    void it("disables plan mode and restores tools", () => {
        const state = new TauState();
        state.planModeEnabled = true;

        const toolsSet: string[][] = [];
        const notifications: string[] = [];
        const pi = {
            setActiveTools: (tools: string[]) => toolsSet.push(tools),
        } as never;

        const ctx = {
            ui: {
                notify: (msg: string) => notifications.push(msg),
                setStatus: () => {},
                setWidget: () => {},
                theme: {
                    fg: (_c: string, t: string) => t,
                    strikethrough: (t: string) => t,
                },
            },
        } as never;

        togglePlanMode(pi, state, ctx);

        assert.equal(state.planModeEnabled, false);
        assert.ok(notifications.some((n) => n.includes("disabled")));
    });
});
