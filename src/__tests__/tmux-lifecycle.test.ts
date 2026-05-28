/**
 * Integration tests for tmux window lifecycle.
 *
 * These tests require tmux to be installed and create actual tmux sessions.
 * They verify that windows are cleaned up after command completion and
 * that sessions are properly managed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import {
    killWindow,
    sessionExists,
    spawnInTmux,
    captureOutput,
} from "../tmux.ts";

// ─── Test helpers ────────────────────────────────────────────────────

const TEST_SESSION = "pi-test-lifecycle";
const TEST_RUN_DIR = `/tmp/pi-test-lifecycle-${process.pid}`;

function cleanup(): void {
    try {
        killWindow(TEST_SESSION);
    } catch {
        /* already gone */
    }
    // Force-kill the session if it still exists
    try {
        execSync(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null`);
    } catch {
        /* already gone */
    }
    try {
        rmSync(TEST_RUN_DIR, { recursive: true, force: true });
    } catch {
        /* already gone */
    }
}

import { execSync } from "node:child_process";

/** Poll for an exit-code sentinel file to appear. */
async function waitForExitCode(
    exitCodeFile: string,
    timeoutMs = 5_000
): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(exitCodeFile)) {
            const content = readFileSync(exitCodeFile, "utf-8").trim();
            return parseInt(content);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${exitCodeFile}`);
}

// ─── Tests ───────────────────────────────────────────────────────────

void describe("tmux window lifecycle", { concurrency: 1 }, () => {
    beforeEach(() => {
        cleanup();
        mkdirSync(TEST_RUN_DIR, { recursive: true });
    });
    afterEach(() => {
        cleanup();
    });

    void it("session auto-destroys when command script exits", async () => {
        const result = spawnInTmux(
            "echo hello",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );

        // Wait for the script to finish
        await waitForExitCode(result.exitCodeFile);

        // Give tmux a moment to destroy the session
        await new Promise((r) => setTimeout(r, 300));

        // Session should be auto-destroyed (no remaining windows)
        assert.ok(
            !sessionExists(TEST_SESSION),
            "session should auto-destroy when command exits"
        );
    });

    void it("session persists while command is still running", async () => {
        const result = spawnInTmux(
            "sleep 5",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );

        // Don't wait for completion — just check the session is alive
        await new Promise((r) => setTimeout(r, 200));

        assert.ok(
            sessionExists(TEST_SESSION),
            "session should exist while command is running"
        );

        // Clean up
        killWindow(result.windowId);
        await new Promise((r) => setTimeout(r, 200));
    });

    void it("captures output from completed command", async () => {
        const result = spawnInTmux(
            "echo captured-output",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );
        await waitForExitCode(result.exitCodeFile);

        const output = readFileSync(result.outputFile, "utf-8");
        assert.ok(
            output.includes("captured-output"),
            `output file should contain command output, got: ${output}`
        );
    });

    void it("reports non-zero exit code for failed commands", async () => {
        const result = spawnInTmux(
            "exit 42",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );
        const code = await waitForExitCode(result.exitCodeFile);
        assert.equal(code, 42, "exit code should be 42");
    });

    void it("output file path does not contain window ID", () => {
        // The output and exit-code file paths must be pre-computed
        // and NOT depend on the window ID. If they contain the window
        // ID (e.g. @0, @1), the script's tmux display-message can
        // fail inside detached sessions and write to a different path
        // than JS reads from.
        const result = spawnInTmux(
            "echo path-test",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );

        // Path should not contain window ID patterns like @0, @1, @2 etc.
        const windowIdPattern = /\.@\d+\./;
        assert.ok(
            !windowIdPattern.test(result.outputFile),
            `outputFile should not contain window ID: ${result.outputFile}`
        );
        assert.ok(
            !windowIdPattern.test(result.exitCodeFile),
            `exitCodeFile should not contain window ID: ${result.exitCodeFile}`
        );

        // Clean up
        killWindow(result.windowId);
    });

    void it("captures output when tmux display-message fails in script", async () => {
        // Simulate the real-world failure: the script runs inside a
        // detached tmux session where tmux display-message may not
        // work. The output file path must be passed to the script,
        // not derived from tmux display-message inside it.
        //
        // We test this by verifying the output file at the JS-expected
        // path contains the command output even though the script
        // has no access to TMUX_PANE (detached, no client).
        const result = spawnInTmux(
            // Unset TMUX_PANE to simulate the failure case
            "unset TMUX_PANE; echo fallback-test",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );

        await waitForExitCode(result.exitCodeFile);

        // The JS-expected output file must contain the output
        const output = readFileSync(result.outputFile, "utf-8");
        assert.ok(
            output.includes("fallback-test"),
            `output file should contain command output even without TMUX_PANE, got: ${output}`
        );

        // Clean up
        killWindow(result.windowId);
    });

    void it("captureOutput reads from file when it has content", async () => {
        // When the output file has content, captureOutput must
        // return it (not fall back to tmux scrollback).
        // This is the primary path for foreground completion.
        const result = spawnInTmux(
            "echo file-has-content",
            "/tmp",
            TEST_RUN_DIR,
            TEST_SESSION
        );

        await waitForExitCode(result.exitCodeFile);

        const output = captureOutput(result.windowId, 2000, result.outputFile);
        assert.ok(
            output.includes("file-has-content"),
            `captureOutput should return file content, got: ${output}`
        );
    });
});
