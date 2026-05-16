import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    findTaskById,
    getChildIds,
    getAncestorIds,
    getDescendantIds,
    wouldCreateCycle,
    formatTaskTree,
    TaskListComponent,
    reconstructTaskState,
} from "../features/task.ts";
import { TauState } from "../state.ts";
import type { Task } from "../types.ts";

// ─── Pure domain function tests ─────────────────────────────────────

void describe("findTaskById", () => {
    void it("finds a task by id", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
        ];
        assert.equal(findTaskById(tasks, 1)?.title, "A");
    });

    void it("returns undefined for missing id", () => {
        const tasks: Task[] = [];
        assert.equal(findTaskById(tasks, 99), undefined);
    });
});

void describe("getChildIds", () => {
    void it("returns children of a parent", () => {
        const tasks: Task[] = [
            { id: 1, title: "Root", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
            {
                id: 3,
                title: "Other",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
            {
                id: 4,
                title: "Unrelated",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        assert.deepEqual(getChildIds(tasks, 1), [2, 3]);
    });

    void it("returns empty for childless task", () => {
        const tasks: Task[] = [
            { id: 1, title: "Root", status: "todo", links: [], createdAt: 0 },
        ];
        assert.deepEqual(getChildIds(tasks, 1), []);
    });
});

void describe("getAncestorIds", () => {
    void it("returns ancestors up to root", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
            {
                id: 3,
                title: "C",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 2,
            },
        ];
        assert.deepEqual(getAncestorIds(tasks, 3), new Set([2, 1]));
    });

    void it("returns empty for root task", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
        ];
        assert.deepEqual(getAncestorIds(tasks, 1), new Set());
    });

    void it("breaks cycles gracefully", () => {
        const tasks: Task[] = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 2,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
        ];
        const ancestors = getAncestorIds(tasks, 1);
        assert.ok(ancestors.has(2));
    });
});

void describe("getDescendantIds", () => {
    void it("returns all descendants", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
            {
                id: 3,
                title: "C",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 2,
            },
            {
                id: 4,
                title: "D",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
        ];
        assert.deepEqual(getDescendantIds(tasks, 1), new Set([2, 3, 4]));
    });

    void it("returns empty for leaf task", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
        ];
        assert.deepEqual(getDescendantIds(tasks, 1), new Set());
    });
});

void describe("wouldCreateCycle", () => {
    void it("returns false for undefined parent", () => {
        const tasks: Task[] = [];
        assert.equal(wouldCreateCycle(tasks, 1, undefined), false);
    });

    void it("returns true for self-parent", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
        ];
        assert.equal(wouldCreateCycle(tasks, 1, 1), true);
    });

    void it("returns true if new parent is a descendant", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
        ];
        assert.equal(wouldCreateCycle(tasks, 1, 2), true);
    });

    void it("returns false for valid reparenting", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            { id: 2, title: "B", status: "todo", links: [], createdAt: 0 },
        ];
        assert.equal(wouldCreateCycle(tasks, 2, 1), false);
    });
});

void describe("formatTaskTree", () => {
    void it("formats flat task list", () => {
        const tasks: Task[] = [
            { id: 1, title: "Task A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "Task B",
                status: "done",
                links: [],
                createdAt: 0,
            },
        ];
        const output = formatTaskTree(tasks);
        assert.ok(output.includes("#1: Task A"));
        assert.ok(output.includes("#2: Task B"));
        assert.ok(output.includes("✓"));
    });

    void it("indents nested tasks", () => {
        const tasks: Task[] = [
            { id: 1, title: "Parent", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
        ];
        const output = formatTaskTree(tasks);
        const lines = output.split("\n");
        const parentLine = lines.find((l) => l.includes("#1: Parent"));
        const childLine = lines.find((l) => l.includes("#2: Child"));
        assert.ok(parentLine);
        assert.ok(childLine);
        // Child should be indented more than parent
        assert.ok(childLine.indexOf("#") > parentLine.indexOf("#"));
    });

    void it("shows links inline", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [{ targetId: 1, type: "blocks" }],
                createdAt: 0,
            },
        ];
        const output = formatTaskTree(tasks);
        assert.ok(output.includes("blocks #1"));
    });

    void it("returns empty string for no tasks", () => {
        assert.equal(formatTaskTree([]), "");
    });
});

// ─── TaskListComponent tests ────────────────────────────────────────

void describe("TaskListComponent", () => {
    const theme = {
        fg: (_colour: string, text: string) => text,
        bold: (text: string) => text,
        strikethrough: (text: string) => text,
    };

    void it("renders empty state", () => {
        const component = new TaskListComponent([], theme, () => {});
        const lines = component.render(80);
        assert.ok(lines.some((l) => l.includes("No tasks yet")));
    });

    void it("renders task items with status", () => {
        const tasks: Task[] = [
            {
                id: 1,
                title: "First task",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Second task",
                status: "done",
                links: [],
                createdAt: 0,
            },
            {
                id: 3,
                title: "Third task",
                status: "in-progress",
                links: [],
                createdAt: 0,
            },
        ];
        const component = new TaskListComponent(tasks, theme, () => {});
        const lines = component.render(80);
        assert.ok(lines.some((l) => l.includes("First task")));
        assert.ok(lines.some((l) => l.includes("Second task")));
        assert.ok(lines.some((l) => l.includes("1/3 completed")));
    });

    void it("renders nested tasks indented", () => {
        const tasks: Task[] = [
            { id: 1, title: "Parent", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [],
                createdAt: 0,
                parentId: 1,
            },
        ];
        const component = new TaskListComponent(tasks, theme, () => {});
        const lines = component.render(80);
        assert.ok(lines.some((l) => l.includes("Parent")));
        assert.ok(lines.some((l) => l.includes("Child")));
    });

    void it("renders links inline", () => {
        const tasks: Task[] = [
            { id: 1, title: "A", status: "todo", links: [], createdAt: 0 },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [{ targetId: 1, type: "blocks" }],
                createdAt: 0,
            },
        ];
        const component = new TaskListComponent(tasks, theme, () => {});
        const lines = component.render(80);
        assert.ok(lines.some((l) => l.includes("blocks→#1")));
    });

    void it("caches render output for same width", () => {
        const component = new TaskListComponent(
            [{ id: 1, title: "Task", status: "todo", links: [], createdAt: 0 }],
            theme,
            () => {}
        );
        const first = component.render(80);
        const second = component.render(80);
        assert.strictEqual(first, second);
    });

    void it("invalidates cache", () => {
        const component = new TaskListComponent(
            [{ id: 1, title: "Task", status: "todo", links: [], createdAt: 0 }],
            theme,
            () => {}
        );
        component.render(80);
        component.invalidate();
        // Re-render should work without error
        const lines = component.render(80);
        assert.ok(Array.isArray(lines));
    });

    void it("handles escape key", () => {
        let closed = false;
        const component = new TaskListComponent([], theme, () => {
            closed = true;
        });
        component.handleInput("\x1b");
        assert.equal(closed, true);
    });

    void it("handles ctrl+c", () => {
        let closed = false;
        const component = new TaskListComponent([], theme, () => {
            closed = true;
        });
        component.handleInput("\x03");
        assert.equal(closed, true);
    });
});

// ─── reconstructTaskState tests ─────────────────────────────────────

void describe("reconstructTaskState", () => {
    void it("restores tasks from toolResult entries", () => {
        const state = new TauState();
        const ctx = {
            sessionManager: {
                getBranch: () => [
                    {
                        type: "message",
                        message: {
                            role: "toolResult",
                            toolName: "task",
                            details: {
                                tasks: [
                                    {
                                        id: 1,
                                        title: "Task",
                                        status: "todo",
                                        links: [],
                                        createdAt: 1000,
                                    },
                                ],
                                nextId: 2,
                            },
                        },
                    },
                ],
            },
        } as never;

        reconstructTaskState(state, ctx);
        assert.equal(state.tasks.length, 1);
        assert.equal(state.tasks[0].title, "Task");
        assert.equal(state.nextTaskId, 2);
    });

    void it("keeps latest state from multiple entries", () => {
        const state = new TauState();
        const ctx = {
            sessionManager: {
                getBranch: () => [
                    {
                        type: "message",
                        message: {
                            role: "toolResult",
                            toolName: "task",
                            details: {
                                tasks: [
                                    {
                                        id: 1,
                                        title: "Old",
                                        status: "done",
                                        links: [],
                                        createdAt: 1000,
                                    },
                                ],
                                nextId: 2,
                            },
                        },
                    },
                    {
                        type: "message",
                        message: {
                            role: "toolResult",
                            toolName: "task",
                            details: {
                                tasks: [
                                    {
                                        id: 1,
                                        title: "Updated",
                                        status: "todo",
                                        links: [],
                                        createdAt: 1000,
                                    },
                                    {
                                        id: 2,
                                        title: "New",
                                        status: "todo",
                                        links: [],
                                        createdAt: 2000,
                                    },
                                ],
                                nextId: 3,
                            },
                        },
                    },
                ],
            },
        } as never;

        reconstructTaskState(state, ctx);
        assert.equal(state.tasks.length, 2);
        assert.equal(state.tasks[0].title, "Updated");
        assert.equal(state.nextTaskId, 3);
    });

    void it("skips non-task entries", () => {
        const state = new TauState();
        const ctx = {
            sessionManager: {
                getBranch: () => [
                    { type: "message", message: { role: "user" } },
                    {
                        type: "message",
                        message: { role: "toolResult", toolName: "bash" },
                    },
                ],
            },
        } as never;

        reconstructTaskState(state, ctx);
        assert.equal(state.tasks.length, 0);
        assert.equal(state.nextTaskId, 1);
    });
});
