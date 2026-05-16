import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    registerBackgroundJobs,
    clearPendingDecision,
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
