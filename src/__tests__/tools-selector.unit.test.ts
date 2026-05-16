import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    persistToolsState,
    applyToolsSelection,
    restoreToolsFromBranch,
} from "../features/tools-selector.ts";
import { TauState } from "../state.ts";

void describe("restoreToolsFromBranch", () => {
    void it("restores saved tools from branch entries", () => {
        const state = new TauState();
        const appliedTools: string[][] = [];
        const pi = {
            getAllTools: () => [
                { name: "read" },
                { name: "bash" },
                { name: "edit" },
                { name: "write" },
            ],
            getActiveTools: () => ["read", "bash", "edit", "write"],
            setActiveTools: (tools: string[]) => {
                appliedTools.push(tools);
            },
        } as never;

        const ctx = {
            sessionManager: {
                getBranch: () => [
                    {
                        type: "custom",
                        customType: "tools-config",
                        data: { enabledTools: ["read", "bash"] },
                    },
                ],
            },
        } as never;

        restoreToolsFromBranch(pi, state, ctx);

        assert.equal(state.enabledTools.size, 2);
        assert.ok(state.enabledTools.has("read"));
        assert.ok(state.enabledTools.has("bash"));
        assert.equal(appliedTools.length, 1);
        assert.deepEqual(appliedTools[0], ["read", "bash"]);
    });

    void it("uses active tools when no saved config", () => {
        const state = new TauState();
        const pi = {
            getAllTools: () => [
                { name: "read" },
                { name: "bash" },
                { name: "edit" },
            ],
            getActiveTools: () => ["read", "bash"],
            setActiveTools: () => {},
        } as never;

        const ctx = {
            sessionManager: {
                getBranch: () => [],
            },
        } as never;

        restoreToolsFromBranch(pi, state, ctx);
        assert.equal(state.enabledTools.size, 2);
    });

    void it("filters out unknown tools", () => {
        const state = new TauState();
        const pi = {
            getAllTools: () => [{ name: "read" }, { name: "bash" }],
            getActiveTools: () => ["read"],
            setActiveTools: () => {},
        } as never;

        const ctx = {
            sessionManager: {
                getBranch: () => [
                    {
                        type: "custom",
                        customType: "tools-config",
                        data: { enabledTools: ["read", "nonexistent"] },
                    },
                ],
            },
        } as never;

        restoreToolsFromBranch(pi, state, ctx);
        assert.equal(state.enabledTools.size, 1);
        assert.ok(state.enabledTools.has("read"));
    });
});

void describe("applyToolsSelection", () => {
    void it("applies enabled tools via pi.setActiveTools", () => {
        const state = new TauState();
        state.enabledTools = new Set(["read", "bash"]);
        const applied: string[][] = [];
        const pi = {
            setActiveTools: (tools: string[]) => applied.push(tools),
        } as never;

        applyToolsSelection(pi, state);
        assert.equal(applied.length, 1);
        assert.deepEqual(applied[0], ["read", "bash"]);
    });
});

void describe("persistToolsState", () => {
    void it("appends an entry with enabled tools", () => {
        const state = new TauState();
        state.enabledTools = new Set(["read", "edit"]);
        const entries: { customType: string; data: unknown }[] = [];
        const pi = {
            appendEntry: (customType: string, data: unknown) => {
                entries.push({ customType, data });
            },
        } as never;

        persistToolsState(pi, state);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].customType, "tools-config");
        const data = entries[0].data as { enabledTools: string[] };
        assert.deepEqual(data.enabledTools, ["read", "edit"]);
    });
});
