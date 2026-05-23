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

/** Helper to create a BackgroundJob with all required fields. */
function makeJob(
    overrides: Partial<BackgroundJob> & { id: string }
): BackgroundJob {
    return {
        command: "test",
        pid: 1,
        startTime: 0,
        status: "completed",
        logPath: "/tmp/test",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

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
        const job = makeJob({
            id: "job-12345-1",
            status: "running",
        });
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
        const job = makeJob({
            id: "job-99999-2",
            command: "sleep 999",
            pid: -999998,
            status: "running",
            toolCallId: "tc-jd-1",
            proc: { pid: -999998 } as never,
        });
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
        const job = makeJob({ id: "job-12345-1" });
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "job-12345-1")?.id, "job-12345-1");
    });

    void it("finds job without job- prefix", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-12345-1" });
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "12345-1")?.id, "job-12345-1");
    });

    void it("returns undefined when no match", () => {
        const state = new TauState();
        assert.equal(lookupJob(state, "nonexistent"), undefined);
    });

    void it("prefers exact match over prefix match", () => {
        const state = new TauState();
        const exact = makeJob({ id: "12345-1", command: "exact" });
        const prefixed = makeJob({
            id: "job-12345-1",
            command: "prefixed",
            pid: 2,
        });
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
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("does not clear when job id does not match", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-2";
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, "job-2");
    });

    void it("is a no-op when pendingDecisionJobId is already undefined", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });
});

// ─── jobs kill ──────────────────────────────────────────────────────────

void describe("jobs kill — outputConsumed", () => {
    void it("sets outputConsumed when killing a running job", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-99999-1",
            command: "sleep 999",
            pid: -999999,
            status: "running",
            toolCallId: "tc-kill-1",
            proc: { pid: -999999 } as never,
        });
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
        const job = makeJob({
            id: "job-99999-3",
            command: "sleep 999",
            pid: -999997,
            startTime: Date.now(),
            status: "running",
            toolCallId: "tc-ctrlx-1",
            proc: { pid: -999997 } as never,
        });
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
        const job = makeJob({
            id: "job-99999-4",
            command: "sleep 999",
            pid: -999996,
            startTime: Date.now(),
            status: "running",
            toolCallId: "tc-tui-1",
            proc: { pid: -999996 } as never,
        });
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
        const job = makeJob({
            id: "job-99999-5",
            command: "sleep 999",
            pid: -999995,
            status: "running",
            toolCallId: "tc-silence-1",
        });
        createJobDonePromise(job);
        silenceJobAfterKill(job);
        assert.equal(job.status, "killed");
        assert.equal(job.outputConsumed, true);
    });
});

// ─── startTimeoutTimer (signal-based) ────────────────────────────────

void describe("startTimeoutTimer", () => {
    void it("calls triggerBackground after explicit timeout", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-1";
        let triggered = false;

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-timeout-1",
            50
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            true,
            "triggerBackground should have been called"
        );
        clearTimeout(timer);
    });

    void it("does NOT fire before the explicit timeout elapses", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-3";
        let triggered = false;

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-timeout-3",
            500
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            false,
            "triggerBackground should NOT have been called yet"
        );
        clearTimeout(timer);
    });

    void it("uses DEFAULT_TIMEOUT_MS when no explicit timeout provided", () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-2";

        const timer = startTimeoutTimer(
            () => {},
            "echo slow",
            state,
            "tc-timeout-2"
        );
        assert.ok(timer, "Timer created with default timeout");
        clearTimeout(timer);
    });

    void it("does NOT trigger for disallowed commands (sleep)", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-sleep";
        let triggered = false;

        // Register a mock running process so the kill path can find it
        const mockProc = { pid: -88888 } as never;
        const rp: RunningProcess = {
            toolCallId: "tc-timeout-sleep",
            proc: mockProc,
            command: "sleep 60",
            logPath: "/tmp/test-sleep.log",
            triggerBackground: () => {
                triggered = true;
            },
        };
        state.runningProcesses.set("tc-timeout-sleep", rp);

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "sleep 60",
            state,
            "tc-timeout-sleep",
            50
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(triggered, false, "sleep should not be auto-backgrounded");
        clearTimeout(timer);
    });
});
