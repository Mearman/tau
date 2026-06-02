import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── parseMeta tests ────────────────────────────────────────────────

void describe("workflow parseMeta", () => {
    void it("extracts a valid meta block", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        const meta = parseMeta(`
export const meta = {
  name: "test-workflow",
  description: "A test workflow"
}

const result = await agent("hello");
`);
        assert.equal(meta.name, "test-workflow");
        assert.equal(meta.description, "A test workflow");
    });

    void it("extracts meta with phases", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        const meta = parseMeta(`
export const meta = {
  name: "phased-workflow",
  description: "Has phases",
  phases: [
    { title: "Research", kind: "parallel" },
    { title: "Implement", kind: "sequential" }
  ]
}

await agent("go");
`);
        assert.equal(meta.name, "phased-workflow");
        assert.ok(meta.phases);
        assert.equal(meta.phases.length, 2);
        assert.equal(meta.phases[0].title, "Research");
        assert.equal(meta.phases[0].kind, "parallel");
        assert.equal(meta.phases[1].kind, "sequential");
    });

    void it("throws when meta block is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () => parseMeta('const x = await agent("hello");'),
            /must contain/
        );
    });

    void it("throws when name is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () =>
                parseMeta(`
export const meta = {
  description: "No name"
}
`),
            /name is required/
        );
    });

    void it("throws when description is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () =>
                parseMeta(`
export const meta = {
  name: "no-desc"
}
`),
            /description is required/
        );
    });
});

// ─── checkDeterminism tests ─────────────────────────────────────────

void describe("workflow checkDeterminism", () => {
    void it("returns undefined for deterministic scripts", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        assert.equal(
            checkDeterminism('const r = await agent("hello");'),
            undefined
        );
    });

    void it("returns error for Date.now()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const t = Date.now();");
        assert.ok(err);
        assert.ok(err.includes("Date.now()"));
    });

    void it("returns error for Math.random()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const r = Math.random();");
        assert.ok(err);
        assert.ok(err.includes("Math.random()"));
    });

    void it("returns error for new Date()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const d = new Date();");
        assert.ok(err);
        assert.ok(err.includes("new Date()"));
    });
});

// ─── computeAgentKey tests ──────────────────────────────────────────

void describe("workflow computeAgentKey", () => {
    void it("returns a stable key for same inputs", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello", { model: "sonnet" });
        const key2 = computeAgentKey("hello", { model: "sonnet" });
        assert.equal(key1, key2);
    });

    void it("returns different keys for different prompts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello");
        const key2 = computeAgentKey("world");
        assert.notEqual(key1, key2);
    });

    void it("returns different keys for different opts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello", { model: "sonnet" });
        const key2 = computeAgentKey("hello", { model: "opus" });
        assert.notEqual(key1, key2);
    });

    void it("returns same key for same prompt without opts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello");
        const key2 = computeAgentKey("hello");
        assert.equal(key1, key2);
    });

    void it("key starts with agent: prefix", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key = computeAgentKey("test");
        assert.ok(key.startsWith("agent:"));
    });
});

// ─── getCachedResult tests ──────────────────────────────────────────

void describe("workflow getCachedResult", () => {
    void it("finds a cached result by key", async () => {
        const { getCachedResult } = await import("../features/workflow.ts");
        const run = {
            runId: "wf_test",
            name: "test",
            script: "",
            status: "completed" as const,
            startedAt: 0,
            cachedResults: [
                {
                    key: "agent:abc123",
                    prompt: "hello",
                    result: "world",
                    completedAt: 100,
                },
            ],
        };
        const found = getCachedResult(run, "agent:abc123");
        assert.ok(found);
        assert.equal(found.result, "world");
    });

    void it("returns undefined for missing key", async () => {
        const { getCachedResult } = await import("../features/workflow.ts");
        const run = {
            runId: "wf_test",
            name: "test",
            script: "",
            status: "completed" as const,
            startedAt: 0,
            cachedResults: [],
        };
        assert.equal(getCachedResult(run, "agent:missing"), undefined);
    });
});

// ─── extractScriptBody tests ────────────────────────────────────────

void describe("workflow extractScriptBody", () => {
    void it("strips the meta export block", async () => {
        const { extractScriptBody } = await import("../features/workflow.ts");
        const body = extractScriptBody(`
export const meta = {
  name: "test",
  description: "test"
}

const r = await agent("hello");
`);
        assert.ok(!body.includes("export const meta"));
        assert.ok(body.includes('await agent("hello")'));
    });

    void it("returns trimmed body when no meta present", async () => {
        const { extractScriptBody } = await import("../features/workflow.ts");
        const body = extractScriptBody('const r = await agent("go");');
        assert.ok(body.includes("agent"));
    });
});

// ─── Registration tests ─────────────────────────────────────────────

void describe("workflow registration", () => {
    void it("exports registerWorkflow function", async () => {
        const mod = await import("../features/workflow.ts");
        assert.equal(typeof mod.registerWorkflow, "function");
    });

    void it("registers /workflow command", async () => {
        const { registerWorkflow } = await import("../features/workflow.ts");

        const commands = new Map<
            string,
            { description: string; handler: () => Promise<void> }
        >();
        const events = new Map<string, Array<() => Promise<unknown>>>();
        const entries: Array<{
            type: string;
            customType: string;
            data: unknown;
        }> = [];
        const sentMessages: Array<{ text: string; options?: unknown }> = [];

        const mockPi = {
            registerCommand(
                name: string,
                opts: {
                    description: string;
                    handler: () => Promise<void>;
                }
            ) {
                commands.set(name, opts);
            },
            on(event: string, handler: () => Promise<unknown>) {
                const arr = events.get(event) ?? [];
                arr.push(handler);
                events.set(event, arr);
            },
            appendEntry(customType: string, data: unknown) {
                entries.push({ type: "custom", customType, data });
            },
            sendUserMessage(text: string, options?: unknown) {
                sentMessages.push({ text, options });
            },
            registerTool: () => {},
        };

        const mockState = { activeWorkflow: undefined };

        registerWorkflow(
            mockPi as unknown as Parameters<typeof registerWorkflow>[0],
            mockState as unknown as Parameters<typeof registerWorkflow>[1]
        );

        assert.ok(commands.has("workflow"));
        assert.ok(events.has("session_start"));
    });
});
