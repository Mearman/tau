import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    registerBackgroundJobs,
    clearPendingDecision,
    lookupJob,
    startTimeoutTimer,
} from "../features/background.ts";
import { registerBackgroundCommands } from "../features/background-commands.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob, RunningProcess } from "../types.ts";
import { createJobDonePromise } from "../utils.ts";
import { silenceJobAfterKill } from "../features/background.ts";

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

/**
 * Capture the jobs tool handler via DI.
 */
function captureJobsTool(state: TauState) {
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
            if (tool.name === "jobs") captured = tool as typeof captured;
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

    void it("sets outputConsumed when killing a running job", async () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-99999-2",
            command: "sleep 999",
            pid: -999998,
            startTime: 0,
            status: "running",
            logPath: "/tmp/pi-bg-job-99999-2.log",
            toolCallId: "tc-jd-1",
            proc: { pid: -999998 } as never,
        };
        state.backgroundJobs.set("job-99999-2", job);
        state.pendingDecisionJobId = "job-99999-2";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-jd-1",
            { jobId: "job-99999-2", decision: "kill" },
            null,
            null,
            null
        );

        assert.equal(job.outputConsumed, true);
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

// ─── jobs kill ──────────────────────────────────────────────────────────

void describe("jobs kill — outputConsumed", () => {
    void it("sets outputConsumed when killing a running job", async () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-99999-1",
            command: "sleep 999",
            pid: -999999,
            startTime: 0,
            status: "running",
            logPath: "/tmp/pi-bg-job-99999-1.log",
            toolCallId: "tc-kill-1",
            proc: { pid: -999999 } as never,
        };
        state.backgroundJobs.set("job-99999-1", job);

        const tool = captureJobsTool(state);
        await tool.execute(
            "tc-kill-1",
            { action: "kill", jobId: "job-99999-1" },
            null,
            null,
            null
        );

        assert.equal(job.outputConsumed, true);
    });
});

// ─── Ctrl+X kill ───────────────────────────────────────────────────────

function captureCtrlXHandler(state: TauState) {
    let captured:
        | ((ctx: {
              ui: {
                  notify: () => void;
                  setWidget: () => void;
                  setStatus: () => void;
                  theme: { fg: () => string };
              };
          }) => Promise<void>)
        | null = null;

    const pi = {
        registerShortcut(
            key: string,
            handler: { handler: (ctx: unknown) => Promise<void> }
        ) {
            if (key === "ctrl+x") captured = handler.handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
    } as never;

    registerBackgroundCommands(pi, state);
    return captured!;
}

void describe("Ctrl+X kill — outputConsumed", () => {
    void it("sets outputConsumed when killing the most recent running job", async () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-99999-3",
            command: "sleep 999",
            pid: -999997,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-99999-3.log",
            toolCallId: "tc-ctrlx-1",
            proc: { pid: -999997 } as never,
        };
        state.backgroundJobs.set("job-99999-3", job);

        const handler = captureCtrlXHandler(state);
        await handler({
            ui: {
                notify: () => {},
                setWidget: () => {},
                setStatus: () => {},
                theme: { fg: () => "" },
            },
        });

        assert.equal(job.outputConsumed, true);
    });
});

// ─── TUI kill (showTaskDetail) ──────────────────────────────────────────

function captureTasksInterface(state: TauState) {
    let captured:
        | ((ctx: {
              ui: {
                  notify: () => void;
                  setWidget: () => void;
                  setStatus: () => void;
                  theme: { fg: () => string };
                  select: (
                      title: string,
                      options: string[]
                  ) => Promise<string | undefined>;
                  editor: () => Promise<string | undefined>;
              };
          }) => Promise<void>)
        | null = null;

    const pi = {
        registerShortcut(
            key: string,
            handler: { handler: (ctx: unknown) => Promise<void> }
        ) {
            if (key === "ctrl+j") captured = handler.handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
    } as never;

    registerBackgroundCommands(pi, state);
    return captured!;
}

void describe("TUI kill — outputConsumed", () => {
    void it("sets outputConsumed when killing via the tasks interface", async () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-99999-4",
            command: "sleep 999",
            pid: -999996,
            startTime: Date.now(),
            status: "running",
            logPath: "/tmp/pi-bg-job-99999-4.log",
            toolCallId: "tc-tui-1",
            proc: { pid: -999996 } as never,
        };
        state.backgroundJobs.set("job-99999-4", job);

        const handler = captureTasksInterface(state);

        let selectCallCount = 0;
        await handler({
            ui: {
                notify: () => {},
                setWidget: () => {},
                setStatus: () => {},
                theme: { fg: () => "" },
                select: async (_title: string, options: string[]) => {
                    selectCallCount++;
                    if (selectCallCount === 1) {
                        return options.find((o) => o.includes("job-99999-4"));
                    }
                    return options.find((o) => o === "Kill");
                },
                editor: async () => "",
            },
        });

        assert.equal(job.outputConsumed, true);
    });
});

// ─── silenceJobAfterKill ───────────────────────────────────────────────

void describe("silenceJobAfterKill", () => {
    void it("sets outputConsumed so subsequent notifyCompletion is suppressed", () => {
        const job: BackgroundJob = {
            id: "job-99999-5",
            command: "sleep 999",
            pid: -999995,
            startTime: 0,
            status: "running",
            logPath: "/tmp/pi-bg-job-99999-5.log",
            toolCallId: "tc-silence-1",
        };
        createJobDonePromise(job);
        silenceJobAfterKill(job);
        assert.equal(job.status, "killed");
        assert.equal(job.outputConsumed, true);
    });
});

// ─── startTimeoutTimer ───────────────────────────────────────────────────

void describe("startTimeoutTimer", () => {
    void it("uses explicit timeout when provided instead of DEFAULT_TIMEOUT_MS", async () => {
        const state = new TauState();
        let sentMessageType: string | undefined;

        const mockPi = {
            sendMessage: (msg: { customType: string }) => {
                sentMessageType = msg.customType;
            },
        } as never;
        const mockCtx = {
            ui: {
                notify: () => {},
                setWidget: () => {},
                setStatus: () => {},
                theme: { fg: () => "" },
            },
        } as never;

        const proc = {
            pid: -77777,
            on: () => {},
            stdout: { removeListener: () => {}, pipe: () => {} },
            stderr: { removeListener: () => {}, pipe: () => {} },
        } as never;
        const rp: RunningProcess = {
            toolCallId: "tc-timeout-1",
            proc,
            command: "sleep 60 && gh run view",
            backgrounded: false,
            output: "",
        };
        state.runningProcesses.set("tc-timeout-1", rp);
        state.currentlyRunningToolCallId = "tc-timeout-1";

        // Use a short explicit timeout of 50ms so the test runs fast
        const timer = startTimeoutTimer(rp, state, mockPi, mockCtx, 50);

        // Wait long enough for the timer to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Process SHOULD have been backgrounded after the explicit timeout
        assert.equal(
            rp.backgrounded,
            true,
            "Should be backgrounded after explicit timeout fires"
        );
        assert.equal(
            sentMessageType,
            "bg-timeout",
            "Should have sent bg-timeout message"
        );

        clearTimeout(timer);
    });

    void it("does NOT fire before the explicit timeout elapses", async () => {
        const state = new TauState();
        let sentMessageType: string | undefined;

        const mockPi = {
            sendMessage: (msg: { customType: string }) => {
                sentMessageType = msg.customType;
            },
        } as never;
        const mockCtx = {
            ui: {
                notify: () => {},
                setWidget: () => {},
                theme: { fg: () => "" },
            },
        } as never;

        const rp: RunningProcess = {
            toolCallId: "tc-timeout-3",
            proc: { pid: -77779 } as never,
            command: "sleep 60 && gh run view",
            backgrounded: false,
            output: "",
        };
        state.runningProcesses.set("tc-timeout-3", rp);
        state.currentlyRunningToolCallId = "tc-timeout-3";

        // Use an explicit timeout of 500ms
        const timer = startTimeoutTimer(rp, state, mockPi, mockCtx, 500);

        // Wait 100ms — less than the explicit timeout
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Process should NOT have been backgrounded yet
        assert.equal(
            rp.backgrounded,
            false,
            "Should NOT be backgrounded before explicit timeout fires"
        );
        assert.equal(
            sentMessageType,
            undefined,
            "Should not have sent bg-timeout message yet"
        );

        clearTimeout(timer);
    });

    void it("uses DEFAULT_TIMEOUT_MS when no explicit timeout provided", () => {
        const state = new TauState();

        const mockPi = {
            sendMessage: () => {},
        } as never;
        const mockCtx = {
            ui: {
                notify: () => {},
                setWidget: () => {},
                theme: { fg: () => "" },
            },
        } as never;

        const rp: RunningProcess = {
            toolCallId: "tc-timeout-2",
            proc: { pid: -77778 } as never,
            command: "echo slow",
            backgrounded: false,
            output: "",
        };
        state.runningProcesses.set("tc-timeout-2", rp);
        state.currentlyRunningToolCallId = "tc-timeout-2";

        // Without an explicit timeout, the timer uses DEFAULT_TIMEOUT_MS (15s)
        const timer = startTimeoutTimer(rp, state, mockPi, mockCtx);
        assert.ok(timer, "Timer created with default timeout");
        clearTimeout(timer);
    });
});
