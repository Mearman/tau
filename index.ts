/**
 * Tau (τ) — Background Tasks Extension for pi
 *
 * Enhances the built-in bash tool with background execution support:
 * - Ctrl+Shift+B to background the currently running bash process
 * - 2-minute default timeout: backgrounds and asks the agent whether to kill or continue
 * - Output written to disk files (/tmp/pi-bg-<jobId>.log), not memory buffers
 * - Process-group kill via process.kill(-pid)
 * - Stall detection: if output hasn't grown for 45s and the tail looks like an
 *   interactive prompt ((y/n), Press any key, Continue?), notify the agent
 * - Size watchdog: kills jobs exceeding 100 MiB output
 * - Working status bar widget showing running jobs
 * - Structured completion notifications via pi.sendMessage
 * - Native terminal notification on agent_end (OSC 777/99, Windows toast)
 *
 * Tools: bash (overridden), bash_bg, jobs
 * Commands: /bg, /fg, /jobs
 * Shortcuts: Ctrl+Shift+B, Ctrl+J
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, type BashToolDetails } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, statSync, existsSync, openSync, readSync, closeSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ─── tree-kill (lazy-loaded) ────────────────────────────────────────────

// ─── Process tree kill ─────────────────────────────────────────────

/** Kill an entire process group. Requires the child to have been spawned
 *  with `detached: true` so it became a process group leader. */
function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// Process group kill failed — try just the parent.
		try { process.kill(pid, signal); } catch { /* already dead */ }
	}
}

// ─── Terminal notifications ──────────────────────────────────────────

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		const { execFile } = require("child_process");
		execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
	} else if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}

// ─── Configuration ──────────────────────────────────────────────────────

/** Default timeout for bash commands. After this, the process is backgrounded and
 *  the agent is asked whether to let it continue or kill it. */
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 12_000;
/** Maximum log file size before the stall watchdog kills the job. */
const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Interactive-prompt patterns at the end of output that suggest a command is
 *  blocked waiting for keyboard input (CC-1175 / Claude Code). */
const PROMPT_PATTERNS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

function looksLikePrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some(p => p.test(lastLine));
}

// ─── Context types ───────────────────────────────────────────────────

/** Minimal context interface for functions that only need UI operations. */
interface UiContext {
	ui: {
		notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
		setWidget(name: string, content: string[] | undefined): void;
		setStatus(name: string, content: unknown): void;
		theme: { fg(colour: string, text: string): string };
		select(title: string, options: string[]): Promise<number | undefined>;
		editor(title: string, content: string): Promise<void>;
	};
}

// ─── Job types ──────────────────────────────────────────────────────────

type JobStatus = "running" | "completed" | "failed" | "killed";

interface BackgroundJob {
	id: string;
	command: string;
	pid: number;
	startTime: number;
	status: JobStatus;
	exitCode?: number;
	logPath: string;
	proc?: ChildProcess;
	toolCallId: string;
	donePromise?: Promise<void>;
	resolveDone?: () => void;
}

interface RunningProcess {
	toolCallId: string;
	proc: ChildProcess;
	command: string;
	backgrounded: boolean;
	/** Listener references so they can be removed on background. */
	stdoutListener?: (data: Buffer) => void;
	stderrListener?: (data: Buffer) => void;
	/** Log file stream, created when the process is backgrounded. */
	logStream?: WriteStream;
	resolve?: (result: AgentToolResult<BashToolDetails | undefined>) => void;
	reject?: (error: Error) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function generateJobId(counter: number): string {
	return `job-${counter}`;
}

function logPathForJob(jobId: string): string {
	return `/tmp/pi-bg-${jobId}.log`;
}

function formatDuration(ms: number): string {
	const totalSecs = Math.floor(ms / 1000);
	const mins = Math.floor(totalSecs / 60);
	const secs = totalSecs % 60;
	return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

async function readOutputTail(path: string, maxChars: number): Promise<string> {
	try {
		const content = await readFile(path, "utf-8");
		if (content.length <= maxChars) return content;
		return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
	} catch {
		return "(no output yet)";
	}
}

function readOutputTailSync(path: string, maxChars: number): string {
	try {
		const { size } = statSync(path);
		if (size === 0) return "(no output yet)";
		const fd = openSync(path, "r");
		try {
			const readStart = Math.max(0, size - maxChars);
			const toRead = Math.min(size, maxChars);
			const buf = Buffer.alloc(toRead);
			readSync(fd, buf, 0, toRead, readStart);
			const content = buf.toString("utf-8", 0, toRead);
			if (size <= maxChars) return content;
			return `...[truncated, showing last ${maxChars} chars]\n${content}`;
		} finally {
			closeSync(fd);
		}
	} catch {
		return "(no output yet)";
	}
}

function formatJobLine(job: BackgroundJob): string {
	const duration = formatDuration(Date.now() - job.startTime);
	const status =
		job.status === "running" ? `⏳ running (${duration})` :
		job.status === "completed" ? "✅ completed" :
		job.status === "failed" ? "❌ failed" :
		"🛑 killed";
	return `${job.id}: ${job.command.slice(0, 80)} - ${status}`;
}

function createJobDonePromise(job: BackgroundJob): void {
	let resolveDone: (() => void) | undefined;
	job.donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
	job.resolveDone = resolveDone;
}

function markJobTerminal(job: BackgroundJob, status: JobStatus, exitCode?: number): void {
	job.status = status;
	job.exitCode = exitCode;
	delete job.proc;
	if (job.resolveDone) {
		job.resolveDone();
		delete job.resolveDone;
	}
}

// ─── Stall watchdog ─────────────────────────────────────────────────────

function startStallWatchdog(
	jobId: string,
	command: string,
	logPath: string,
	pi: ExtensionAPI,
	onOversize?: () => void,
): () => void {
	let lastSize = 0;
	let lastGrowth = Date.now();
	let cancelled = false;

	const timer = setInterval(() => {
		if (cancelled) return;
		try {
			const size = statSync(logPath).size;

			// Size watchdog — kill jobs producing excessive output.
			if (size > MAX_LOG_BYTES) {
				cancelled = true;
				clearInterval(timer);
				if (onOversize) onOversize();
				pi.sendMessage({
					customType: "bg-stall",
					content: `\u26a0\ufe0f Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
					display: true,
					details: { jobId, logPath, command },
				}, {
					deliverAs: "followUp",
					triggerTurn: true,
				});
				return;
			}

			if (size > lastSize) {
				lastSize = size;
				lastGrowth = Date.now();
				return;
			}
			if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

			// Output has been stagnant for 45s — check the tail for prompt patterns
			const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
			if (!looksLikePrompt(tail)) {
				// Not a prompt — reset so next check is 45s out
				lastGrowth = Date.now();
				return;
			}

			// Looks like an interactive prompt — notify the agent
			cancelled = true;
			clearInterval(timer);

			const summary =
				`Background job ${jobId} appears to be waiting for interactive input.\n` +
				`Command: ${command}\n\n` +
				`Last output:\n${tail.trimEnd()}\n\n` +
				`The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
				`with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;

			pi.sendMessage({
				customType: "bg-stall",
				content: `⚠️ ${summary}`,
				display: true,
				details: { jobId, logPath, command },
			}, {
				deliverAs: "followUp",
				triggerTurn: true,
			});
		} catch {
			// File may not exist yet — skip this tick
		}
	}, STALL_CHECK_INTERVAL_MS);

	timer.unref();
	return () => {
		cancelled = true;
		clearInterval(timer);
	};
}

// ─── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const backgroundJobs = new Map<string, BackgroundJob>();
	const runningProcesses = new Map<string, RunningProcess>();
	let jobCounter = 0;

	/** Currently running bash toolCallId (for Ctrl+Shift+B) */
	let currentlyRunningToolCallId: string | null = null;

	// ── Widget / status bar ────────────────────────────────────────────

	function updateWidget(ctx: UiContext): void {
		const runningJobs = Array.from(backgroundJobs.values())
			.filter(job => job.status === "running");

		if (runningJobs.length === 0) {
			ctx.ui.setWidget("background-jobs", undefined);
			ctx.ui.setStatus("background-jobs", undefined);
			return;
		}

		const lines = runningJobs.map(job => {
			const duration = formatDuration(Date.now() - job.startTime);
			return `⏳ ${job.id}: ${job.command.slice(0, 35)} (${duration})`;
		});

		ctx.ui.setWidget("background-jobs", lines);

		const completedJobs = Array.from(backgroundJobs.values())
			.filter(job => job.status === "completed").length;
		const failedJobs = Array.from(backgroundJobs.values())
			.filter(job => job.status === "failed").length;

		let statusText = `${runningJobs.length} running`;
		if (completedJobs > 0) statusText += `, ${completedJobs} done`;
		if (failedJobs > 0) statusText += `, ${failedJobs} failed`;

		ctx.ui.setStatus(
			"background-jobs",
			ctx.ui.theme.fg("accent", `🔄 ${statusText}`),
		);
	}

	/** Send a structured completion notification to the agent. */
	function notifyCompletion(job: BackgroundJob, ctx: UiContext): void {
		const duration = formatDuration(Date.now() - job.startTime);
		const emoji = job.status === "completed" ? "✅" : "❌";
		const statusText = `Background ${job.id} ${job.status} (${duration})`;
		const exitCodeText = job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

		ctx.ui.notify(statusText, job.status === "completed" ? "success" : "error");

		pi.sendMessage({
			customType: "job-completion",
			content:
				`${emoji} ${statusText}\n` +
				`Command: ${job.command}\n` +
				`Output: ${job.logPath}${exitCodeText}`,
			display: true,
			details: {
				jobId: job.id,
				status: job.status,
				exitCode: job.exitCode,
				duration,
				command: job.command,
				logPath: job.logPath,
			},
		}, {
			deliverAs: "followUp",
			triggerTurn: true,
		});
	}

	// ── Background a running foreground process ────────────────────────

	function backgroundProcess(rp: RunningProcess, ctx: UiContext): void {
		const jobId = generateJobId(++jobCounter);
		const path = logPathForJob(jobId);

		const job: BackgroundJob = {
			id: jobId,
			command: rp.command,
			pid: rp.proc.pid!,
			startTime: Date.now(),
			status: "running",
			logPath: path,
			proc: rp.proc,
			toolCallId: rp.toolCallId,
		};
		createJobDonePromise(job);

		rp.backgrounded = true;
		backgroundJobs.set(jobId, job);
		currentlyRunningToolCallId = null;

		// Remove the foreground data listeners so output goes to file only.
		if (rp.stdoutListener) rp.proc.stdout?.removeListener("data", rp.stdoutListener);
		if (rp.stderrListener) rp.proc.stderr?.removeListener("data", rp.stderrListener);

		// Pipe remaining output to the log file.
		rp.logStream = createWriteStream(path, { flags: "w" });
		rp.proc.stdout?.pipe(rp.logStream, { end: false });
		rp.proc.stderr?.pipe(rp.logStream, { end: false });

		// Start stall watchdog (with kill-on-oversize)
		const cancelStall = startStallWatchdog(jobId, rp.command, path, pi, () => {
			if (rp.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
			markJobTerminal(backgroundJobs.get(jobId)!, "killed");
		});

		// Close the log file when the process exits.
		rp.proc.on("close", () => {
			cancelStall();
			if (rp.logStream) { rp.logStream.end(); rp.logStream = undefined; }
		});

		// Resolve the original tool call immediately with backgrounded status
		if (rp.resolve) {
			rp.resolve({
				content: [{
					type: "text" as const,
					text: `Process backgrounded as ${jobId}\nCommand: ${rp.command}\nPID: ${job.pid}\nOutput: ${path}`,
				}],
				details: undefined,
			});
		}

		ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
		updateWidget(ctx);
	}

	// ── Default timeout timer ─────────────────────────────────────────

	function startTimeoutTimer(
		rp: RunningProcess,
		ctx: UiContext,
	): NodeJS.Timeout {
		const timer = setTimeout(() => {
			if (currentlyRunningToolCallId !== rp.toolCallId) return;
			if (rp.backgrounded) return;

			// Background the process to unblock the agent loop.
			backgroundProcess(rp, ctx);

			// Find the job we just created and ask the agent what to do.
			const job = Array.from(backgroundJobs.values())
				.find(j => j.toolCallId === rp.toolCallId);
			if (!job) return;

			const duration = formatDuration(DEFAULT_TIMEOUT_MS);
			pi.sendMessage({
				customType: "bg-timeout",
				content:
					`\u23f0 Command timed out after ${duration} and has been backgrounded as ${job.id}.\n` +
					`Command: ${rp.command}\n` +
					`PID: ${job.pid}\n` +
					`Output so far: ${job.logPath}\n\n` +
				`Choose one:\n` +
				`- Use the jobs tool with action "kill" and jobId "${job.id}" to terminate it.\n` +
				`- Use the jobs tool with action "output" and jobId "${job.id}" to check progress.\n` +
				`- Do nothing and it will continue running in the background.`,
				display: true,
				details: { jobId: job.id, logPath: job.logPath, command: rp.command },
			}, {
				deliverAs: "followUp",
				triggerTurn: true,
			});
		}, DEFAULT_TIMEOUT_MS);
		timer.unref();
		return timer;
	}

	// ── Override bash tool ─────────────────────────────────────────────

	const originalBashTool = createBashTool(process.cwd());

	pi.registerTool({
		...originalBashTool,
		name: "bash",
		description:
			"Execute bash commands with streaming output. Commands that run longer than 2 minutes " +
			"are automatically backgrounded and the agent is asked whether to kill or let them continue. " +
			"Use Ctrl+Shift+B to manually background a running process. " +
			"Background job output is written to /tmp/pi-bg-<jobId>.log.",
		promptSnippet: "Execute shell commands (backgroundable with Ctrl+Shift+B)",
		promptGuidelines: [
			"Use bash_bg when you know a command should run in background from the start.",
			"Use the jobs tool with action 'list' to check background job status.",
			"Use the jobs tool with action 'output' to read a background job's output file.",
		],

		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | undefined>> {
			const { command } = params;

			return new Promise<AgentToolResult<BashToolDetails | undefined>>((resolve, reject) => {
				const proc = spawn("bash", ["-c", command], {
					stdio: ["pipe", "pipe", "pipe"],
					cwd: ctx.cwd,
					detached: true,
					env: { ...process.env },
				});

				if (!proc.pid) {
					reject(new Error("Failed to spawn process"));
					return;
				}

				const rp: RunningProcess = {
					toolCallId,
					proc,
					command,
					backgrounded: false,
					resolve,
					reject,
				};

				runningProcesses.set(toolCallId, rp);
				currentlyRunningToolCallId = toolCallId;

				let output = "";
				let outputFd: ReturnType<typeof createWriteStream> | undefined;

				// Stream handler — accumulates output for foreground streaming.
				// Listeners are removed by backgroundProcess() when the process is backgrounded.
				function handleData(data: Buffer, _stream: "stdout" | "stderr"): void {
					const chunk = data.toString();
					output += chunk;

					// Foreground streaming
					onUpdate?.({
						content: [{ type: "text" as const, text: output }],
						details: undefined,
					});
				}

				// Store listener references so backgroundProcess() can remove them later.
				const stdoutListener = (data: Buffer) => handleData(data, "stdout");
				const stderrListener = (data: Buffer) => handleData(data, "stderr");
				rp.stdoutListener = stdoutListener;
				rp.stderrListener = stderrListener;
				proc.stdout?.on("data", stdoutListener);
				proc.stderr?.on("data", stderrListener);

				proc.on("close", (code) => {
					runningProcesses.delete(toolCallId);
					if (currentlyRunningToolCallId === toolCallId) {
						currentlyRunningToolCallId = null;
					}
					if (outputFd) { outputFd.end(); outputFd = undefined; }
					if (rp.logStream) { rp.logStream.end(); rp.logStream = undefined; }

					if (rp.backgrounded) {
						const job = Array.from(backgroundJobs.values())
							.find(j => j.toolCallId === toolCallId);
						if (job) {
							markJobTerminal(
								job,
								(code === 0 || code === null) ? "completed" : "failed",
								code ?? 0,
							);
							notifyCompletion(job, ctx);
							updateWidget(ctx);
						}
					} else {
						resolve({
							content: [{ type: "text" as const, text: output || "(no output)" }],
							details: undefined,
						});
					}
				});

				proc.on("error", (err) => {
					runningProcesses.delete(toolCallId);
					if (currentlyRunningToolCallId === toolCallId) {
						currentlyRunningToolCallId = null;
					}
					if (outputFd) { outputFd.end(); outputFd = undefined; }
					if (rp.logStream) { rp.logStream.end(); rp.logStream = undefined; }

					if (rp.backgrounded) {
						const job = Array.from(backgroundJobs.values())
							.find(j => j.toolCallId === toolCallId);
						if (job) {
							markJobTerminal(job, "failed");
							notifyCompletion(job, ctx);
							updateWidget(ctx);
						}
					} else {
						reject(err);
					}
				});

				// Handle abort signal (for normal cancellation, not backgrounding)
				if (signal) {
					signal.addEventListener("abort", () => {
						if (!rp.backgrounded) {
							killProcessGroup(proc.pid!, "SIGTERM");
							runningProcesses.delete(toolCallId);
							if (currentlyRunningToolCallId === toolCallId) {
								currentlyRunningToolCallId = null;
							}
							reject(new Error("Command cancelled"));
						}
					});
				}

				// Default timeout — backgrounds and asks the agent what to do
				startTimeoutTimer(rp, ctx);
			});
		},
	});

	// ── bash_bg tool — start in background immediately ─────────────────

	pi.registerTool({
		name: "bash_bg",
		label: "Background Bash",
		description:
			"Run a bash command in background immediately. Output is written to /tmp/pi-bg-<jobId>.log. " +
			"Use the jobs tool to check status and read output.",
		promptSnippet: "Run bash command in background without blocking conversation",
		promptGuidelines: [
			"Use bash_bg when you want to start a long-running command in background immediately.",
			"This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Command to run in background" }),
			notify: Type.Optional(Type.Boolean({ description: "Notify when complete (default: true)" })),
		}),

		async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const jobId = generateJobId(++jobCounter);
			const path = logPathForJob(jobId);
			const shouldNotify = params.notify !== false;

			const proc = spawn("bash", ["-c", params.command], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: ctx.cwd,
				detached: true,
				env: { ...process.env },
			});

			if (!proc.pid) {
				throw new Error("Failed to spawn background process");
			}

			const job: BackgroundJob = {
				id: jobId,
				command: params.command,
				pid: proc.pid,
				startTime: Date.now(),
				status: "running",
				logPath: path,
				proc,
				toolCallId,
			};
			createJobDonePromise(job);
			backgroundJobs.set(jobId, job);

			// Write output to log file
			const logStream = createWriteStream(path, { flags: "w" });
			proc.stdout?.pipe(logStream, { end: false });
			proc.stderr?.pipe(logStream, { end: false });

			// Stall watchdog
			// Stall watchdog (with kill-on-oversize)
			const cancelStall = startStallWatchdog(jobId, params.command, path, pi, () => {
				if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
				markJobTerminal(job, "killed");
			});

			proc.on("close", (code) => {
				cancelStall();
				logStream.end();
				markJobTerminal(job, (code === 0 || code === null) ? "completed" : "failed", code ?? 0);

				if (shouldNotify) {
					notifyCompletion(job, ctx);
				}
				updateWidget(ctx);
			});

			proc.on("error", (err) => {
				cancelStall();
				logStream.end();
				markJobTerminal(job, "failed");
				if (shouldNotify) {
					notifyCompletion(job, ctx);
				}
				updateWidget(ctx);
			});

			updateWidget(ctx);

			return {
				content: [{
					type: "text" as const,
					text: `Started background job ${jobId}\nCommand: ${params.command}\nPID: ${proc.pid}\nOutput: ${path}`,
				}],
				details: undefined,
			};
		},
	});

	// ── jobs tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "jobs",
		label: "Background Jobs",
		description: "List, inspect, kill, or attach to background jobs. Output is read from disk files.",
		promptSnippet: "Manage background jobs (list/output/kill/attach)",
		promptGuidelines: [
			"Use jobs with action 'list' to see all background jobs.",
			"Use jobs with action 'output' to read a job's output from its log file.",
			"Use jobs with action 'kill' to terminate a running background job.",
			"Use jobs with action 'attach' to wait for a running job and get its final output.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "output", "kill", "attach"] as const, {
				description: "Action to perform",
			}),
			jobId: Type.Optional(Type.String({ description: "Job ID for output/kill/attach" })),
			wait: Type.Optional(Type.Boolean({ description: "For attach: wait for completion (default true)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			switch (params.action) {
				case "list": {
					const jobs = Array.from(backgroundJobs.values());
					const lines = jobs.map(formatJobLine);
					return {
						content: [{
							type: "text" as const,
							text: lines.length > 0
								? `Background Jobs:\n${lines.join("\n")}`
								: "No background jobs",
						}],
						details: undefined,
					};
				}

				case "output": {
					if (!params.jobId) throw new Error("jobId is required for action=output");
					const job = backgroundJobs.get(params.jobId);
					if (!job) throw new Error(`Job not found: ${params.jobId}`);
					const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
					return {
						content: [{
							type: "text" as const,
							text: `Output for ${job.id} (${job.status})\nLog: ${job.logPath}\n\n${output}`,
						}],
						details: undefined,
					};
				}

				case "kill": {
					if (!params.jobId) throw new Error("jobId is required for action=kill");
					const job = backgroundJobs.get(params.jobId);
					if (!job) throw new Error(`Job not found: ${params.jobId}`);
					if (job.status !== "running" || !job.proc) {
						throw new Error(`Job is not running: ${job.id}`);
					}
					killProcessGroup(job.proc.pid!, "SIGTERM");
					markJobTerminal(job, "killed");
					return {
						content: [{ type: "text" as const, text: `Sent SIGTERM to ${job.id} (process group)` }],
						details: undefined,
					};
				}

				case "attach": {
					if (!params.jobId) throw new Error("jobId is required for action=attach");
					const job = backgroundJobs.get(params.jobId);
					if (!job) throw new Error(`Job not found: ${params.jobId}`);

					const waitForCompletion = params.wait ?? true;

					if (job.status === "running" && waitForCompletion) {
						if (!job.donePromise) createJobDonePromise(job);

						onUpdate?.({
							content: [{ type: "text" as const, text: `Attaching to ${job.id} (${job.status})...` }],
							details: undefined,
						});

						await job.donePromise;
					}

					const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
					return {
						content: [{
							type: "text" as const,
							text: `Attach finished for ${job.id}. Status: ${job.status}\nLog: ${job.logPath}\n\n${output}`,
						}],
						details: undefined,
					};
				}
			}
		},
	});

	// ── Keyboard shortcuts ─────────────────────────────────────────────

	async function handleBackgroundShortcut(ctx: UiContext): Promise<void> {
		if (!currentlyRunningToolCallId) {
			ctx.ui.notify("No running bash process to background", "warning");
			return;
		}

		const rp = runningProcesses.get(currentlyRunningToolCallId);
		if (!rp || rp.backgrounded) {
			ctx.ui.notify("No active process to background", "warning");
			return;
		}

		backgroundProcess(rp, ctx);
	}

	pi.registerShortcut("ctrl+shift+b", {
		description: "Background current bash process",
		handler: handleBackgroundShortcut,
	});

	pi.registerShortcut("ctrl+j", {
		description: "Open background jobs interface",
		handler: async (ctx) => {
			await showJobsInterface(ctx);
		},
	});

	// ── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("bg", {
		description: "Background the currently running bash process",
		handler: async (_args, ctx) => {
			if (!currentlyRunningToolCallId) {
				ctx.ui.notify("No running bash process to background", "warning");
				return;
			}

			const rp = runningProcesses.get(currentlyRunningToolCallId);
			if (!rp || rp.backgrounded) {
				ctx.ui.notify("No active process to background", "warning");
				return;
			}

			backgroundProcess(rp, ctx);
		},
	});

	pi.registerCommand("fg", {
		description: "Attach to a background job (/fg [job-id] [--snapshot]); defaults to most recent running job",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const snapshot = parts.includes("--snapshot") || parts.includes("-s");
			const explicitJobId = parts.find(p => !p.startsWith("-"));

			let job: BackgroundJob | undefined;
			if (explicitJobId) {
				job = backgroundJobs.get(explicitJobId);
				if (!job) {
					ctx.ui.notify(`Job not found: ${explicitJobId}`, "error");
					return;
				}
			} else {
				job = Array.from(backgroundJobs.values())
					.filter(j => j.status === "running")
					.sort((a, b) => b.startTime - a.startTime)[0];

				if (!job) {
					ctx.ui.notify("No running background jobs to attach. Usage: /fg [job-id] [--snapshot]", "warning");
					return;
				}
			}

			ctx.ui.setStatus("bg-fg", `Attaching to ${job.id}${snapshot ? " (snapshot mode)" : ""}...`);
			try {
				if (!snapshot && job.status === "running") {
					if (!job.donePromise) createJobDonePromise(job);
					await job.donePromise;
				}

				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				const fullText =
					`Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
					`PID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n` +
					`Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;

				pi.sendMessage({
					customType: "bg-attach",
					content: fullText,
					display: true,
					details: { jobId: job.id, logPath: job.logPath },
				}, {
					deliverAs: "steer",
					triggerTurn: false,
				});
				ctx.ui.notify(`Attached output posted for ${job.id}`, "info");
			} finally {
				ctx.ui.setStatus("bg-fg", undefined);
			}
		},
	});

	pi.registerCommand("jobs", {
		description: "Show and manage background jobs interactively",
		handler: async (_args, ctx) => {
			await showJobsInterface(ctx);
		},
	});

	// ── Interactive jobs interface ──────────────────────────────────────

	async function showJobsInterface(ctx: UiContext): Promise<void> {
		const jobs = Array.from(backgroundJobs.values());

		if (jobs.length === 0) {
			ctx.ui.notify("No background jobs", "info");
			return;
		}

		const choice = await ctx.ui.select(
			"Background Jobs",
			jobs.map(job => {
				const duration = formatDuration(Date.now() - job.startTime);
				const status =
					job.status === "running" ? `⏳ (${duration})` :
					job.status === "completed" ? "✅" :
					job.status === "failed" ? "❌" :
					"🛑";
				return `${status} ${job.id}: ${job.command.slice(0, 40)}`;
			}),
		);

		if (choice === undefined) return;
		const job = jobs[choice];

		const actions = job.status === "running"
			? ["Attach Foreground", "Show Output", "Kill Job"]
			: ["Show Output", "Remove from List"];

		const action = await ctx.ui.select(`Job: ${job.id}`, actions);
		if (action === undefined) return;

		if (job.status === "running") {
			if (action === 0) {
				// Attach Foreground
				ctx.ui.setStatus("bg-fg", `Attaching to ${job.id}...`);
				if (!job.donePromise) createJobDonePromise(job);
				await job.donePromise;
				ctx.ui.setStatus("bg-fg", undefined);

				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				const fullText =
					`Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
					`Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;

				pi.sendMessage({
					customType: "bg-attach",
					content: fullText,
					display: true,
					details: { jobId: job.id, logPath: job.logPath },
				}, {
					deliverAs: "steer",
					triggerTurn: false,
				});
				ctx.ui.notify(`Attached output posted for ${job.id}`, "info");
			} else if (action === 1) {
				// Show Output
				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				const fullText =
					`Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
					`PID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n` +
					`Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;
				await ctx.ui.editor(`Output for ${job.id}`, fullText);
			} else if (action === 2 && job.proc) {
				// Kill
				killProcessGroup(job.proc.pid!, "SIGTERM");
				markJobTerminal(job, "killed");
				ctx.ui.notify(`Killed job ${job.id} (process group)`, "info");
				updateWidget(ctx);
			}
		} else {
			if (action === 0) {
				// Show Output
				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				const fullText =
					`Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
					`PID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n` +
					`Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`;
				await ctx.ui.editor(`Output for ${job.id}`, fullText);
			} else if (action === 1) {
				// Remove from List
				backgroundJobs.delete(job.id);
				ctx.ui.notify(`Removed job ${job.id}`, "info");
				updateWidget(ctx);
			}
		}
	}

	// ── Lifecycle events ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "background-tasks-state") {
				const data = entry.data as {
					jobs?: Array<[string, Omit<BackgroundJob, "proc" | "donePromise" | "resolveDone">]>;
					jobCounter?: number;
				};
				if (data.jobs) {
					for (const [id, jobData] of data.jobs) {
						if (jobData.status !== "running") {
							backgroundJobs.set(id, jobData as BackgroundJob);
						}
					}
				}
				if (typeof data.jobCounter === "number") {
					jobCounter = Math.max(jobCounter, data.jobCounter);
				}
				break;
			}
		}
	});

	// ── Notifications ────────────────────────────────────────────────────

	const NOTIFICATION_BODY_MAX = 200;

	function truncateNotificationBody(text: string): string {
		const firstLine = text.split("\n")[0] ?? "";
		if (firstLine.length <= NOTIFICATION_BODY_MAX) return firstLine;
		return firstLine.slice(0, NOTIFICATION_BODY_MAX - 1) + "\u2026"; // ellipsis
	}

	/** Extract the last assistant text from the message history. */
	function lastAssistantText(messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> }>): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						return block.text;
					}
				}
			}
		}
		return undefined;
	}

	pi.on("agent_end", async (event) => {
		const body = lastAssistantText(event.messages);
		const notificationBody = body ? truncateNotificationBody(body) : "Ready for input";
		notify("Pi", notificationBody);
	});

	pi.on("session_shutdown", async () => {
		// Kill all running background jobs
		for (const job of backgroundJobs.values()) {
			if (job.proc && job.status === "running") {
				killProcessGroup(job.proc.pid!, "SIGTERM");
			}
		}

		// Persist state
		pi.appendEntry("background-tasks-state", {
			jobs: Array.from(backgroundJobs.entries()).map(([id, job]) => [id, {
				...job,
				proc: undefined,
				donePromise: undefined,
				resolveDone: undefined,
			}]),
			jobCounter,
		});
	});
}
