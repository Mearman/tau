/**
 * Todo feature — todo tool for the LLM and /todos command for the user.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TauState } from "../state.js";
import type { Todo, TodoDetails } from "../types.js";

// ─── State reconstruction ───────────────────────────────────────────

export function reconstructTodoState(
    state: TauState,
    ctx: ExtensionContext
): void {
    state.todos = [];
    state.nextTodoId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
        const details = msg.details as TodoDetails | undefined;
        if (details) {
            state.todos = details.todos;
            state.nextTodoId = details.nextId;
        }
    }
}

// ─── Todo list UI component ─────────────────────────────────────────

class TodoListComponent {
    private list: Todo[];
    private theme: {
        fg(colour: string, text: string): string;
        bold(text: string): string;
        strikethrough(text: string): string;
    };
    private onClose: () => void;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(
        todos: Todo[],
        theme: {
            fg(colour: string, text: string): string;
            bold(text: string): string;
            strikethrough(text: string): string;
        },
        onClose: () => void
    ) {
        this.list = todos;
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
        const title = th.fg("accent", " Todos ");
        const headerLine =
            th.fg("borderMuted", "─".repeat(3)) +
            title +
            th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
        lines.push(truncateToWidth(headerLine, width));
        lines.push("");

        if (this.list.length === 0) {
            lines.push(
                truncateToWidth(
                    `  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`,
                    width
                )
            );
        } else {
            const done = this.list.filter((t) => t.done).length;
            const total = this.list.length;
            lines.push(
                truncateToWidth(
                    `  ${th.fg("muted", `${done}/${total} completed`)}`,
                    width
                )
            );
            lines.push("");

            for (const todo of this.list) {
                const check = todo.done
                    ? th.fg("success", "✓")
                    : th.fg("dim", "○");
                const id = th.fg("accent", `#${todo.id}`);
                const text = todo.done
                    ? th.fg("dim", todo.text)
                    : th.fg("text", todo.text);
                lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
            }
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

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerTodo(pi: ExtensionAPI, state: TauState): void {
    const TodoParams = Type.Object({
        action: StringEnum(["list", "add", "toggle", "clear"] as const),
        text: Type.Optional(
            Type.String({ description: "Todo text (for add)" })
        ),
        id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
    });

    pi.registerTool({
        name: "todo",
        label: "Todo",
        description:
            "Manage a todo list. Actions: list, add (text), toggle (id), clear",
        parameters: TodoParams,

        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            switch (params.action) {
                case "list":
                    return {
                        content: [
                            {
                                type: "text",
                                text: state.todos.length
                                    ? state.todos
                                          .map(
                                              (t) =>
                                                  `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`
                                          )
                                          .join("\n")
                                    : "No todos",
                            },
                        ],
                        details: {
                            action: "list",
                            todos: [...state.todos],
                            nextId: state.nextTodoId,
                        },
                    };

                case "add": {
                    if (!params.text) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Error: text required for add",
                                },
                            ],
                            details: {
                                action: "add",
                                todos: [...state.todos],
                                nextId: state.nextTodoId,
                                error: "text required",
                            },
                        };
                    }
                    const newTodo: Todo = {
                        id: state.nextTodoId++,
                        text: params.text,
                        done: false,
                    };
                    state.todos.push(newTodo);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Added todo #${newTodo.id}: ${newTodo.text}`,
                            },
                        ],
                        details: {
                            action: "add",
                            todos: [...state.todos],
                            nextId: state.nextTodoId,
                        },
                    };
                }

                case "toggle": {
                    if (params.id === undefined) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Error: id required for toggle",
                                },
                            ],
                            details: {
                                action: "toggle",
                                todos: [...state.todos],
                                nextId: state.nextTodoId,
                                error: "id required",
                            },
                        };
                    }
                    const todo = state.todos.find((t) => t.id === params.id);
                    if (!todo) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Todo #${params.id} not found`,
                                },
                            ],
                            details: {
                                action: "toggle",
                                todos: [...state.todos],
                                nextId: state.nextTodoId,
                                error: `#${params.id} not found`,
                            },
                        };
                    }
                    todo.done = !todo.done;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
                            },
                        ],
                        details: {
                            action: "toggle",
                            todos: [...state.todos],
                            nextId: state.nextTodoId,
                        },
                    };
                }

                case "clear": {
                    const count = state.todos.length;
                    state.todos = [];
                    state.nextTodoId = 1;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Cleared ${count} todos`,
                            },
                        ],
                        details: {
                            action: "clear",
                            todos: [],
                            nextId: 1,
                        },
                    };
                }

                default:
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Unknown todo action",
                            },
                        ],
                        details: {
                            action: "list",
                            todos: [...state.todos],
                            nextId: state.nextTodoId,
                            error: "unknown todo action",
                        },
                    };
            }
        },

        renderCall(args, theme) {
            let text =
                theme.fg("toolTitle", theme.bold("todo ")) +
                theme.fg("muted", args.action);
            if (typeof args.text === "string") {
                text += " " + theme.fg("dim", '"' + args.text + '"');
            }
            if (typeof args.id === "number") {
                text += " " + theme.fg("accent", "#" + args.id);
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as TodoDetails | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }
            if (details.error)
                return new Text(
                    theme.fg("error", "Error: " + details.error),
                    0,
                    0
                );

            switch (details.action) {
                case "list": {
                    const todoList = details.todos;
                    if (todoList.length === 0)
                        return new Text(theme.fg("dim", "No todos"), 0, 0);
                    let listText = theme.fg(
                        "muted",
                        String(todoList.length) + " todo(s):"
                    );
                    const display = expanded ? todoList : todoList.slice(0, 5);
                    for (const t of display) {
                        const check = t.done
                            ? theme.fg("success", "✓")
                            : theme.fg("dim", "○");
                        const itemText = t.done
                            ? theme.fg("dim", t.text)
                            : theme.fg("muted", t.text);
                        listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
                    }
                    if (!expanded && todoList.length > 5) {
                        listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
                    }
                    return new Text(listText, 0, 0);
                }
                case "add": {
                    const added = details.todos[details.todos.length - 1];
                    return new Text(
                        theme.fg("success", "✓ Added ") +
                            theme.fg("accent", `#${added.id}`) +
                            " " +
                            theme.fg("muted", added.text),
                        0,
                        0
                    );
                }
                case "toggle": {
                    const text = result.content[0];
                    const msg = text?.type === "text" ? text.text : "";
                    return new Text(
                        theme.fg("success", "✓ ") + theme.fg("muted", msg),
                        0,
                        0
                    );
                }
                case "clear":
                    return new Text(
                        theme.fg("success", "✓ ") +
                            theme.fg("muted", "Cleared all todos"),
                        0,
                        0
                    );
            }
        },
    });

    pi.registerCommand("todos", {
        description: "Show all todos on the current branch",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/todos requires interactive mode", "error");
                return;
            }
            await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
                return new TodoListComponent(state.todos, theme, () => {
                    done();
                });
            });
        },
    });
}
