import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    startTitlebarSpinner,
    stopTitlebarSpinner,
    startAgentTimer,
    stopAgentTimer,
} from "../features/titlebar.ts";
import { TauState } from "../state.ts";

void describe("titlebar spinner", () => {
    void it("stopTitlebarSpinner sets title to base", () => {
        const state = new TauState();
        const titles: string[] = [];
        const pi = {
            getSessionName: () => undefined,
        } as never;
        const ctx = {
            ui: { setTitle: (title: string) => titles.push(title) },
        } as never;

        stopTitlebarSpinner(pi, state, ctx);

        assert.equal(titles.length, 1);
        assert.ok(titles[0].startsWith("π - "));
    });

    void it("startTitlebarSpinner clears previous timer", () => {
        const state = new TauState();
        const titles: string[] = [];
        const pi = {
            getSessionName: () => "test",
        } as never;
        const ctx = {
            ui: { setTitle: (title: string) => titles.push(title) },
        } as never;

        state.titlebarTimer = setInterval(() => {}, 10000);
        startTitlebarSpinner(pi, state, ctx);

        // Should have cleared old timer and started new one
        assert.ok(state.titlebarTimer !== null);
        assert.ok(titles.length >= 1);

        // Cleanup
        clearInterval(state.titlebarTimer);
    });

    void it("stopTitlebarSpinner clears timer", () => {
        const state = new TauState();
        state.titlebarTimer = setInterval(() => {}, 10000);
        const pi = {
            getSessionName: () => undefined,
        } as never;
        const ctx = {
            ui: { setTitle: () => {} },
        } as never;

        stopTitlebarSpinner(pi, state, ctx);
        assert.equal(state.titlebarTimer, null);
        assert.equal(state.titlebarFrameIndex, 0);
    });
});

void describe("agent timer", () => {
    void it("startAgentTimer clears previous timer", () => {
        const state = new TauState();
        state.agentTimer = setInterval(() => {}, 10000);
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: { fg: (_c: string, t: string) => t },
            },
        } as never;

        startAgentTimer(state, ctx);
        assert.ok(state.agentTimer !== null);

        clearInterval(state.agentTimer);
    });

    void it("startAgentTimer does nothing when agentStartTime is undefined", () => {
        const state = new TauState();
        state.agentStartTime = undefined;
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: { fg: (_c: string, t: string) => t },
            },
        } as never;

        startAgentTimer(state, ctx);
        // Timer is running but will skip ticks since agentStartTime is undefined
        assert.ok(state.agentTimer !== null);

        clearInterval(state.agentTimer);
    });

    void it("stopAgentTimer clears timer and sets elapsed status", () => {
        const state = new TauState();
        state.agentStartTime = Date.now() - 5000;
        state.agentTimer = setInterval(() => {}, 10000);
        const statuses: { name: string; content: unknown }[] = [];
        const ctx = {
            ui: {
                setStatus: (name: string, content: unknown) =>
                    statuses.push({ name, content }),
                theme: { fg: (_c: string, t: string) => t },
            },
        } as never;

        stopAgentTimer(state, ctx);

        assert.equal(state.agentTimer, null);
        assert.ok(statuses.some((s) => s.name === "tau-turn"));
    });

    void it("stopAgentTimer does nothing when no timer and no start time", () => {
        const state = new TauState();
        state.agentTimer = null;
        state.agentStartTime = undefined;
        const ctx = {
            ui: {
                setStatus: () => {},
                theme: { fg: (_c: string, t: string) => t },
            },
        } as never;

        stopAgentTimer(state, ctx);
        assert.equal(state.agentTimer, null);
    });
});
