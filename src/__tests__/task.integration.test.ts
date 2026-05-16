import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerTask } from "../features/task.ts";
import { TauState } from "../state.ts";
import type { TaskDetails } from "../types.ts";

/**
 * DI approach: registerTask captures a tool definition with an execute handler
 * that closes over `state`. We capture that handler and call it directly.
 */
function captureTaskTool(state: TauState) {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: unknown
        ) => Promise<{
            content: { type: string; text: string }[];
            details: TaskDetails;
        }>;
        renderCall: (
            args: Record<string, unknown>,
            theme: {
                fg: (c: string, t: string) => string;
                bold: (t: string) => string;
            }
        ) => unknown;
        renderResult: (
            result: {
                content: { type: string; text: string }[];
                details: TaskDetails;
            },
            opts: { expanded: boolean },
            theme: {
                fg: (c: string, t: string) => string;
                bold: (t: string) => string;
                success: (t: string) => string;
                strikethrough: (t: string) => string;
            }
        ) => unknown;
    } | null = null;

    const pi = {
        registerTool(tool: typeof captured) {
            captured = tool;
        },
        registerCommand: () => {},
    } as never;

    registerTask(pi, state);
    return captured!;
}

// ─── list ────────────────────────────────────────────────────────────

void describe("task tool — list action", () => {
    void it("returns 'No tasks' when empty", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "list" },
            null,
            null,
            null
        );
        assert.equal(result.content[0].text, "No tasks");
        assert.equal(result.details.action, "list");
    });

    void it("lists all tasks", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "First",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Second",
                status: "done",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "list" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("First"));
        assert.ok(result.content[0].text.includes("Second"));
    });
});

// ─── add ─────────────────────────────────────────────────────────────

void describe("task tool — add action", () => {
    void it("adds a task with title", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "add", title: "New task" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Added task #1"));
        assert.equal(state.tasks.length, 1);
        assert.equal(state.tasks[0].title, "New task");
        assert.equal(state.tasks[0].status, "todo");
        assert.equal(state.nextTaskId, 2);
    });

    void it("adds a task with custom status", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        await tool.execute(
            "tc-1",
            { action: "add", title: "Blocked task", status: "blocked" },
            null,
            null,
            null
        );
        assert.equal(state.tasks[0].status, "blocked");
    });

    void it("adds a task with description", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        await tool.execute(
            "tc-1",
            { action: "add", title: "Task", description: "Some details" },
            null,
            null,
            null
        );
        assert.equal(state.tasks[0].description, "Some details");
    });

    void it("adds a nested task under a parent", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        state.nextTaskId = 2;
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "add", title: "Child", parent: 1 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Added task #2"));
        assert.ok(
            state.tasks[1].links.some(
                (l) => l.type === "child-of" && l.targetId === 1
            )
        );
    });

    void it("returns error when title is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "add" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.equal(result.details.error, "title required for add");
        assert.equal(state.tasks.length, 0);
    });

    void it("returns error for unknown parent", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "add", title: "Orphan", parent: 99 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.ok(result.content[0].text.includes("parent #99 not found"));
    });

    void it("returns error for invalid status", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "add", title: "Task", status: "unknown" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.ok(result.content[0].text.includes("invalid status"));
    });
});

// ─── update ──────────────────────────────────────────────────────────

void describe("task tool — update action", () => {
    void it("updates a task title", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Old",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "update", id: 1, title: "New" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Updated task #1"));
        assert.equal(state.tasks[0].title, "New");
    });

    void it("updates task status", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Task",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        await tool.execute(
            "tc-1",
            { action: "update", id: 1, status: "done" },
            null,
            null,
            null
        );
        assert.equal(state.tasks[0].status, "done");
    });

    void it("updates task description", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Task",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        await tool.execute(
            "tc-1",
            { action: "update", id: 1, description: "Updated desc" },
            null,
            null,
            null
        );
        assert.equal(state.tasks[0].description, "Updated desc");
    });

    void it("returns error when id is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "update" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.equal(result.details.error, "id required for update");
    });

    void it("returns error for unknown id", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "update", id: 99 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("not found"));
    });

    void it("returns error for invalid status", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Task",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "update", id: 1, status: "nonsense" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("invalid status"));
    });
});

// ─── remove ──────────────────────────────────────────────────────────

void describe("task tool — remove action", () => {
    void it("removes a leaf task", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "remove", id: 1 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Removed 1 task(s)"));
        assert.equal(state.tasks.length, 1);
        assert.equal(state.tasks[0].id, 2);
    });

    void it("returns error when removing parent without cascade", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [{ targetId: 1, type: "child-of" }],
                createdAt: 0,
            },
        ];
        state.nextTaskId = 3;
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "remove", id: 1 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.ok(result.content[0].text.includes("child"));
        // State unchanged
        assert.equal(state.tasks.length, 2);
    });

    void it("cascades removal to children", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [{ targetId: 1, type: "child-of" }],
                createdAt: 0,
            },
            {
                id: 3,
                title: "Grandchild",
                status: "todo",
                links: [{ targetId: 2, type: "child-of" }],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "remove", id: 1, cascade: true },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Removed 3 task(s)"));
        assert.equal(state.tasks.length, 0);
    });

    void it("returns error when id is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "remove" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.equal(result.details.error, "id required for remove");
    });

    void it("returns error for unknown id", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "remove", id: 99 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("not found"));
    });

    void it("cleans up links pointing to removed tasks", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [{ targetId: 2, type: "blocks" }],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        await tool.execute(
            "tc-1",
            { action: "remove", id: 2 },
            null,
            null,
            null
        );
        assert.equal(state.tasks[0].links.length, 0);
    });
});

// ─── move ────────────────────────────────────────────────────────────

void describe("task tool — move action", () => {
    void it("moves a task under a parent", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move", id: 2, parent: 1 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Moved task #2 under #1"));
        assert.ok(
            state.tasks[1].links.some(
                (l) => l.type === "child-of" && l.targetId === 1
            )
        );
    });

    void it("moves a task to root with undefined parent", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [{ targetId: 1, type: "child-of" }],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move", id: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Moved task #2 to root"));
        assert.ok(!state.tasks[1].links.some((l) => l.type === "child-of"));
    });

    void it("returns error when id is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Error"));
        assert.equal(result.details.error, "id required for move");
    });

    void it("returns error for unknown task", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move", id: 99 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("not found"));
    });

    void it("returns error for unknown parent", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move", id: 1, parent: 99 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("parent #99 not found"));
    });

    void it("returns error for cycle detection", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "Parent",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "Child",
                status: "todo",
                links: [{ targetId: 1, type: "child-of" }],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "move", id: 1, parent: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("cycle"));
    });
});

// ─── link ────────────────────────────────────────────────────────────

void describe("task tool — link action", () => {
    void it("creates a link between tasks", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 2, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Linked #1 blocks #2"));
        assert.equal(state.tasks[0].links.length, 1);
        assert.deepEqual(state.tasks[0].links[0], {
            targetId: 2,
            type: "blocks",
        });
    });

    void it("returns error when from is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", to: 2, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("from and to required"));
    });

    void it("returns error when to is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("from and to required"));
    });

    void it("returns error for self-link", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 1, type: "related" },
            null,
            null,
            null
        );
        assert.ok(
            result.content[0].text.includes("cannot link a task to itself")
        );
    });

    void it("returns error for unknown from task", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 2, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("#1 not found"));
    });

    void it("returns error for unknown to task", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 99, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("#99 not found"));
    });

    void it("returns error for duplicate link", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [{ targetId: 2, type: "blocks" }],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 2, type: "blocks" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("already exists"));
    });

    void it("returns error for invalid link type", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "link", from: 1, to: 2, type: "invalid" },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("invalid link type"));
    });
});

// ─── unlink ──────────────────────────────────────────────────────────

void describe("task tool — unlink action", () => {
    void it("removes a link", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [{ targetId: 2, type: "blocks" }],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "unlink", from: 1, to: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("Unlinked #1 blocks #2"));
        assert.equal(state.tasks[0].links.length, 0);
    });

    void it("returns error when from is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "unlink", to: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("from and to required"));
    });

    void it("returns error when to is missing", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "unlink", from: 1 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("from and to required"));
    });

    void it("returns error for unknown from task", async () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "unlink", from: 99, to: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("#99 not found"));
    });

    void it("returns error when no link exists", async () => {
        const state = new TauState();
        state.tasks = [
            {
                id: 1,
                title: "A",
                status: "todo",
                links: [],
                createdAt: 0,
            },
            {
                id: 2,
                title: "B",
                status: "todo",
                links: [],
                createdAt: 0,
            },
        ];
        const tool = captureTaskTool(state);
        const result = await tool.execute(
            "tc-1",
            { action: "unlink", from: 1, to: 2 },
            null,
            null,
            null
        );
        assert.ok(result.content[0].text.includes("no link"));
    });
});

// ─── renderCall ──────────────────────────────────────────────────────

void describe("task tool — renderCall", () => {
    const theme = {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
    };

    void it("renders add action with title", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const rendered = tool.renderCall(
            { action: "add", title: "my task" },
            theme
        );
        assert.ok(rendered);
    });

    void it("renders update action with id", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const rendered = tool.renderCall({ action: "update", id: 3 }, theme);
        assert.ok(rendered);
    });

    void it("renders link action with from/to", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const rendered = tool.renderCall(
            { action: "link", from: 1, to: 2 },
            theme
        );
        assert.ok(rendered);
    });
});

// ─── renderResult ────────────────────────────────────────────────────

void describe("task tool — renderResult", () => {
    const theme = {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        success: (t: string) => t,
        strikethrough: (t: string) => t,
    };

    void it("renders error details", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "Error" }],
                details: {
                    action: "add",
                    tasks: [],
                    nextId: 1,
                    error: "title required",
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders list result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "list" }],
                details: {
                    action: "list",
                    tasks: [
                        {
                            id: 1,
                            title: "Task 1",
                            status: "todo",
                            links: [],
                            createdAt: 0,
                        },
                        {
                            id: 2,
                            title: "Task 2",
                            status: "done",
                            links: [],
                            createdAt: 0,
                        },
                    ],
                    nextId: 3,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders add result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "Added task #1: Test" }],
                details: {
                    action: "add",
                    tasks: [
                        {
                            id: 1,
                            title: "Test",
                            status: "todo",
                            links: [],
                            createdAt: 0,
                        },
                    ],
                    nextId: 2,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders remove result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "Removed 1 task(s)" }],
                details: {
                    action: "remove",
                    tasks: [],
                    nextId: 2,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders move result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "Moved task #1 under #2" }],
                details: {
                    action: "move",
                    tasks: [],
                    nextId: 3,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders link result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [
                    {
                        type: "text",
                        text: "Linked #1 blocks #2",
                    },
                ],
                details: {
                    action: "link",
                    tasks: [],
                    nextId: 3,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders unlink result", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [
                    {
                        type: "text",
                        text: "Unlinked #1 blocks #2",
                    },
                ],
                details: {
                    action: "unlink",
                    tasks: [],
                    nextId: 3,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders list result with parent indicator", () => {
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "list" }],
                details: {
                    action: "list",
                    tasks: [
                        {
                            id: 2,
                            title: "Nested",
                            status: "todo",
                            links: [{ targetId: 1, type: "child-of" }],
                            createdAt: 0,
                        },
                    ],
                    nextId: 3,
                },
            },
            { expanded: false },
            theme
        );
        assert.ok(result);
    });

    void it("renders expanded list", () => {
        const tasks = Array.from({ length: 7 }, (_, i) => ({
            id: i + 1,
            title: `Task ${i + 1}`,
            status: "todo" as const,
            links: [] as never[],
            createdAt: 0,
        }));
        const state = new TauState();
        const tool = captureTaskTool(state);
        const result = tool.renderResult(
            {
                content: [{ type: "text", text: "list" }],
                details: {
                    action: "list",
                    tasks,
                    nextId: 8,
                },
            },
            { expanded: true },
            theme
        );
        assert.ok(result);
    });
});
