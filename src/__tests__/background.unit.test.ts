import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    registerBackgroundJobs,
    clearPendingDecision,
    lookupJob,
} from "../features/background.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";

/**
 * Capture the job_decide tool handler via DI.
 */
function captureJobDecide(state: TauState) {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: unknown
        ) => Promise<{
            content: { type: string; text: string }[];
            details: unknown;
        }>;
    } | null = null;

    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "job_decide") captured = tool as typeof captured;
        },
        registerCommand: () => {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
    } as never;

    registerBackgroundJobs(pi, state);
    return captured!;
}

void describe("job_decide — pendingDecisionJobId cleanup", () => {
    void it("clears pendingDecisionJobId when job is not found", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-99999-1";

        const tool = captureJobDecide(state);
        const result = await tool.execute(
            "tc-1",
            { jobId: "job-99999-1", decision: "keep" },
            null,
            null,
            null
        );

        assert.ok(result.content[0].text.includes("not found"));
        assert.equal(
            state.pendingDecisionJobId,
            undefined,
            "pendingDecisionJobId must be cleared even when job is not found"
        );
    });

    void it("resolves job without job- prefix", async () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-12345-1",
            command: "echo hi",
            pid: 12345,
            startTime: 0,
            status: "running",
            logPath: "/tmp/pi-bg-job-12345-1.log",
            toolCallId: "tc-1",
        };
        state.backgroundJobs.set("job-12345-1", job);
        state.pendingDecisionJobId = "job-12345-1";

        const tool = captureJobDecide(state);
        const result = await tool.execute(
            "tc-1",
            { jobId: "12345-1", decision: "keep" },
            null,
            null,
            null
        );

        assert.ok(
            result.content[0].text.includes("Keeping"),
            `Expected keep message, got: ${result.content[0].text}`
        );
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("clears pendingDecisionJobId on kill of non-existent job", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "ghost-job";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-1",
            { jobId: "ghost-job", decision: "kill" },
            null,
            null,
            null
        );

        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("clears pendingDecisionJobId on check of non-existent job", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "ghost-job";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-1",
            { jobId: "ghost-job", decision: "check" },
            null,
            null,
            null
        );

        assert.equal(state.pendingDecisionJobId, undefined);
    });
});

// ─── lookupJob ───────────────────────────────────────────────────────

void describe("lookupJob", () => {
    void it("finds job by exact id", () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-12345-1",
            command: "test",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
        };
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "job-12345-1")?.id, "job-12345-1");
    });

    void it("finds job without job- prefix", () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-12345-1",
            command: "test",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
        };
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "12345-1")?.id, "job-12345-1");
    });

    void it("returns undefined when no match", () => {
        const state = new TauState();
        assert.equal(lookupJob(state, "nonexistent"), undefined);
    });

    void it("prefers exact match over prefix match", () => {
        const state = new TauState();
        const exact: BackgroundJob = {
            id: "12345-1",
            command: "exact",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/exact",
            toolCallId: "tc-1",
        };
        const prefixed: BackgroundJob = {
            id: "job-12345-1",
            command: "prefixed",
            pid: 2,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/prefixed",
            toolCallId: "tc-2",
        };
        state.backgroundJobs.set("12345-1", exact);
        state.backgroundJobs.set("job-12345-1", prefixed);

        assert.equal(lookupJob(state, "12345-1")?.id, "12345-1");
    });
});

// ─── clearPendingDecision ─────────────────────────────────────────────

void describe("clearPendingDecision", () => {
    void it("clears pendingDecisionJobId when it matches the job id", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-1";
        const job: BackgroundJob = {
            id: "job-1",
            command: "test",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
        };
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("does not clear when job id does not match", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-2";
        const job: BackgroundJob = {
            id: "job-1",
            command: "test",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
        };
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, "job-2");
    });

    void it("is a no-op when pendingDecisionJobId is already undefined", () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-1",
            command: "test",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
        };
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });
});
