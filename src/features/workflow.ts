/**
 * Workflow feature — orchestrates multi-agent tasks via deterministic JavaScript scripts.
 *
 * Uses the same script format as Claude Code's /workflows for interoperability:
 *
 *   export const meta = {
 *     name: "my-workflow",
 *     description: "Does things",
 *     phases: [{ title: "Research", kind: "parallel" }]
 *   }
 *
 *   const result = await agent("Do something");
 *   await agent(`Continue with: ${result}`);
 *
 * Scripts execute in a Node.js VM sandbox with global functions:
 *   agent(prompt, opts?)  — spawn a subagent, return text result
 *   parallel(fns)         — run Array<() => Promise<T>> concurrently
 *   pipeline(fns)         — chain steps sequentially, piping output
 *   args                  — user-provided arguments
 *
 * Commands:
 *   /workflow run <name>          — run named workflow from .claude/workflows/
 *   /workflow run --file <path>   — run from file
 *   /workflow run --inline <js>   — run inline script
 *   /workflow list                — list available workflows
 *   /workflow status              — show current run progress
 *   /workflow stop                — stop the running workflow
 */

import { createContext, Script } from "node:vm";
import { createHash, randomBytes } from "node:crypto";
import {
    createWriteStream,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import type {
    WorkflowMeta,
    WorkflowRun,
    WorkflowAgentResult,
} from "../types.ts";

// ─── Constants ──────────────────────────────────────────────────────

const WORKFLOW_DIR = ".claude/workflows";
const SESSION_WORKFLOW_DIR = "workflows";

// ─── Meta parser ────────────────────────────────────────────────────

/**
 * Extract the `export const meta = {...}` block from a workflow script.
 * The meta block must be a pure literal — no computed values, no function calls.
 */
export function parseMeta(script: string): WorkflowMeta {
    const match = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/);
    if (!match) {
        throw new Error(
            "Workflow script must contain `export const meta = { ... }`"
        );
    }

    const metaSource = match[1];

    // Evaluate the meta literal in a safe context
    const vmContext = createContext({ Object, Array });
    try {
        const metaScript = new Script(`(${metaSource})`);
        const meta = metaScript.runInContext(vmContext) as WorkflowMeta;

        if (!meta.name || typeof meta.name !== "string") {
            throw new Error("meta.name is required and must be a string");
        }
        if (!meta.description || typeof meta.description !== "string") {
            throw new Error(
                "meta.description is required and must be a string"
            );
        }

        return {
            name: meta.name,
            description: meta.description,
            phases: meta.phases?.map((p) => ({
                title: p.title,
                kind: p.kind,
            })),
        };
    } catch (err) {
        throw new Error(
            `Invalid meta block: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
        );
    }
}

// ─── Determinism check ──────────────────────────────────────────────

const NONDETERMINISTIC_RE =
    /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(/;

/**
 * Validate that a script is deterministic (no Date.now/Math.random/new Date).
 */
export function checkDeterminism(scriptBody: string): string | undefined {
    if (NONDETERMINISTIC_RE.test(scriptBody)) {
        return (
            "Workflow scripts must be deterministic: " +
            "Date.now(), Math.random(), and new Date() are unavailable (breaks resume)."
        );
    }
    return undefined;
}

// ─── Caching ────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 cache key from (prompt, opts).
 */
export function computeAgentKey(
    prompt: string,
    opts?: Record<string, unknown>
): string {
    const hash = createHash("sha256")
        .update(prompt)
        .update("\x00")
        .update(JSON.stringify(opts ?? {}))
        .digest("hex");
    return `agent:${hash.slice(0, 24)}`;
}

/**
 * Look up a cached result by key.
 */
export function getCachedResult(
    run: WorkflowRun,
    key: string
): WorkflowAgentResult | undefined {
    return run.cachedResults.find((r) => r.key === key);
}

// ─── Agent execution ────────────────────────────────────────────────

/**
 * Spawn a `pi -p` subprocess to execute an agent call.
 * Returns the captured output text.
 */
export async function executeAgent(
    prompt: string,
    opts: Record<string, unknown> | undefined,
    cwd: string,
    model?: string,
    signal?: AbortSignal
): Promise<string> {
    const id = randomBytes(8).toString("hex");
    const promptFile = join(tmpdir(), `pi-wf-agent-${id}.md`);
    const logFile = join(tmpdir(), `pi-wf-agent-${id}.log`);

    writeFileSync(promptFile, prompt);

    const modelArg = model ? ["--model", model] : [];
    const spawnArgs = [
        "-p",
        "--mode",
        "text",
        ...modelArg,
        `@${promptFile}`,
    ];

    return new Promise((resolve, reject) => {
        const proc = spawn("pi", spawnArgs, {
            cwd,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const logStream = createWriteStream(logFile, { flags: "w" });
        let output = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            output += text;
            logStream.write(chunk);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
            logStream.write(chunk);
        });

        proc.on("close", (code) => {
            logStream.end();
            try {
                unlinkSync(promptFile);
            } catch {
                /* already gone */
            }
            try {
                unlinkSync(logFile);
            } catch {
                /* already gone */
            }

            if (code === 0 || code === null) {
                // Strip terminal escape sequences that pi may emit.
                // Char 27 = ESC, char 7 = BEL. Built from char codes so
                // no-control-regex has nothing to flag.
                const esc = String.fromCharCode(27);
                const bel = String.fromCharCode(7);
                const oscRe = new RegExp(esc + "][^" + bel + "]*" + bel, "g");
                const csiRe = new RegExp(esc + "\\[" + "[\\d;]*[A-Za-z]", "g");
                const cleanOutput = output
                    .replace(oscRe, "")
                    .replace(csiRe, "")
                    .trim();
                resolve(cleanOutput);
            } else {
                reject(
                    new Error(
                        `Agent exited with code ${code}: ${output.slice(0, 500)}`
                    )
                );
            }
        });

        proc.on("error", (err) => {
            logStream.end();
            try {
                unlinkSync(promptFile);
            } catch {
                /* already gone */
            }
            reject(err);
        });

        // Handle abort
        if (signal) {
            const onAbort = () => {
                proc.kill("SIGTERM");
                reject(new Error("Agent aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            proc.on("close", () => {
                signal.removeEventListener("abort", onAbort);
            });
        }
    });
}

// ─── VM sandbox ─────────────────────────────────────────────────────

/**
 * Execute a workflow script in a VM sandbox.
 *
 * Returns the final output text (last agent result) or throws on error.
 * The `onProgress` callback receives status updates as agents execute.
 */
export async function executeWorkflowScript(
    scriptBody: string,
    run: WorkflowRun,
    cwd: string,
    model?: string,
    onProgress?: (event: WorkflowProgressEvent) => void
): Promise<{ result: string; cachedResults: WorkflowAgentResult[] }> {
    const abortController = new AbortController();
    const cachedResults = [...run.cachedResults];
    let agentCount = 0;

    // Create the agent() global function
    const agentFn = async (
        prompt: string,
        opts?: Record<string, unknown>
    ): Promise<string> => {
        const key = computeAgentKey(prompt, opts);

        // Check cache first
        const cached = cachedResults.find((r) => r.key === key);
        if (cached) {
            onProgress?.({
                type: "cache_hit",
                agentIndex: agentCount,
                key,
                prompt: prompt.slice(0, 80),
            });
            return cached.result;
        }

        // Execute agent
        agentCount++;
        const agentIndex = agentCount;
        onProgress?.({
            type: "agent_start",
            agentIndex,
            key,
            prompt: prompt.slice(0, 80),
        });

        try {
            const result = await executeAgent(
                prompt,
                opts,
                cwd,
                model,
                abortController.signal
            );

            // Cache the result
            const entry: WorkflowAgentResult = {
                key,
                prompt,
                opts,
                result,
                completedAt: Date.now(),
            };
            cachedResults.push(entry);

            onProgress?.({
                type: "agent_done",
                agentIndex,
                key,
                prompt: prompt.slice(0, 80),
                resultLength: result.length,
            });

            return result;
        } catch (err) {
            onProgress?.({
                type: "agent_error",
                agentIndex,
                key,
                prompt: prompt.slice(0, 80),
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    };

    // Create the parallel() global function
    const parallelFn = async <T>(
        fns: Array<() => Promise<T>>
    ): Promise<T[]> => {
        if (!Array.isArray(fns)) {
            throw new Error("parallel() expects an array of functions");
        }
        return Promise.all(fns.map((fn) => fn()));
    };

    // Create the pipeline() global function
    const pipelineFn = async (
        fns: Array<(input: unknown) => Promise<unknown>>
    ): Promise<unknown> => {
        if (!Array.isArray(fns)) {
            throw new Error("pipeline() expects an array of functions");
        }
        let value: unknown;
        for (const fn of fns) {
            value = await fn(value);
        }
        return value;
    };

    // Build the VM context with global functions
    const sandbox = {
        agent: agentFn,
        parallel: parallelFn,
        pipeline: pipelineFn,
        args: run.args,
        console: {
            log: (...args: unknown[]) => {
                onProgress?.({
                    type: "log",
                    agentIndex: -1,
                    message: args
                        .map((a) =>
                            typeof a === "string"
                                ? a
                                : JSON.stringify(a, null, 2)
                        )
                        .join(" "),
                });
            },
        },
        // Block non-deterministic and dangerous globals.
        // Setting undefined doesn't prevent access — the VM falls through
        // to the real global. Instead, provide functions that throw.
        setTimeout: () => {
            throw new Error("setTimeout is unavailable in workflow scripts");
        },
        setInterval: () => {
            throw new Error("setInterval is unavailable in workflow scripts");
        },
        setImmediate: () => {
            throw new Error("setImmediate is unavailable in workflow scripts");
        },
        Date: class {
            constructor() {
                throw new Error(
                    "Date is unavailable in workflow scripts (breaks resume)"
                );
            }
            static now() {
                throw new Error(
                    "Date.now() is unavailable in workflow scripts (breaks resume)"
                );
            }
        },
        Math: new Proxy(Math, {
            get(target, prop) {
                if (prop === "random") {
                    throw new Error(
                        "Math.random() is unavailable in workflow scripts (breaks resume)"
                    );
                }
                return target[prop as keyof Math];
            },
        }),
        process: undefined,
        require: undefined,
        globalThis: undefined,
    };

    const vmContext = createContext(sandbox);

    // Wrap the script body in an async IIFE so top-level await works
    const wrappedScript = `(async () => {\n${scriptBody}\n})()`;

    try {
        const script = new Script(wrappedScript);
        // runInContext returns unknown; narrow to string
        const rawResult: unknown = await script.runInContext(vmContext, {
            timeout: 30 * 60 * 1000, // 30 minute timeout
        });

        const result =
            typeof rawResult === "string"
                ? rawResult
                : JSON.stringify(rawResult);

        return {
            result,
            cachedResults,
        };
    } catch (err) {
        throw new Error(
            `Workflow script error: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
        );
    }
}

// ─── Progress events ────────────────────────────────────────────────

export type WorkflowProgressEvent =
    | {
          type: "agent_start";
          agentIndex: number;
          key: string;
          prompt: string;
      }
    | {
          type: "agent_done";
          agentIndex: number;
          key: string;
          prompt: string;
          resultLength: number;
      }
    | {
          type: "agent_error";
          agentIndex: number;
          key: string;
          prompt: string;
          error: string;
      }
    | {
          type: "cache_hit";
          agentIndex: number;
          key: string;
          prompt: string;
      }
    | {
          type: "log";
          agentIndex: number;
          message: string;
      };

// ─── Script body extraction ─────────────────────────────────────────

/**
 * Extract the script body (everything after the meta block).
 * Strips the `export const meta = ...` declaration.
 */
export function extractScriptBody(script: string): string {
    // Remove the meta export
    return script
        .replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\s*\n?/, "")
        .trim();
}

// ─── Workflow resolution ────────────────────────────────────────────

/**
 * Resolve a workflow script by name.
 * Checks (in order):
 * 1. <cwd>/.claude/workflows/<name>.js
 * 2. <cwd>/.claude/workflows/<name>.mjs
 */
export function resolveWorkflow(name: string, cwd: string): string | undefined {
    const dir = resolve(cwd, WORKFLOW_DIR);
    for (const ext of [".js", ".mjs"]) {
        const filePath = join(dir, `${name}${ext}`);
        try {
            return readFileSync(filePath, "utf8");
        } catch {
            /* not found */
        }
    }
    return undefined;
}

/**
 * List available workflow names from <cwd>/.claude/workflows/.
 */
export function listWorkflows(cwd: string): string[] {
    const dir = resolve(cwd, WORKFLOW_DIR);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.endsWith(".js") || e.endsWith(".mjs"))
        .map((e) => e.replace(/\.(js|mjs)$/, ""))
        .sort();
}

// ─── Status helpers ─────────────────────────────────────────────────

function updateWorkflowStatus(state: TauState, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const run = state.activeWorkflow;
    if (!run || run.status !== "running") {
        ctx.ui.setStatus("tau-workflow", undefined);
        return;
    }

    const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const cacheCount = run.cachedResults.length;

    ctx.ui.setStatus(
        "tau-workflow",
        ctx.ui.theme.fg(
            "accent",
            `⊛ wf:${run.name} · ${timeStr} · ${cacheCount} cached`
        )
    );
}

// ─── Feature registration ───────────────────────────────────────────

export function registerWorkflow(pi: ExtensionAPI, state: TauState): void {
    // Restore workflow from session entries on startup
    pi.on("session_start", async (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                entry.customType === "tau-workflow-state"
            ) {
                const data = entry.data as Record<string, unknown> | undefined;
                if (
                    data &&
                    typeof data.runId === "string" &&
                    data.status === "running"
                ) {
                    const run = data as unknown as WorkflowRun;
                    // Mark as killed — we can't resume mid-execution
                    data.status = "killed";
                    state.activeWorkflow = run;
                    ctx.ui.notify(
                        `Workflow "${run.name}" was running when session ended — marked as killed. Use /workflow run --file ${run.scriptPath ?? ""} to rerun.`,
                        "warning"
                    );
                }
                break;
            }
        }
        updateWorkflowStatus(state, ctx);
    });

    // ── /workflow command ──────────────────────────────────────────

    pi.registerCommand("workflow", {
        description:
            "Orchestrate multi-agent workflows. Usage: /workflow run <name>, /workflow run --file <path>, /workflow run --inline <script>, /workflow list, /workflow status, /workflow stop",
        handler: async (args, ctx: ExtensionCommandContext) => {
            const trimmed = (args ?? "").trim();
            const tokens = trimmed.split(/\s+/);
            const subcommand = tokens[0]?.toLowerCase();

            if (subcommand === "list") {
                const workflows = listWorkflows(ctx.cwd);
                if (workflows.length === 0) {
                    ctx.ui.notify(
                        "No workflows found in .claude/workflows/",
                        "info"
                    );
                } else {
                    const lines = workflows.map((w, i) => `  ${i + 1}. ${w}`);
                    ctx.ui.notify(
                        `Available workflows:\n${lines.join("\n")}`,
                        "info"
                    );
                }
                return;
            }

            if (subcommand === "status") {
                const run = state.activeWorkflow;
                if (!run) {
                    ctx.ui.notify("No active workflow.", "info");
                    return;
                }

                const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const statusEmoji =
                    run.status === "running"
                        ? "⊛"
                        : run.status === "completed"
                          ? "✓"
                          : run.status === "failed"
                            ? "✗"
                            : "⊘";
                ctx.ui.notify(
                    `${statusEmoji} Workflow "${run.name}" — ${run.status}\n` +
                        `  Run ID: ${run.runId}\n` +
                        `  Elapsed: ${mins}m ${secs}s\n` +
                        `  Cached results: ${run.cachedResults.length}\n` +
                        (run.error ? `  Error: ${run.error}\n` : "") +
                        (run.scriptPath ? `  Script: ${run.scriptPath}\n` : ""),
                    "info"
                );
                return;
            }

            if (subcommand === "stop") {
                const run = state.activeWorkflow;
                if (!run || run.status !== "running") {
                    ctx.ui.notify("No active workflow to stop.", "info");
                    return;
                }
                run.status = "killed";
                pi.appendEntry("tau-workflow-state", run);
                updateWorkflowStatus(state, ctx);
                ctx.ui.notify(`Workflow "${run.name}" stopped.`, "warning");
                return;
            }

            if (subcommand === "run") {
                const rest = tokens.slice(1).join(" ");

                // Check for flags
                if (rest.startsWith("--file ")) {
                    const filePath = rest.slice(7).trim();
                    await runWorkflowFromFile(
                        pi,
                        state,
                        ctx,
                        filePath,
                        undefined
                    );
                    return;
                }

                if (rest.startsWith("--inline ")) {
                    const inlineScript = rest.slice(9).trim();
                    await runWorkflowInline(
                        pi,
                        state,
                        ctx,
                        inlineScript,
                        undefined
                    );
                    return;
                }

                // Default: run by name
                const name = rest.trim();
                if (!name) {
                    ctx.ui.notify(
                        "Usage: /workflow run <name> | --file <path> | --inline <script>",
                        "info"
                    );
                    return;
                }
                await runWorkflowByName(pi, state, ctx, name, undefined);
                return;
            }

            // No subcommand — show help
            ctx.ui.notify(
                "Usage:\n" +
                    "  /workflow run <name>        — run a named workflow\n" +
                    "  /workflow run --file <path> — run from a file\n" +
                    "  /workflow run --inline <js> — run inline script\n" +
                    "  /workflow list              — list available workflows\n" +
                    "  /workflow status            — show current run\n" +
                    "  /workflow stop              — stop running workflow",
                "info"
            );
        },
    });

    // ── workflow tool ──────────────────────────────────────────────

    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Orchestrate multi-agent tasks via deterministic JavaScript workflow scripts. " +
            "Scripts use agent() to spawn subagents, parallel() for concurrency, pipeline() for sequential chaining. " +
            "Scripts must begin with `export const meta = { name, description }`.",
        promptSnippet:
            "Orchestrate multi-agent tasks with deterministic JS workflow scripts",
        promptGuidelines: [
            "Use workflow for complex multi-step tasks that benefit from parallel agent execution.",
            "Workflow scripts are deterministic JavaScript — no Date.now/Math.random/new Date.",
            "Agent results are cached by (prompt, opts) so only changed agents re-run on resume.",
        ],
        parameters: Type.Object({
            name: Type.Optional(
                Type.String({
                    description: "Name of a predefined workflow to run.",
                })
            ),
            script: Type.Optional(
                Type.String({
                    description:
                        "Inline workflow script. Must begin with `export const meta = { name, description }`.",
                })
            ),
            scriptPath: Type.Optional(
                Type.String({
                    description: "Path to a workflow script file.",
                })
            ),
            args: Type.Optional(
                Type.Unknown({
                    description:
                        "Arguments exposed as `args` global in the script. Pass arrays/objects as actual values, not JSON strings.",
                })
            ),
            resumeFromRunId: Type.Optional(
                Type.String({
                    description:
                        "Run ID of a prior workflow to resume. Cached results are reused for unchanged agent calls.",
                })
            ),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            // Resolve script source
            let script: string | undefined;
            let scriptPath: string | undefined;

            if (params.scriptPath) {
                try {
                    script = readFileSync(params.scriptPath, "utf8");
                    scriptPath = params.scriptPath;
                } catch {
                    throw new Error(
                        `Cannot read script file: ${params.scriptPath}`
                    );
                }
            } else if (params.name) {
                script = resolveWorkflow(params.name, ctx.cwd);
                if (!script) {
                    throw new Error(
                        `Workflow "${params.name}" not found in .claude/workflows/`
                    );
                }
            } else if (params.script) {
                script = params.script;
            } else {
                throw new Error(
                    "Must provide one of: name, script, or scriptPath"
                );
            }

            const result = await executeRun(
                pi,
                state,
                ctx,
                script,
                scriptPath,
                params.args,
                params.resumeFromRunId
            );

            return {
                content: [{ type: "text" as const, text: result.summary }],
                details: result.details,
            };
        },
    });

    // ── Run helpers ────────────────────────────────────────────────

    async function executeRun(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionContext,
        script: string,
        scriptPath: string | undefined,
        args: unknown,
        resumeFromRunId?: string
    ): Promise<{ summary: string; details: Record<string, unknown> }> {
        // Check for already running workflow
        if (state.activeWorkflow?.status === "running") {
            throw new Error(
                `Workflow "${state.activeWorkflow.name}" is already running. Stop it first with /workflow stop.`
            );
        }

        // Parse meta
        const meta = parseMeta(script);

        // Check determinism
        const body = extractScriptBody(script);
        const determinismError = checkDeterminism(body);
        if (determinismError) {
            throw new Error(determinismError);
        }

        // Resume: load cached results from prior run
        let cachedResults: WorkflowAgentResult[] = [];
        if (resumeFromRunId) {
            const priorRun = loadPriorRun(
                ctx.sessionManager.getEntries(),
                resumeFromRunId
            );
            if (!priorRun) {
                throw new Error(
                    `No prior run found with ID ${resumeFromRunId}`
                );
            }
            if (priorRun.status === "running") {
                throw new Error("Prior run is still running. Stop it first.");
            }
            cachedResults = priorRun.cachedResults;
        }

        // Generate run ID
        const runId = `wf_${randomBytes(6).toString("hex")}`;

        // Persist script to session directory if not already on disk
        const sessionDir = ctx.sessionManager
            .getSessionFile()
            ?.replace(/\.jsonl$/, "");
        if (!scriptPath && sessionDir) {
            const wfDir = join(sessionDir, SESSION_WORKFLOW_DIR, meta.name);
            mkdirSync(wfDir, { recursive: true });
            scriptPath = join(wfDir, `${runId}.js`);
            writeFileSync(scriptPath, script);
        }

        // Create run state
        const run: WorkflowRun = {
            runId,
            name: meta.name,
            script,
            scriptPath,
            args,
            status: "running",
            startedAt: Date.now(),
            cachedResults,
        };

        state.activeWorkflow = run;
        pi.appendEntry("tau-workflow-state", run);
        updateWorkflowStatus(state, ctx);

        const model = ctx.model;
        const modelId = model ? `${model.provider}/${model.id}` : undefined;

        try {
            const { result, cachedResults } = await executeWorkflowScript(
                body,
                run,
                ctx.cwd,
                modelId,
                () => {
                    // Refresh status bar on every progress event.
                    // The cached results are written to run.cachedResults
                    // after executeWorkflowScript returns.
                    updateWorkflowStatus(state, ctx);
                }
            );

            // Mark completed
            run.status = "completed";
            run.completedAt = Date.now();
            run.cachedResults = cachedResults;

            pi.appendEntry("tau-workflow-state", run);
            state.activeWorkflow = run;
            updateWorkflowStatus(state, ctx);

            const summary =
                `Workflow "${meta.name}" completed (run ${runId}). ` +
                `${cachedResults.length} agent results cached. ` +
                (scriptPath
                    ? `Script: ${scriptPath}. To resume: /workflow run --file ${scriptPath}`
                    : "");

            return {
                summary,
                details: {
                    runId,
                    name: meta.name,
                    status: "completed",
                    agentCount: cachedResults.length,
                    resultPreview: result.slice(0, 500),
                    scriptPath,
                },
            };
        } catch (err) {
            run.status = "failed";
            run.completedAt = Date.now();
            run.error = err instanceof Error ? err.message : String(err);

            pi.appendEntry("tau-workflow-state", run);
            state.activeWorkflow = run;
            updateWorkflowStatus(state, ctx);

            throw err;
        }
    }

    async function runWorkflowByName(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        name: string,
        args: unknown
    ): Promise<void> {
        const script = resolveWorkflow(name, ctx.cwd);
        if (!script) {
            ctx.ui.notify(
                `Workflow "${name}" not found in .claude/workflows/`,
                "error"
            );
            return;
        }
        try {
            const result = await executeRun(
                pi,
                state,
                ctx,
                script,
                undefined,
                args
            );
            ctx.ui.notify(result.summary, "info");
        } catch (err) {
            ctx.ui.notify(
                `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
            );
        }
    }

    async function runWorkflowFromFile(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        filePath: string,
        args: unknown
    ): Promise<void> {
        try {
            const script = readFileSync(filePath, "utf8");
            const result = await executeRun(
                pi,
                state,
                ctx,
                script,
                filePath,
                args
            );
            ctx.ui.notify(result.summary, "info");
        } catch (err) {
            ctx.ui.notify(
                `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
            );
        }
    }

    async function runWorkflowInline(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        script: string,
        args: unknown
    ): Promise<void> {
        try {
            const result = await executeRun(
                pi,
                state,
                ctx,
                script,
                undefined,
                args
            );
            ctx.ui.notify(result.summary, "info");
        } catch (err) {
            ctx.ui.notify(
                `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
            );
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function loadPriorRun(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    runId: string
): WorkflowRun | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (
            entry.type === "custom" &&
            entry.customType === "tau-workflow-state"
        ) {
            const run = entry.data as WorkflowRun | undefined;
            if (run?.runId === runId) return run;
        }
    }
    return undefined;
}
