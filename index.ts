/**
 * Tau (τ) — Quality-of-Life Extension for pi
 *
 * Background tasks (Claude Code Ctrl+B UX):
 * - Ctrl+B backgrounds bash processes, backgrounds the agent loop, or resumes
 * - Background hint after 2s of agent activity
 * - 15s default timeout: auto-backgrounds and asks the agent to decide
 * - Pill bar at the bottom showing running background tasks
 * - Output written to disk files (/tmp/pi-bg-<jobId>.log)
 * - Process-group kill via process.kill(-pid)
 * - Stall detection and size watchdog
 *
 * Notifications: native terminal notification on agent_end
 * Titlebar: braille spinner while agent is active
 * Status line: elapsed time during agent runs
 *
 * Tools: bash (overridden), bash_bg, jobs, todo
 * Commands: /bg, /fg, /jobs, /todos, /tools, /plan
 * Shortcuts: Ctrl+B (background/resume), Ctrl+J / Shift+Down (tasks), Ctrl+X (kill), Ctrl+Alt+P (plan mode)
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createBashTool, getSettingsListTheme, type BashToolDetails, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Container, type SettingItem, SettingsList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, statSync, existsSync, openSync, readSync, closeSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./plan-utils.js";

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

/** Default timeout for foreground bash commands.
 *  Matches Claude Code's ASSISTANT_BLOCKING_BUDGET_MS (15s). After this,
 *  the process is backgrounded and the agent is asked whether to kill or continue. */
const DEFAULT_TIMEOUT_MS = 15_000;
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
		select(title: string, options: string[]): Promise<string | undefined>;
		editor(title: string, content: string): Promise<string | undefined>;
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
	let turnCount = 0;
	let agentStartTime: number | undefined;
	let agentTimer: ReturnType<typeof setInterval> | null = null;

	// ── Plan-mode state ──────────────────────────────────────────────────

	const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
	const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
	let planModeEnabled = false;
	let planExecutionMode = false;
	let planItems: TodoItem[] = [];

	// ── Todo state ───────────────────────────────────────────────────────

	interface Todo {
		id: number;
		text: string;
		done: boolean;
	}

	interface TodoDetails {
		action: "list" | "add" | "toggle" | "clear";
		todos: Todo[];
		nextId: number;
		error?: string;
	}

	let todos: Todo[] = [];
	let nextTodoId = 1;

	// ── Tools-selector state ─────────────────────────────────────────────

	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	/** Currently running bash toolCallId (for Ctrl+B). */
	let currentlyRunningToolCallId: string | null = null;

	/** Agent background state. When true, tool_call events are blocked so the
	 *  agent yields control back to the user. Ctrl+B again resumes. */
	let agentBackgrounded = false;

	/** Timer for the background hint shown after 2s of agent activity. */
	let backgroundHintTimer: NodeJS.Timeout | undefined;

	// ── Titlebar spinner ────────────────────────────────────────────────

	const BRAILLE_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
	let titlebarTimer: ReturnType<typeof setInterval> | null = null;
	let titlebarFrameIndex = 0;

	function getTitleBase(): string {
		const cwd = path.basename(process.cwd());
		const session = pi.getSessionName();
		return session ? `\u03c0 - ${session} - ${cwd}` : `\u03c0 - ${cwd}`;
	}

	function startTitlebarSpinner(ctx: { ui: { setTitle(title: string): void } }): void {
		stopTitlebarSpinner(ctx);
		titlebarTimer = setInterval(() => {
			const frame = BRAILLE_FRAMES[titlebarFrameIndex % BRAILLE_FRAMES.length];
			ctx.ui.setTitle(`${frame} ${getTitleBase()}`);
			titlebarFrameIndex++;
		}, 80);
	}

	function stopTitlebarSpinner(ctx: { ui: { setTitle(title: string): void } }): void {
		if (titlebarTimer) {
			clearInterval(titlebarTimer);
			titlebarTimer = null;
		}
		titlebarFrameIndex = 0;
		ctx.ui.setTitle(getTitleBase());
	}

	// ── Widget / status bar ────────────────────────────────────────────

	function updateWidget(ctx: UiContext): void {
		const allJobs = Array.from(backgroundJobs.values());
		const runningJobs = allJobs.filter(job => job.status === "running");

		if (runningJobs.length === 0 && !agentBackgrounded) {
			ctx.ui.setWidget("background-jobs", undefined);
			ctx.ui.setStatus("background-jobs", undefined);
			return;
		}

		// Pill bar: ◐ job-1: cmd (12s) · ◐ job-2: cmd (8s)
		const pills: string[] = [];
		if (agentBackgrounded) {
			pills.push("◐ agent (backgrounded)");
		}
		for (const job of runningJobs) {
			const duration = formatDuration(Date.now() - job.startTime);
			pills.push(`◐ ${job.id}: ${job.command.slice(0, 25)} (${duration})`);
		}
		ctx.ui.setWidget("background-jobs", pills);

		const completedJobs = allJobs.filter(job => job.status === "completed").length;
		const failedJobs = allJobs.filter(job => job.status === "failed").length;

		let statusText = `${runningJobs.length} running`;
		if (completedJobs > 0) statusText += `, ${completedJobs} done`;
		if (failedJobs > 0) statusText += `, ${failedJobs} failed`;

		ctx.ui.setStatus(
			"background-jobs",
			ctx.ui.theme.fg("accent", `◐ ${statusText}`),
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

	// ── Plan-mode helpers ─────────────────────────────────────────────────

	function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
		return m.role === "assistant" && Array.isArray(m.content);
	}

	function getTextContent(message: AssistantMessage): string {
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}

	function updatePlanStatus(ctx: ExtensionContext): void {
		if (planExecutionMode && planItems.length > 0) {
			const completed = planItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `\ud83d\udccb ${completed}/${planItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "\u23f8 plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (planExecutionMode && planItems.length > 0) {
			const lines = planItems.map((item) => {
				if (item.completed) {
					return ctx.ui.theme.fg("success", "\u2611 ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				}
				return `${ctx.ui.theme.fg("muted", "\u2610 ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		planExecutionMode = false;
		planItems = [];

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updatePlanStatus(ctx);
	}

	// ── Todo helpers ──────────────────────────────────────────────────────

	function reconstructTodoState(ctx: ExtensionContext): void {
		todos = [];
		nextTodoId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextTodoId = details.nextId;
			}
		}
	}

	// ── Tools-selector helpers ────────────────────────────────────────────

	function persistToolsState(): void {
		pi.appendEntry("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	function applyToolsSelection(): void {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function restoreToolsFromBranch(ctx: ExtensionContext): void {
		allTools = pi.getAllTools();
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;
		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as { enabledTools?: string[] } | undefined;
				if (data?.enabledTools) savedTools = data.enabledTools;
			}
		}
		if (savedTools) {
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t) => allToolNames.includes(t)));
			applyToolsSelection();
		} else {
			enabledTools = new Set(pi.getActiveTools());
		}
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

				// Default timeout \u2014 backgrounds and asks the agent what to do
				startTimeoutTimer(rp, ctx);

				// Background hint after 2s of bash execution (matches Claude Code)
				const hintTimer = setTimeout(() => {
					ctx.ui.notify("\u23f1 Ctrl+B to background", "info");
				}, 2_000);
				hintTimer.unref();
				rp.proc.on("close", () => clearTimeout(hintTimer));
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
		// If the agent is backgrounded, bring it back.
		if (agentBackgrounded) {
			agentBackgrounded = false;
			if (backgroundHintTimer) { clearTimeout(backgroundHintTimer); backgroundHintTimer = undefined; }
			ctx.ui.setStatus("agent-backgrounded", undefined);
			updateWidget(ctx);
			ctx.ui.notify("\u25b6 Resumed", "success");

			pi.sendMessage({
				customType: "agent-resume",
				content: "Continuing where you left off.",
				display: true,
			}, {
				deliverAs: "followUp",
				triggerTurn: true,
			});
			return;
		}

		// Background everything: bash process AND agent loop.
		let didBackgroundBash = false;
		if (currentlyRunningToolCallId) {
			const rp = runningProcesses.get(currentlyRunningToolCallId);
			if (rp && !rp.backgrounded) {
				backgroundProcess(rp, ctx);
				didBackgroundBash = true;
			}
		}

		agentBackgrounded = true;
		if (backgroundHintTimer) { clearTimeout(backgroundHintTimer); backgroundHintTimer = undefined; }
		ctx.ui.setStatus("agent-backgrounded", ctx.ui.theme.fg("warning", "\u23f8 Backgrounded"));
		updateWidget(ctx);

		if (didBackgroundBash) {
			ctx.ui.notify("\u23f8 Backgrounded bash + agent. Ctrl+B to resume.", "info");
		} else {
			ctx.ui.notify("\u23f8 Backgrounded. Ctrl+B to resume.", "info");
		}
	}

	pi.registerShortcut("ctrl+b", {
		description: "Background bash/agent, or resume backgrounded agent",
		handler: handleBackgroundShortcut,
	});

	pi.registerShortcut("ctrl+j", {
		description: "Open background tasks",
		handler: async (ctx) => {
			await showTasksInterface(ctx);
		},
	});

	pi.registerShortcut("shift+down", {
		description: "Open background tasks",
		handler: async (ctx) => {
			await showTasksInterface(ctx);
		},
	});

	pi.registerShortcut("ctrl+x", {
		description: "Kill most recent running background task",
		handler: async (ctx) => {
			const runningJobs = Array.from(backgroundJobs.values())
				.filter(j => j.status === "running")
				.sort((a, b) => b.startTime - a.startTime);

			if (runningJobs.length === 0) {
				ctx.ui.notify("No running tasks to kill", "warning");
				return;
			}

			const job = runningJobs[0];
			if (job.proc) killProcessGroup(job.proc.pid!, "SIGTERM");
			markJobTerminal(job, "killed");
			ctx.ui.notify(`Killed ${job.id}`, "info");
			updateWidget(ctx);
		},
	});

	// ── Agent backgrounding ─────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		startTitlebarSpinner(ctx);
		agentStartTime = Date.now();

		// Update status line every second with elapsed time.
		agentTimer = setInterval(() => {
			if (agentStartTime === undefined) return;
			const elapsed = formatDuration(Date.now() - agentStartTime);
			const spinner = ctx.ui.theme.fg("accent", "\u25cf");
			ctx.ui.setStatus("tau-turn", spinner + ctx.ui.theme.fg("dim", ` ${elapsed}`));
		}, 1_000);
	});

	pi.on("tool_call", async (_event): Promise<ToolCallEventResult> => {
		// Agent backgrounding
		if (agentBackgrounded) {
			return { block: true, reason: "" };
		}

		// Plan-mode: block destructive bash commands
		if (planModeEnabled && _event.toolName === "bash") {
			const command = _event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
		}

		return {};
	});

	// Background hint: after 2s of agent activity, show the shortcut.
	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		if (backgroundHintTimer) clearTimeout(backgroundHintTimer);
		backgroundHintTimer = setTimeout(() => {
			ctx.ui.notify("\u23f1 Ctrl+B to background", "info");
			backgroundHintTimer = undefined;
		}, 2_000);
		backgroundHintTimer.unref();
	});

	pi.on("turn_end", async (event, ctx) => {
		// Plan-mode progress tracking
		if (planExecutionMode && planItems.length > 0) {
			if (isAssistantMessage(event.message)) {
				const text = getTextContent(event.message);
				if (markCompletedSteps(text, planItems) > 0) {
					updatePlanStatus(ctx);
				}
			}
		}
	});

	// Plan-mode: inject context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (planExecutionMode && planItems.length > 0) {
			const remaining = planItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Plan-mode: filter out stale context when not active
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Plan-mode: restore state on branch navigation
	pi.on("session_tree", async (_event, ctx) => {
		reconstructTodoState(ctx);
		restoreToolsFromBranch(ctx);
	});

	pi.registerCommand("bg", {
		description: "Background bash/agent, or resume backgrounded agent",
		handler: async (_args, ctx) => {
			await handleBackgroundShortcut(ctx);
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
		description: "Show and manage background tasks",
		handler: async (_args, ctx) => {
			await showTasksInterface(ctx);
		},
	});


	// ── Interactive tasks interface ────────────────────────────────────

	async function showTaskDetail(job: BackgroundJob, ctx: UiContext): Promise<void> {
		const duration = formatDuration(Date.now() - job.startTime);
		const statusIcon =
			job.status === "running" ? "\u25d0" :
			job.status === "completed" ? "\u2705" :
			job.status === "failed" ? "\u274c" :
			"\ud83d\udea1";

		if (job.status === "running") {
			const actions = ["Attach (wait for completion)", "Show Output", "Kill"];
			const action = await ctx.ui.select(
				`${statusIcon} ${job.id} \u00b7 ${job.command.slice(0, 50)} \u00b7 ${duration}`,
				actions,
			);
			if (action === undefined) return;

			if (action === actions[0]) {
				// Attach \u2014 wait for completion then post output
				ctx.ui.setStatus("bg-fg", `Attaching to ${job.id}...`);
				if (!job.donePromise) createJobDonePromise(job);
				await job.donePromise;
				ctx.ui.setStatus("bg-fg", undefined);

				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				const fullText =
					`${job.id} \u00b7 ${job.command}\n` +
					`Status: ${job.status} \u00b7 Duration: ${formatDuration(Date.now() - job.startTime)}\n` +
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
				ctx.ui.notify(`Attached ${job.id}`, "info");
			} else if (action === actions[1]) {
				// Show Output
				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				await ctx.ui.editor(
					`${statusIcon} ${job.id}: ${job.command.slice(0, 50)}`,
					`Command: ${job.command}\n` +
					`PID: ${job.pid} \u00b7 Started: ${new Date(job.startTime).toLocaleString()}\n` +
					`Duration: ${duration} \u00b7 Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`,
				);
			} else if (action === actions[2]) {
				// Kill
				if (job.proc) killProcessGroup(job.proc.pid!, "SIGTERM");
				markJobTerminal(job, "killed");
				ctx.ui.notify(`Killed ${job.id}`, "info");
				updateWidget(ctx);
			}
		} else {
			// Completed/failed/killed
			const actions = ["Show Output", "Remove from List"];
			const action = await ctx.ui.select(
				`${statusIcon} ${job.id} \u00b7 ${job.command.slice(0, 50)} \u00b7 ${job.status}`,
				actions,
			);
			if (action === undefined) return;

			if (action === actions[0]) {
				const output = await readOutputTail(job.logPath, MAX_OUTPUT_PREVIEW_CHARS);
				await ctx.ui.editor(
					`${statusIcon} ${job.id}: ${job.command.slice(0, 50)}`,
					`Command: ${job.command}\n` +
					`PID: ${job.pid} \u00b7 Started: ${new Date(job.startTime).toLocaleString()}\n` +
					`Status: ${job.status} \u00b7 Exit code: ${job.exitCode ?? "n/a"}\n` +
					`Duration: ${duration} \u00b7 Log: ${job.logPath}\n\n--- OUTPUT ---\n${output}`,
				);
			} else if (action === actions[1]) {
				backgroundJobs.delete(job.id);
				ctx.ui.notify(`Removed ${job.id}`, "info");
				updateWidget(ctx);
			}
		}
	}

	async function showTasksInterface(ctx: UiContext): Promise<void> {
		const allJobs = Array.from(backgroundJobs.values());
		const runningJobs = allJobs.filter(j => j.status === "running");
		const finishedJobs = allJobs.filter(j => j.status !== "running");

		// Include the backgrounded agent as a virtual task entry.
		const items: string[] = [];
		if (agentBackgrounded) {
			items.push("\u25d0 agent \u00b7 backgrounded \u00b7 Ctrl+B to resume");
		}
		for (const job of runningJobs) {
			const duration = formatDuration(Date.now() - job.startTime);
			items.push(`\u25d0 ${job.id}: ${job.command.slice(0, 40)} \u00b7 ${duration}`);
		}
		for (const job of finishedJobs) {
			const statusIcon =
				job.status === "completed" ? "\u2705" :
				job.status === "failed" ? "\u274c" :
				"\ud83d\udea1";
			items.push(`${statusIcon} ${job.id}: ${job.command.slice(0, 40)}`);
		}

		if (items.length === 0) {
			ctx.ui.notify("No background tasks", "info");
			return;
		}

		const choice = await ctx.ui.select("Background Tasks", items);
		if (choice === undefined) return;

		// Agent backgrounded entry
		if (agentBackgrounded && choice === items[0]) {
			await handleBackgroundShortcut(ctx);
			return;
		}

		// Find the job from the selected text.
		const selectedJob = [...runningJobs, ...finishedJobs].find(j =>
			choice?.includes(j.id),
		);
		if (selectedJob) {
			await showTaskDetail(selectedJob, ctx);
		}
	}

	// ── Todo tool (for the LLM) ──────────────────────────────────────────

	const TodoParams = Type.Object({
		action: StringEnum(["list", "add", "toggle", "clear"] as const),
		text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
		id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{
							type: "text",
							text: todos.length
								? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
								: "No todos",
						}],
						details: { action: "list", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId: nextTodoId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextTodoId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId: nextTodoId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "toggle", todos: [...todos], nextId: nextTodoId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					todo.done = !todo.done;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextTodoId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", todos: [...todos], nextId: nextTodoId, error: `unknown action: ${params.action}` } as TodoDetails,
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			switch (details.action) {
				case "list": {
					const todoList = details.todos;
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "\u2713") : theme.fg("dim", "\u25cb");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}
				case "add": {
					const added = details.todos[details.todos.length - 1];
					return new Text(theme.fg("success", "\u2713 Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text), 0, 0);
				}
				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// ── /todos command (for the user) ────────────────────────────────────

	class TodoListComponent {
		private list: Todo[];
		private theme: { fg(colour: string, text: string): string; bold(text: string): string; strikethrough(text: string): string };
		private onClose: () => void;
		private cachedWidth?: number;
		private cachedLines?: string[];

		constructor(todos: Todo[], theme: { fg(colour: string, text: string): string; bold(text: string): string; strikethrough(text: string): string }, onClose: () => void) {
			this.list = todos;
			this.theme = theme;
			this.onClose = onClose;
		}

		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
		}

		render(width: number): string[] {
			if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

			const lines: string[] = [];
			const th = this.theme;

			lines.push("");
			const title = th.fg("accent", " Todos ");
			const headerLine = th.fg("borderMuted", "\u2500".repeat(3)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 10)));
			lines.push(truncateToWidth(headerLine, width));
			lines.push("");

			if (this.list.length === 0) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
			} else {
				const done = this.list.filter((t) => t.done).length;
				const total = this.list.length;
				lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

				for (const todo of this.list) {
					const check = todo.done ? th.fg("success", "\u2713") : th.fg("dim", "\u25cb");
					const id = th.fg("accent", `#${todo.id}`);
					const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
					lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
				}
			}

			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
			lines.push("");

			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		invalidate(): void {
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
		}
	}

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});

	// ── /tools command ───────────────────────────────────────────────────

	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			allTools = pi.getAllTools();

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(new (class {
					render(_width: number) {
						return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
					}
					invalidate() {}
				})());

				const settingsList = new SettingsList(
					items,
				Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === "enabled") enabledTools.add(id);
						else enabledTools.delete(id);
						applyToolsSelection();
						persistToolsState();
					},
					() => done(undefined),
				);

					container.addChild(settingsList);

				return {
					render(width: number) { return container.render(width); },
					invalidate() { container.invalidate(); },
					handleInput(data: string) { settingsList.handleInput?.(data); },
				};
			});
		},
	});

	// ── Plan mode ────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ── Lifecycle events ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Status line: ready indicator
		ctx.ui.setStatus("tau-turn", ctx.ui.theme.fg("dim", "Ready"));

		// Restore background-tasks state
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

		// Restore plan-mode state
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			planItems = planModeEntry.data.todos ?? planItems;
			planExecutionMode = planModeEntry.data.executing ?? planExecutionMode;
		}

		// On resume: re-scan messages to rebuild plan completion state
		if (planModeEntry !== undefined && planExecutionMode && planItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") { executeIndex = i; break; }
			}
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, planItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updatePlanStatus(ctx);

		// Restore todo state
		reconstructTodoState(ctx);

		// Restore tools-selector state
		restoreToolsFromBranch(ctx);
	});

	// ── Notifications ────────────────────────────────────────────────────

	const NOTIFICATION_BODY_MAX = 200;

	function truncateNotificationBody(text: string): string {
		const firstLine = text.split("\n")[0] ?? "";
		if (firstLine.length <= NOTIFICATION_BODY_MAX) return firstLine;
		return firstLine.slice(0, NOTIFICATION_BODY_MAX - 1) + "\u2026"; // ellipsis
	}

	/** Extract the last assistant text from the message history. */
	function lastAssistantText(messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>): string | undefined {
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

	pi.on("agent_end", async (event, ctx) => {
		stopTitlebarSpinner(ctx);

		// Stop the elapsed timer and show final duration.
		if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
		if (agentStartTime !== undefined) {
			const elapsed = formatDuration(Date.now() - agentStartTime);
			const check = ctx.ui.theme.fg("success", "\u2713");
			ctx.ui.setStatus("tau-turn", check + ctx.ui.theme.fg("dim", ` ${elapsed}`));
			agentStartTime = undefined;
		}

		// ── Plan-mode: completion detection ──────────────────────────────
		if (planExecutionMode && planItems.length > 0) {
			if (planItems.every((t) => t.completed)) {
				const completedList = planItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** \u2713\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				planExecutionMode = false;
				planItems = [];
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updatePlanStatus(ctx);
				pi.appendEntry("plan-mode", { enabled: false, todos: [], executing: false });
			} else {
				pi.appendEntry("plan-mode", { enabled: planModeEnabled, todos: planItems, executing: planExecutionMode });
			}
		} else if (planModeEnabled && ctx.hasUI) {
			// Extract plan steps from last assistant message
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const extracted = extractTodoItems(getTextContent(lastAssistant));
				if (extracted.length > 0) planItems = extracted;
			}

			if (planItems.length > 0) {
				const todoListText = planItems.map((t, i) => `${i + 1}. \u2610 ${t.text}`).join("\n");
				pi.sendMessage(
					{ customType: "plan-todo-list", content: `**Plan Steps (${planItems.length}):**\n\n${todoListText}`, display: true },
					{ triggerTurn: false },
				);
			}

			const choice = await ctx.ui.select("Plan mode - what next?", [
				planItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
				"Stay in plan mode",
				"Refine the plan",
			]);

			if (choice?.startsWith("Execute")) {
				planModeEnabled = false;
				planExecutionMode = planItems.length > 0;
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updatePlanStatus(ctx);

				const execMessage = planItems.length > 0
					? `Execute the plan. Start with: ${planItems[0].text}`
					: "Execute the plan you just created.";
				pi.sendMessage(
					{ customType: "plan-mode-execute", content: execMessage, display: true },
					{ triggerTurn: true },
				);
			} else if (choice === "Refine the plan") {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
			}
		}

		// ── Notification ────────────────────────────────────────────────
		const body = lastAssistantText(event.messages);
		const notificationBody = body ? truncateNotificationBody(body) : "Ready for input";
		notify("Pi", notificationBody);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTitlebarSpinner(ctx);

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
