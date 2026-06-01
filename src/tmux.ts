/**
 * Tmux utilities for the tmux-backed bash backend.
 *
 * Provides session management, window creation, output capture,
 * shell quoting, and tmux availability detection.
 *
 * Adapted from @richardgill/pi-tmux-bash (tmux-utils.ts, runtime.ts)
 * with simplifications for Tau's needs: no configurable session scoping,
 * no polling subsystem, no window option tagging.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ─── Availability ───────────────────────────────────────────────────

let cachedAvailable: boolean | undefined;

/**
 * Detect whether tmux is available on the system.
 * Result is cached for the process lifetime.
 */
export function isTmuxAvailable(): boolean {
    if (cachedAvailable !== undefined) return cachedAvailable;
    try {
        execSync("which tmux 2>/dev/null", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: "pipe",
        });
        cachedAvailable = true;
    } catch {
        cachedAvailable = false;
    }
    return cachedAvailable;
}

// ─── Shell quoting ──────────────────────────────────────────────────

/** Single-quote a value for shell embedding. Handles embedded single quotes. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ─── Session management ─────────────────────────────────────────────

/** Determine the background tmux session name for a given git root. */
export function sessionNameForGitRoot(gitRoot: string): string {
    const slug =
        gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project";
    // Include a short hash to avoid collisions between same-named directories.
    const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
    return `pi-bg-${slug}-${hash}`;
}

/** Check whether a tmux session with the given name exists. */
export function sessionExists(name: string): boolean {
    return (
        execSafe(
            `tmux has-session -t ${shellQuote(name)} 2>/dev/null && echo yes`
        ) === "yes"
    );
}

// ─── Window management ──────────────────────────────────────────────

export interface TmuxWindow {
    id: string;
    index: number;
    title: string;
}

/**
 * List windows in a tmux session.
 * Returns empty array if the session does not exist.
 */
export function listWindows(session: string): TmuxWindow[] {
    const raw = execSafe(
        `tmux list-windows -t ${shellQuote(session)} -F '#{window_id}|||#{window_index}|||#{window_name}'`
    );
    if (!raw) return [];
    return raw.split("\n").map((line) => {
        const [id, index, title] = line.split("|||");
        return {
            id: id ?? "",
            index: parseInt(index ?? "0"),
            title: title ?? "",
        };
    });
}

// ─── Process execution ──────────────────────────────────────────────

/** Execute a command synchronously, returning trimmed stdout. Returns null on failure. */
export function execSafe(cmd: string): string | null {
    try {
        return execSync(cmd, {
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

/** Execute a command synchronously. Throws on failure. */
export function exec(cmd: string): string {
    return execSync(cmd, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

// ─── Script generation ──────────────────────────────────────────────

/**
 * Create a bash wrapper script that:
 * 1. Tees output to a file
 * 2. Writes an exit-code sentinel on completion
 * 3. Stays alive as a login shell (so the tmux window doesn't close)
 *
 * Returns the script path and a unique run ID.
 */
export function createBashScript(
    runDir: string,
    session: string,
    command: string,
    paths: { id: string; outputFile: string; exitCodeFile: string }
): { scriptPath: string } {
    const scriptDir = join(runDir, "s");
    mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    chmodSync(scriptDir, 0o700);

    const scriptPath = join(scriptDir, `${session}.${paths.id}.sh`);

    const { exitCodeFile, outputFile } = paths;

    writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash
__output_file=${shellQuote(outputFile)}
__exit_code_file=${shellQuote(exitCodeFile)}
(
${command}
) >> "$__output_file" 2>&1
printf '%s\\n' "$?" > "$__exit_code_file"
`,
        { mode: 0o755 }
    );

    return { scriptPath };
}

/**
 * Spawn a command in a new tmux window.
 *
 * Returns the window ID, run ID, and output file path.
 * The exit-code sentinel file path is derived from these.
 */
export function spawnInTmux(
    command: string,
    cwd: string,
    runDir: string,
    session: string
): { windowId: string; id: string; outputFile: string; exitCodeFile: string } {
    const exists = sessionExists(session);

    // Pre-compute paths before creating the script.
    // Paths use only session + unique ID — no window ID dependency.
    // This avoids a mismatch when tmux display-message fails
    // inside detached sessions (the script used to derive paths
    // from the window ID independently, leading to empty reads).
    const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const exitCodeFile = join(runDir, `${session}.${id}.exit`);
    const outputFile = join(runDir, `${session}.${id}.out`);

    const script = createBashScript(runDir, session, command, {
        id,
        outputFile,
        exitCodeFile,
    });

    const createCmd = exists
        ? `new-window -d -t ${shellQuote(session)}`
        : `new-session -d -s ${shellQuote(session)}`;

    const windowName = command.split(/\s/)[0]?.slice(0, 30) ?? "shell";
    const windowId = exec(
        `tmux ${createCmd} -n ${shellQuote(windowName)} -c ${shellQuote(cwd)} -P -F '#{window_id}' ${shellQuote(script.scriptPath)}`
    );

    return { windowId, id, outputFile, exitCodeFile };
}

// ─── Output capture ─────────────────────────────────────────────────

/**
 * Capture the last N lines of a tmux window's pane output.
 * Falls back to tmux capture-pane when the output file is empty or missing.
 */
export function captureOutput(
    windowId: string,
    lines: number,
    outputFile?: string
): string {
    // Prefer the output file written by the wrapper script — it has the exact
    // content without tmux framing. Fall back to tmux capture-pane when the file
    // is missing or empty.
    if (outputFile && existsSync(outputFile)) {
        const content = readFileSync(outputFile, "utf-8");
        if (content.length > 0) return content;
    }
    // Fallback: capture from tmux pane.
    const raw = execSafe(
        `tmux capture-pane -t ${shellQuote(windowId)} -p -S -${lines}`
    );
    return raw ?? "(no output)";
}

// ─── Exit code detection ────────────────────────────────────────────

/**
 * Check whether a command has completed by looking for the exit-code sentinel file.
 * Returns the exit code if found, or undefined if still running.
 */
export function checkExitCode(exitCodeFile: string): number | undefined {
    if (!existsSync(exitCodeFile)) return undefined;
    const content = readFileSync(exitCodeFile, "utf-8").trim();
    const code = parseInt(content);
    if (!Number.isFinite(code)) return undefined;
    // Clean up the sentinel file.
    try {
        unlinkSync(exitCodeFile);
    } catch {
        /* already gone */
    }
    return code;
}

// ─── Kill ────────────────────────────────────────────────────────────

/** Kill a tmux window by its ID. */
export function killWindow(windowId: string): void {
    execSafe(`tmux kill-window -t ${shellQuote(windowId)}`);
}

/** Get the git root for a directory, or null if not in a git repo. */
export function getGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch {
        return null;
    }
}
