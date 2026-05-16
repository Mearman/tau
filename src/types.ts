/**
 * Shared type definitions for Tau extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ─── Background jobs ────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundJob {
    id: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    /** True once the agent has consumed output via attach — suppresses completion notification. */
    outputConsumed?: boolean;
}

export interface RunningProcess {
    toolCallId: string;
    proc: ChildProcess;
    command: string;
    backgrounded: boolean;
    /** Accumulated foreground output (before backgrounding). */
    output: string;
    /** Listener references so they can be removed on background. */
    stdoutListener?: (data: Buffer) => void;
    stderrListener?: (data: Buffer) => void;
    /** Log file stream, created when the process is backgrounded. */
    logStream?: ReturnType<typeof import("node:fs").createWriteStream>;
    resolve?: (result: AgentToolResult<unknown>) => void;
    reject?: (error: Error) => void;
}

// ─── Minimal context interfaces ─────────────────────────────────────

export interface UiContext {
    ui: {
        notify(
            message: string,
            level?: "info" | "success" | "warning" | "error"
        ): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

// ─── Task ───────────────────────────────────────────────────────────

export type TaskStatus =
    | "todo"
    | "in-progress"
    | "done"
    | "blocked"
    | "cancelled";

export type LinkType = "blocks" | "depends-on" | "related";

export interface TaskLink {
    targetId: number;
    type: LinkType;
}

export interface Task {
    id: number;
    title: string;
    description?: string;
    status: TaskStatus;
    parentId?: number;
    links: TaskLink[];
    createdAt: number;
}

export interface TaskDetails {
    action: "list" | "add" | "update" | "remove" | "move" | "link" | "unlink";
    tasks: Task[];
    nextId: number;
    error?: string;
}
