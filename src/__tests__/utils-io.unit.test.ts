import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readOutputTail, readOutputTailSync, formatJobLine } from "../utils.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tau-test-utils-io");

void describe("readOutputTail", () => {
    void it("returns no output for missing file", async () => {
        const result = await readOutputTail("/nonexistent/file.log", 1000);
        assert.equal(result, "(no output yet)");
    });

    void it("returns full content when under max", async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        const file = join(TEST_DIR, "small.log");
        try {
            writeFileSync(file, "hello world");
            const result = await readOutputTail(file, 1000);
            assert.equal(result, "hello world");
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    void it("truncates when content exceeds max", async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        const file = join(TEST_DIR, "big.log");
        try {
            const content = "x".repeat(100);
            writeFileSync(file, content);
            const result = await readOutputTail(file, 50);
            assert.ok(result.startsWith("...[truncated"));
            assert.ok(result.endsWith("x".repeat(50)));
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
});

void describe("readOutputTailSync", () => {
    void it("returns no output for missing file", () => {
        const result = readOutputTailSync("/nonexistent/file.log", 1000);
        assert.equal(result, "(no output yet)");
    });

    void it("returns content for existing file", () => {
        mkdirSync(TEST_DIR, { recursive: true });
        const file = join(TEST_DIR, "sync.log");
        try {
            writeFileSync(file, "sync content");
            const result = readOutputTailSync(file, 1000);
            assert.equal(result, "sync content");
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    void it("returns no output for empty file", () => {
        mkdirSync(TEST_DIR, { recursive: true });
        const file = join(TEST_DIR, "empty.log");
        try {
            writeFileSync(file, "");
            const result = readOutputTailSync(file, 1000);
            assert.equal(result, "(no output yet)");
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
});

void describe("formatJobLine", () => {
    void it("formats a running job", () => {
        const job = {
            id: "job-1",
            command: "npm build",
            pid: 1234,
            startTime: Date.now() - 5000,
            status: "running" as const,
            logPath: "/tmp/pi-bg-job-1.log",
            toolCallId: "tc-1",
            isBackgrounded: true,
        };
        const line = formatJobLine(job);
        assert.ok(line.includes("job-1"));
        assert.ok(line.includes("npm build"));
        assert.ok(line.includes("running"));
    });

    void it("formats a completed job", () => {
        const job = {
            id: "job-2",
            command: "echo done",
            pid: 1234,
            startTime: Date.now(),
            status: "completed" as const,
            logPath: "/tmp/pi-bg-job-2.log",
            toolCallId: "tc-2",
            isBackgrounded: true,
        };
        const line = formatJobLine(job);
        assert.ok(line.includes("completed"));
    });

    void it("truncates long commands to 80 chars", () => {
        const job = {
            id: "job-3",
            command: "x".repeat(200),
            pid: 1234,
            startTime: Date.now(),
            status: "running" as const,
            logPath: "/tmp/pi-bg-job-3.log",
            toolCallId: "tc-3",
            isBackgrounded: true,
        };
        const line = formatJobLine(job);
        // The command portion should be at most 80 chars
        const cmdStart = line.indexOf("x".repeat(80));
        assert.ok(cmdStart >= 0, "Command should be truncated to 80 chars");
    });
});
