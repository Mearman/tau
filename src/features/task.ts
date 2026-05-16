/**
 * Task feature — task tool for the LLM and /tasks command for the user.
 *
 * All relationships (hierarchy, blocking, dependencies) are modelled as
 * links on the links array. Hierarchy uses "child-of" links. Tasks are
 * stored as a flat array; the tree is computed for rendering.
 */

import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import type { Task, TaskDetails, TaskLink, TaskStatus } from "../types.ts";

// ─── State reconstruction ───────────────────────────────────────────

export function reconstructTaskState(
    state: TauState,
    ctx: ExtensionContext
): void {
    state.tasks = [];
    state.nextTaskId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "task") continue;
        const details = msg.details as TaskDetails | undefined;
        if (details) {
            state.tasks = details.tasks;
            state.nextTaskId = details.nextId;
        }
    }
}

// ─── Pure domain functions ──────────────────────────────────────────

export function findTaskById(tasks: Task[], id: number): Task | undefined {
    return tasks.find((t) => t.id === id);
}

export function getParentId(tasks: Task[], taskId: number): number | undefined {
    const task = findTaskById(tasks, taskId);
    if (!task) return undefined;
    const childOfLink = task.links.find((l) => l.type === "child-of");
    return childOfLink?.targetId;
}

export function findChildIds(tasks: Task[], parentId: number): number[] {
    return tasks
        .filter((t) =>
            t.links.some(
                (l) => l.type === "child-of" && l.targetId === parentId
            )
        )
        .map((t) => t.id);
}

export function findChildTasks(tasks: Task[], parentId: number): Task[] {
    return tasks.filter((t) =>
        t.links.some((l) => l.type === "child-of" && l.targetId === parentId)
    );
}

/**
 * Returns the set of all ancestor IDs for a given task (parent,
 * grandparent, … up to root). Returns an empty set if the task
 * does not exist or has no ancestors.
 */
export function getAncestorIds(tasks: Task[], taskId: number): Set<number> {
    const ancestors = new Set<number>();
    let currentParent = getParentId(tasks, taskId);
    while (currentParent !== undefined) {
        if (ancestors.has(currentParent)) break; // cycle guard
        ancestors.add(currentParent);
        currentParent = getParentId(tasks, currentParent);
    }
    return ancestors;
}

/**
 * Returns the set of all descendant IDs (children, grandchildren, …).
 */
export function getDescendantIds(tasks: Task[], taskId: number): Set<number> {
    const descendants = new Set<number>();
    const stack = [taskId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        for (const child of findChildTasks(tasks, id)) {
            if (!descendants.has(child.id)) {
                descendants.add(child.id);
                stack.push(child.id);
            }
        }
    }
    return descendants;
}

/**
 * Checks whether making `newParentId` the parent of `taskId` would
 * create a cycle (i.e. newParentId is taskId or a descendant of it).
 */
export function wouldCreateCycle(
    tasks: Task[],
    taskId: number,
    newParentId: number | undefined
): boolean {
    if (newParentId === undefined) return false;
    if (newParentId === taskId) return true;
    return getDescendantIds(tasks, taskId).has(newParentId);
}

/**
 * Formats the task tree as an indented text representation.
 * Root tasks are listed first, then their children recursively.
 */
export function formatTaskTree(
    tasks: Task[],
    depth = 0,
    parentId: number | undefined = undefined
): string {
    const children =
        parentId === undefined
            ? tasks.filter((t) => !t.links.some((l) => l.type === "child-of"))
            : findChildTasks(tasks, parentId);
    const indent = "  ".repeat(depth);
    const lines: string[] = [];
    for (const task of children) {
        const statusIcon = statusIconFor(task.status);
        lines.push(`${indent}${statusIcon} #${task.id}: ${task.title}`);
        // Show non-hierarchy links inline
        const nonHierarchyLinks = task.links.filter(
            (l) => l.type !== "child-of"
        );
        if (nonHierarchyLinks.length > 0) {
            const linkStr = nonHierarchyLinks
                .map((l) => `${l.type} #${l.targetId}`)
                .join(", ");
            lines.push(`${indent}  ↳ ${linkStr}`);
        }
        lines.push(formatTaskTree(tasks, depth + 1, task.id));
    }
    return lines.filter(Boolean).join("\n");
}

function statusIconFor(status: TaskStatus): string {
    switch (status) {
        case "todo":
            return "○";
        case "in-progress":
            return "◐";
        case "done":
            return "✓";
        case "blocked":
            return "✗";
        case "cancelled":
            return "⊘";
    }
}

// ─── Task list UI component ─────────────────────────────────────────

export class TaskListComponent {
    private list: Task[];
    private theme: {
        fg(colour: string, text: string): string;
        bold(text: string): string;
        strikethrough(text: string): string;
    };
    private onClose: () => void;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(
        tasks: Task[],
        theme: {
            fg(colour: string, text: string): string;
            bold(text: string): string;
            strikethrough(text: string): string;
        },
        onClose: () => void
    ) {
        this.list = tasks;
        this.theme = theme;
        this.onClose = onClose;
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
            this.onClose();
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width)
            return this.cachedLines;

        const lines: string[] = [];
        const th = this.theme;

        lines.push("");
        const title = th.fg("accent", " Tasks ");
        const headerLine =
            th.fg("borderMuted", "─".repeat(3)) +
            title +
            th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
        lines.push(truncateToWidth(headerLine, width));
        lines.push("");

        if (this.list.length === 0) {
            lines.push(
                truncateToWidth(
                    `  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`,
                    width
                )
            );
        } else {
            const done = this.list.filter((t) => t.status === "done").length;
            const total = this.list.length;
            lines.push(
                truncateToWidth(
                    `  ${th.fg("muted", `${done}/${total} completed`)}`,
                    width
                )
            );
            lines.push("");

            this.renderTree(this.list, undefined, 0, width, lines);
        }

        lines.push("");
        lines.push(
            truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width)
        );
        lines.push("");

        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    private renderTree(
        tasks: Task[],
        parentId: number | undefined,
        depth: number,
        width: number,
        lines: string[]
    ): void {
        const th = this.theme;
        const children =
            parentId === undefined
                ? tasks.filter(
                      (t) => !t.links.some((l) => l.type === "child-of")
                  )
                : findChildTasks(tasks, parentId);
        const indent = "  ".repeat(depth + 1);

        for (const task of children) {
            const icon = this.statusIcon(task.status, th);
            const id = th.fg("accent", `#${task.id}`);
            const title =
                task.status === "done"
                    ? th.fg("dim", task.title)
                    : task.status === "cancelled"
                      ? th.fg("dim", th.strikethrough(task.title))
                      : th.fg("text", task.title);

            lines.push(
                truncateToWidth(`${indent}${icon} ${id} ${title}`, width)
            );

            // Show non-hierarchy links
            const nonHierarchyLinks = task.links.filter(
                (l) => l.type !== "child-of"
            );
            if (nonHierarchyLinks.length > 0) {
                const linkStr = nonHierarchyLinks
                    .map(
                        (l) => `${l.type}→${th.fg("accent", "#" + l.targetId)}`
                    )
                    .join(" ");
                lines.push(
                    truncateToWidth(
                        `${indent}  ${th.fg("dim", linkStr)}`,
                        width
                    )
                );
            }

            this.renderTree(tasks, task.id, depth + 1, width, lines);
        }
    }

    private statusIcon(
        status: TaskStatus,
        th: { fg(colour: string, text: string): string }
    ): string {
        switch (status) {
            case "todo":
                return th.fg("dim", "○");
            case "in-progress":
                return th.fg("warning", "◐");
            case "done":
                return th.fg("success", "✓");
            case "blocked":
                return th.fg("error", "✗");
            case "cancelled":
                return th.fg("dim", "⊘");
        }
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}

// ─── Tool parameter schema ──────────────────────────────────────────

const TaskParams = Type.Object({
    action: StringEnum([
        "list",
        "add",
        "update",
        "remove",
        "move",
        "link",
        "unlink",
    ] as const),
    title: Type.Optional(
        Type.String({ description: "Task title (for add, update)" })
    ),
    description: Type.Optional(
        Type.String({ description: "Task description (for add, update)" })
    ),
    status: Type.Optional(
        StringEnum(
            ["todo", "in-progress", "done", "blocked", "cancelled"] as const,
            { description: "Task status (for add, update)" }
        )
    ),
    id: Type.Optional(
        Type.Number({
            description: "Task ID (for update, remove, move, link, unlink)",
        })
    ),
    parent: Type.Optional(
        Type.Number({
            description: "Parent task ID (for add, move). Omit for root.",
        })
    ),
    from: Type.Optional(
        Type.Number({ description: "Source task ID (for link, unlink)" })
    ),
    to: Type.Optional(
        Type.Number({ description: "Target task ID (for link, unlink)" })
    ),
    linkWith: Type.Optional(
        Type.Number({
            description:
                "Other task ID to link with on creation (for add). " +
                "Direction is set by linkDirection.",
        })
    ),
    linkDirection: Type.Optional(
        StringEnum(["from", "to"] as const, {
            description:
                "Link direction for add with linkWith. " +
                '"from": new task is the source (new→target). ' +
                '"to": new task is the target (other→new). ' +
                'Default: "from".',
        })
    ),
    type: Type.Optional(
        StringEnum(["blocks", "depends-on", "related", "child-of"] as const, {
            description: "Link type (for link, add with linkWith)",
        })
    ),
    cascade: Type.Optional(
        Type.Boolean({
            description:
                "Also remove children when removing a task (default: false)",
        })
    ),
});

// ─── Result renderer ────────────────────────────────────────────────

// Colours used by taskRenderResult. Theme.fg accepts ThemeColor (a wider
// union) so Theme is assignable to this narrower type by contravariance.
type TaskThemeColour =
    | "accent"
    | "dim"
    | "error"
    | "muted"
    | "success"
    | "warning";

export function taskRenderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: {
        fg: (colour: TaskThemeColour, text: string) => string;
        bold: (text: string) => string;
    }
) {
    const { expanded } = options;
    const details = result.details as TaskDetails | undefined;
    if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
    }
    if (details.error)
        return new Text(theme.fg("error", "Error: " + details.error), 0, 0);

    switch (details.action) {
        case "list": {
            const taskList = details.tasks;
            if (taskList.length === 0)
                return new Text(theme.fg("dim", "No tasks"), 0, 0);
            let listText = theme.fg(
                "muted",
                String(taskList.length) + " task(s):"
            );
            const display = expanded ? taskList : taskList.slice(0, 5);
            for (const t of display) {
                const icon =
                    t.status === "done"
                        ? theme.fg("success", "✓")
                        : t.status === "in-progress"
                          ? theme.fg("warning", "◐")
                          : t.status === "blocked"
                            ? theme.fg("error", "✗")
                            : theme.fg("dim", "○");
                const title =
                    t.status === "done"
                        ? theme.fg("dim", t.title)
                        : theme.fg("muted", t.title);
                const taskParentId = t.links.find(
                    (l) => l.type === "child-of"
                )?.targetId;
                const parentStr = taskParentId
                    ? ` ${theme.fg("dim", "↰ #" + taskParentId)}`
                    : "";
                listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${title}${parentStr}`;
            }
            if (!expanded && taskList.length > 5) {
                listText += `\n${theme.fg("dim", `... ${taskList.length - 5} more`)}`;
            }
            return new Text(listText, 0, 0);
        }
        case "add": {
            const added = details.tasks.find(
                (t) => t.id === details.nextId - 1
            );
            return new Text(
                theme.fg("success", "✓ Added ") +
                    theme.fg("accent", `#${added?.id ?? "?"}`) +
                    " " +
                    theme.fg("muted", added?.title ?? ""),
                0,
                0
            );
        }
        case "update": {
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg(
                        "muted",
                        result.content[0]?.type === "text"
                            ? result.content[0].text
                            : ""
                    ),
                0,
                0
            );
        }
        case "remove": {
            const text = result.content[0];
            const msg = text?.type === "text" ? text.text : "";
            return new Text(
                theme.fg("success", "✓ ") + theme.fg("muted", msg),
                0,
                0
            );
        }
        case "move": {
            const text = result.content[0];
            const msg = text?.type === "text" ? text.text : "";
            return new Text(
                theme.fg("success", "✓ ") + theme.fg("muted", msg),
                0,
                0
            );
        }
        case "link": {
            const text = result.content[0];
            const msg = text?.type === "text" ? text.text : "";
            return new Text(
                theme.fg("success", "✓ ") + theme.fg("muted", msg),
                0,
                0
            );
        }
        case "unlink": {
            const text = result.content[0];
            const msg = text?.type === "text" ? text.text : "";
            return new Text(
                theme.fg("success", "✓ ") + theme.fg("muted", msg),
                0,
                0
            );
        }
        default: {
            const text = result.content[0];
            const msg = text?.type === "text" ? text.text : "";
            return new Text(theme.fg("muted", msg), 0, 0);
        }
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerTask(pi: ExtensionAPI, state: TauState): void {
    pi.registerTool({
        name: "task",
        label: "Task",
        description:
            "Manage tasks with nesting, relationships, and status tracking. " +
            "Actions: list, add (title, parent?, status?), update (id, title?, " +
            "description?, status?), remove (id, cascade?), move (id, parent?), " +
            "link (from, to, type), unlink (from, to)",
        parameters: TaskParams,

        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            switch (params.action) {
                case "list":
                    return handleList(state);
                case "add":
                    return handleAdd(state, params);
                case "update":
                    return handleUpdate(state, params);
                case "remove":
                    return handleRemove(state, params);
                case "move":
                    return handleMove(state, params);
                case "link":
                    return handleLink(state, params);
                case "unlink":
                    return handleUnlink(state, params);
                default:
                    return errorResult(state, "unknown task action");
            }
        },

        renderCall(args, theme) {
            let text =
                theme.fg("toolTitle", theme.bold("task ")) +
                theme.fg("muted", args.action);
            if (typeof args.title === "string") {
                text += " " + theme.fg("dim", '"' + args.title + '"');
            }
            if (typeof args.id === "number") {
                text += " " + theme.fg("accent", "#" + args.id);
            }
            if (typeof args.from === "number" && typeof args.to === "number") {
                text +=
                    " " +
                    theme.fg("accent", "#" + args.from) +
                    "→" +
                    theme.fg("accent", "#" + args.to);
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, options, theme) {
            return taskRenderResult(result, options, theme);
        },
    });

    pi.registerCommand("tasks", {
        description: "Show all tasks on the current branch",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/tasks requires interactive mode", "error");
                return;
            }
            await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
                return new TaskListComponent(state.tasks, theme, () => {
                    done();
                });
            });
        },
    });
}

// ─── Action handlers ────────────────────────────────────────────────

function handleList(state: TauState) {
    const tasks = state.tasks;
    return {
        content: [
            {
                type: "text" as const,
                text: tasks.length ? formatTaskTree(tasks) : "No tasks",
            },
        ],
        details: {
            action: "list" as const,
            tasks: [...tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleAdd(
    state: TauState,
    params: {
        title?: string;
        description?: string;
        parent?: number;
        status?: string;
        linkWith?: number;
        linkDirection?: string;
        type?: string;
    }
) {
    if (!params.title) return errorResult(state, "title required for add");

    // Validate parent exists
    if (params.parent !== undefined) {
        const parent = findTaskById(state.tasks, params.parent);
        if (!parent)
            return errorResult(state, `parent #${params.parent} not found`);
    }

    const status = (params.status as TaskStatus) ?? "todo";
    if (
        !["todo", "in-progress", "done", "blocked", "cancelled"].includes(
            status
        )
    )
        return errorResult(state, `invalid status: ${status}`);

    const newTask: Task = {
        id: state.nextTaskId++,
        title: params.title,
        ...(params.description ? { description: params.description } : {}),
        status,
        links: [],
        createdAt: Date.now(),
    };

    // Establish hierarchy via child-of link
    if (params.parent !== undefined) {
        newTask.links.push({ targetId: params.parent, type: "child-of" });
    }

    state.tasks.push(newTask);

    // Optionally link with another task on creation
    if (params.linkWith !== undefined) {
        const other = findTaskById(state.tasks, params.linkWith);
        if (!other) {
            // Roll back the add — the link target doesn't exist
            state.tasks.pop();
            state.nextTaskId--;
            return errorResult(
                state,
                `link target #${params.linkWith} not found`
            );
        }

        const linkType = (params.type ?? "related") as TaskLink["type"];
        if (
            !["blocks", "depends-on", "related", "child-of"].includes(linkType)
        ) {
            state.tasks.pop();
            state.nextTaskId--;
            return errorResult(state, `invalid link type: ${params.type}`);
        }

        const direction = params.linkDirection ?? "from";

        if (direction === "from") {
            // new task is the source: new→other
            newTask.links.push({ targetId: params.linkWith, type: linkType });
        } else {
            // new task is the target: other→new
            other.links.push({ targetId: newTask.id, type: linkType });
        }
    }

    const linkSuffix =
        params.linkWith !== undefined
            ? params.linkDirection === "to"
                ? ` (#${params.linkWith} ${params.type ?? "related"}→#${newTask.id})`
                : ` (#${newTask.id} ${params.type ?? "related"}→#${params.linkWith})`
            : "";

    return {
        content: [
            {
                type: "text" as const,
                text: `Added task #${newTask.id}: ${newTask.title}${linkSuffix}`,
            },
        ],
        details: {
            action: "add" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleUpdate(
    state: TauState,
    params: {
        id?: number;
        title?: string;
        description?: string;
        status?: string;
    }
) {
    if (params.id === undefined)
        return errorResult(state, "id required for update");

    const task = findTaskById(state.tasks, params.id);
    if (!task) return errorResult(state, `task #${params.id} not found`);

    if (params.title !== undefined) task.title = params.title;
    if (params.description !== undefined) task.description = params.description;
    if (params.status !== undefined) {
        const status = params.status as TaskStatus;
        if (
            !["todo", "in-progress", "done", "blocked", "cancelled"].includes(
                status
            )
        )
            return errorResult(state, `invalid status: ${status}`);
        task.status = status;
    }

    return {
        content: [
            {
                type: "text" as const,
                text: `Updated task #${task.id}`,
            },
        ],
        details: {
            action: "update" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleRemove(
    state: TauState,
    params: { id?: number; cascade?: boolean }
) {
    if (params.id === undefined)
        return errorResult(state, "id required for remove");

    const task = findTaskById(state.tasks, params.id);
    if (!task) return errorResult(state, `task #${params.id} not found`);

    const cascade = params.cascade ?? false;
    const descendants = getDescendantIds(state.tasks, params.id);
    const childCount = findChildIds(state.tasks, params.id).length;

    if (childCount > 0 && !cascade)
        return errorResult(
            state,
            `task #${params.id} has ${childCount} child(ren). Use cascade: true to remove them too, or move them first.`
        );

    const removeIds = cascade
        ? new Set([params.id, ...descendants])
        : new Set([params.id]);

    // If not cascading, orphan the children (reparent to task's parent or root)
    if (!cascade) {
        const taskParentId = getParentId(state.tasks, params.id);
        for (const t of state.tasks) {
            const childLink = t.links.find(
                (l) => l.type === "child-of" && l.targetId === params.id
            );
            if (childLink) {
                if (taskParentId !== undefined) {
                    childLink.targetId = taskParentId;
                } else {
                    t.links = t.links.filter((l) => l !== childLink);
                }
            }
        }
    }

    // Remove all links pointing to removed tasks
    const removedCount = removeIds.size;
    state.tasks = state.tasks.filter((t) => !removeIds.has(t.id));
    for (const t of state.tasks) {
        t.links = t.links.filter((l) => !removeIds.has(l.targetId));
    }

    return {
        content: [
            {
                type: "text" as const,
                text: `Removed ${removedCount} task(s)`,
            },
        ],
        details: {
            action: "remove" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleMove(state: TauState, params: { id?: number; parent?: number }) {
    if (params.id === undefined)
        return errorResult(state, "id required for move");

    const task = findTaskById(state.tasks, params.id);
    if (!task) return errorResult(state, `task #${params.id} not found`);

    const newParent = params.parent; // undefined = move to root

    if (newParent !== undefined) {
        const parent = findTaskById(state.tasks, newParent);
        if (!parent)
            return errorResult(state, `parent #${newParent} not found`);
    }

    if (wouldCreateCycle(state.tasks, params.id, newParent))
        return errorResult(state, "move would create a cycle");

    // Update or create/remove the child-of link
    const existingLink = task.links.find((l) => l.type === "child-of");
    if (newParent !== undefined) {
        if (existingLink) {
            existingLink.targetId = newParent;
        } else {
            task.links.push({ targetId: newParent, type: "child-of" });
        }
    } else {
        // Move to root — remove the child-of link
        if (existingLink) {
            task.links = task.links.filter((l) => l !== existingLink);
        }
    }

    return {
        content: [
            {
                type: "text" as const,
                text:
                    newParent !== undefined
                        ? `Moved task #${params.id} under #${newParent}`
                        : `Moved task #${params.id} to root`,
            },
        ],
        details: {
            action: "move" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleLink(
    state: TauState,
    params: { from?: number; to?: number; type?: string }
) {
    if (params.from === undefined || params.to === undefined)
        return errorResult(state, "from and to required for link");
    if (params.from === params.to)
        return errorResult(state, "cannot link a task to itself");

    const fromTask = findTaskById(state.tasks, params.from);
    if (!fromTask) return errorResult(state, `task #${params.from} not found`);

    const toTask = findTaskById(state.tasks, params.to);
    if (!toTask) return errorResult(state, `task #${params.to} not found`);

    const linkType = params.type as TaskLink["type"];
    if (
        !linkType ||
        !["blocks", "depends-on", "related", "child-of"].includes(linkType)
    )
        return errorResult(
            state,
            `invalid link type: ${params.type ?? "(missing)"}`
        );

    // Check for duplicate link
    const existing = fromTask.links.find(
        (l) => l.targetId === params.to && l.type === linkType
    );
    if (existing)
        return errorResult(
            state,
            `link already exists: #${params.from} ${linkType} #${params.to}`
        );

    fromTask.links.push({ targetId: params.to, type: linkType });

    return {
        content: [
            {
                type: "text" as const,
                text: `Linked #${params.from} ${linkType} #${params.to}`,
            },
        ],
        details: {
            action: "link" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

function handleUnlink(state: TauState, params: { from?: number; to?: number }) {
    if (params.from === undefined || params.to === undefined)
        return errorResult(state, "from and to required for unlink");

    const fromTask = findTaskById(state.tasks, params.from);
    if (!fromTask) return errorResult(state, `task #${params.from} not found`);

    const linkIndex = fromTask.links.findIndex((l) => l.targetId === params.to);
    if (linkIndex === -1)
        return errorResult(
            state,
            `no link from #${params.from} to #${params.to}`
        );

    const removed = fromTask.links.splice(linkIndex, 1)[0];

    return {
        content: [
            {
                type: "text" as const,
                text: `Unlinked #${params.from} ${removed.type} #${params.to}`,
            },
        ],
        details: {
            action: "unlink" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
        },
    };
}

// ─── Shared helpers ─────────────────────────────────────────────────

function errorResult(state: TauState, error: string) {
    return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        details: {
            action: "list" as const,
            tasks: [...state.tasks],
            nextId: state.nextTaskId,
            error,
        },
    };
}
