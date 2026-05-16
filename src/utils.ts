/**
 * Shared utility functions for the Tau extension.
 */

import { execFile } from "node:child_process";
import {
    closeSync,
    openSync,
    readdirSync,
    readSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import type { BackgroundJob, JobStatus } from "./types.ts";

// ─── Configuration constants ────────────────────────────────────────

/** Default timeout for foreground bash commands (15s, matching Claude Code). */
export const DEFAULT_TIMEOUT_MS = 15_000;
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_OUTPUT_PREVIEW_CHARS = 12_000;
/** Maximum log file size before the stall watchdog kills the job. */
export const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MiB
export const NOTIFICATION_BODY_MAX = 200;

// ─── Plan mode tools ────────────────────────────────────────────────

export const PLAN_MODE_TOOLS = [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
];
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// ─── Process management ─────────────────────────────────────────────

/** Kill an entire process group. Requires the child to have been spawned
 *  with `detached: true` so it became a process group leader. */
export function killProcessGroup(
    pid: number,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // Process group kill failed — try just the parent.
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

// ─── Job helpers ────────────────────────────────────────────────────

export function generateJobId(
    counter: number,
    pid: number = process.pid
): string {
    return `job-${pid}-${counter}`;
}

export function logPathForJob(jobId: string): string {
    return `/tmp/pi-bg-${jobId}.log`;
}

export function createJobDonePromise(job: BackgroundJob): void {
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

export function markJobTerminal(
    job: BackgroundJob,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

export function formatJobLine(job: BackgroundJob): string {
    const duration = formatDuration(Date.now() - job.startTime);
    const status =
        job.status === "running"
            ? `⏳ running (${duration})`
            : job.status === "completed"
              ? "✅ completed"
              : job.status === "failed"
                ? "❌ failed"
                : "🛑 killed";
    return `${job.id}: ${job.command.slice(0, 80)} - ${status}`;
}

// ─── Output reading ─────────────────────────────────────────────────

export async function readOutputTail(
    path: string,
    maxChars: number
): Promise<string> {
    try {
        const content = await readFile(path, "utf-8");
        if (content.length <= maxChars) return content;
        return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
    } catch {
        return "(no output yet)";
    }
}

export function readOutputTailSync(path: string, maxChars: number): string {
    try {
        const { size } = statSync(path);
        if (size === 0) return "(no output yet)";
        const fd = openSync(path, "r");
        try {
            const readStart = Math.max(0, size - maxChars);
            const toRead = Math.min(size, maxChars);
            const buf = Buffer.alloc(toRead);
            readSync(fd, buf, 0, toRead, readStart);
            const content = buf.toString("utf-8", 0, toRead);
            if (size <= maxChars) return content;
            return `...[truncated, showing last ${maxChars} chars]\n${content}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return "(no output yet)";
    }
}

// ─── Stall detection ────────────────────────────────────────────────

/** Interactive-prompt patterns at the end of output that suggest a command is
 *  blocked waiting for keyboard input. */
const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// ─── Log file cleanup ──────────────────────────────────────────────

/** Remove stale /tmp/pi-bg-* log files older than 24 hours. */
export function cleanupStaleLogs(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    try {
        const entries = readdirSync("/tmp");
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.startsWith("pi-bg-")) continue;
            const filePath = `/tmp/${entry}`;
            try {
                const { mtimeMs } = statSync(filePath);
                if (now - mtimeMs > MAX_AGE_MS) {
                    unlinkSync(filePath);
                }
            } catch {
                /* file already gone */
            }
        }
    } catch {
        /* /tmp not accessible */
    }
}

// ─── Terminal notifications ─────────────────────────────────────────

function windowsToastScript(title: string, body: string): string {
    const type = "Windows.UI.Notifications";
    const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
    const template = `[${type}.ToastTemplateType]::ToastText01`;
    const toast = `[${type}.ToastNotification]::new($xml)`;
    return [
        `${mgr} > $null`,
        `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
        `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
        `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
    ].join("; ");
}

export function notify(
    title: string,
    body: string,
    persistent?: boolean
): void {
    if (process.env.WT_SESSION) {
        execFile("powershell.exe", [
            "-NoProfile",
            "-Command",
            windowsToastScript(title, body),
        ]);
    } else if (process.env.KITTY_WINDOW_ID) {
        const urgency = persistent ? "1" : "0";
        process.stdout.write(`\x1b]99;i=1:d=${urgency};${title}\x1b\\`);
        process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
    } else {
        process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
    }
}

// ─── Notification helpers ───────────────────────────────────────────

export function truncateNotificationBody(text: string): string {
    const firstLine = text.split("\n")[0] ?? "";
    if (firstLine.length <= NOTIFICATION_BODY_MAX) return firstLine;
    return firstLine.slice(0, NOTIFICATION_BODY_MAX - 1) + "…";
}

/** Extract the last assistant text from the message history. */
export function lastAssistantText(
    messages: {
        role: string;
        content?: string | { type: string; text?: string }[];
    }[]
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                    return block.text;
                }
            }
        }
    }
    return undefined;
}

// ─── DnD check ──────────────────────────────────────────────────────

/** Check macOS system Do Not Disturb / Focus mode using notifyutil. */
export async function isSystemDndActive(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    return new Promise((resolve) => {
        execFile(
            "notifyutil",
            ["-g", "com.apple.notificationcenterui.dnd"],
            { timeout: 2000 },
            (err, stdout) => {
                if (err) {
                    resolve(false);
                    return;
                }
                const match = stdout.match(/\d+$/);
                resolve(match ? match[0] === "1" : false);
            }
        );
    });
}
