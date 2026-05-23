import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markJobTerminal, createJobDonePromise } from "../utils.ts";
import type { BackgroundJob } from "../types.ts";

void describe("markJobTerminal", () => {
    void it("marks a job as completed", () => {
        const job: BackgroundJob = {
            id: "job-1",
            command: "echo",
            pid: 123,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-1.log",
            toolCallId: "tc-1",
            isBackgrounded: true,
        };
        createJobDonePromise(job);
        markJobTerminal(job, "completed", 0);
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
        assert.equal(job.proc, undefined);
    });

    void it("marks a job as failed with exit code", () => {
        const job: BackgroundJob = {
            id: "job-2",
            command: "false",
            pid: 124,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-2.log",
            toolCallId: "tc-2",
            isBackgrounded: true,
        };
        createJobDonePromise(job);
        markJobTerminal(job, "failed", 1);
        assert.equal(job.status, "failed");
        assert.equal(job.exitCode, 1);
    });

    void it("is a no-op when the job is already killed", () => {
        const job: BackgroundJob = {
            id: "job-5",
            command: "sleep 10",
            pid: 127,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-5.log",
            toolCallId: "tc-5",
            isBackgrounded: true,
        };
        createJobDonePromise(job);
        markJobTerminal(job, "killed");
        assert.equal(job.status, "killed");

        // Simulate proc.on("close") firing after the kill
        markJobTerminal(job, "completed", 0);
        assert.equal(job.status, "killed");
        assert.equal(job.exitCode, undefined);
    });

    void it("resolves the done promise", async () => {
        const job: BackgroundJob = {
            id: "job-3",
            command: "test",
            pid: 125,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-3.log",
            toolCallId: "tc-3",
            isBackgrounded: true,
        };
        createJobDonePromise(job);
        const promise = job.donePromise;
        markJobTerminal(job, "completed", 0);
        await promise;
        // Should resolve without hanging
        assert.ok(true);
    });
});

void describe("createJobDonePromise", () => {
    void it("creates a promise and resolve function", () => {
        const job: BackgroundJob = {
            id: "job-4",
            command: "test",
            pid: 126,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-4.log",
            toolCallId: "tc-4",
            isBackgrounded: true,
        };
        createJobDonePromise(job);
        assert.ok(job.donePromise instanceof Promise);
        assert.equal(typeof job.resolveDone, "function");
    });
});
