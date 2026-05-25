/**
 * Handoff feature — `/handoff` and `/handover` commands to transfer context
 * to a new focused session via LLM-generated context transfer prompts.
 *
 * `/handoff <goal>`           — Transfer within the same working directory.
 * `/handoff <goal> --dir <p>` — Transfer into a different directory.
 * `/handover <goal> [path]`   — Transfer into a different directory (alias
 *                                with auto-detected git root as default).
 *
 * When `--dir` is omitted on `/handoff`, or no path is given on `/handover`,
 * the last git repository touched by read/edit/write tools is used as the
 * default suggestion.
 *
 * Launch modes (default: terminal tab):
 *   --tab       New Terminal.app tab
 *   --tmux      New tmux session
 *   --clip      Copy command to clipboard
 *   --print     Print command only
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    BorderedLoader,
    convertToLlm,
    serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TauState } from "../state.ts";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

// ── Helpers ──────────────────────────────────────────────────────────

export function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
    if (entry.type === "message") {
        return entry.message;
    }
    if (entry.type === "compaction") {
        return {
            role: "compactionSummary",
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            timestamp: new Date(entry.timestamp).getTime(),
        };
    }
    return undefined;
}

export function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
    let compactionIndex = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
        if (branch[i].type === "compaction") {
            compactionIndex = i;
            break;
        }
    }
    if (compactionIndex < 0) {
        return branch
            .map(entryToMessage)
            .filter((message) => message !== undefined);
    }

    const compaction = branch[compactionIndex];
    const firstKeptIndex =
        compaction.type === "compaction"
            ? branch.findIndex(
                  (entry) => entry.id === compaction.firstKeptEntryId
              )
            : -1;
    const compactedBranch = [
        compaction,
        ...(firstKeptIndex >= 0
            ? branch.slice(firstKeptIndex, compactionIndex)
            : []),
        ...branch.slice(compactionIndex + 1),
    ];
    return compactedBranch
        .map(entryToMessage)
        .filter((message) => message !== undefined);
}

/**
 * Resolve the git repository root for a given file path.
 * Returns undefined if the path is not inside a git repo.
 */
export function gitRootForPath(
    filePath: string,
    cwd: string
): string | undefined {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    try {
        const root = execSync("git rev-parse --show-toplevel", {
            cwd: dirname(abs),
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return existsSync(root) ? root : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Walk the accessed file paths in reverse order and return the git root
 * of the most recently accessed file that is inside a git repo.
 */
export function detectLastGitRoot(
    accessedPaths: string[],
    cwd: string
): string | undefined {
    for (let i = accessedPaths.length - 1; i >= 0; i--) {
        const root = gitRootForPath(accessedPaths[i], cwd);
        if (root !== undefined) return root;
    }
    return undefined;
}

// ── Parsed arguments ─────────────────────────────────────────────────

interface HandoffArgs {
    goal: string;
    targetDir?: string;
    launchMode: "tab" | "tmux" | "clip" | "print";
}

const LAUNCH_FLAGS = ["--tab", "--tmux", "--clip", "--print"] as const;

/**
 * Parse `/handoff` or `/handover` arguments.
 *
 * `/handoff <goal> [--dir <path>] [--tab|--tmux|--clip|--print]`
 * `/handover <goal> [path] [--tab|--tmux|--clip|--print]`
 */
export function parseHandoffArgs(
    raw: string,
    isHandover: boolean
): HandoffArgs {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const goalParts: string[] = [];
    let targetDir: string | undefined;
    let launchMode: HandoffArgs["launchMode"] = "tab";

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];

        if (token === "--dir" && i + 1 < tokens.length) {
            targetDir = tokens[++i];
        } else if ((LAUNCH_FLAGS as readonly string[]).includes(token)) {
            launchMode = token.slice(2) as HandoffArgs["launchMode"];
        } else if (
            isHandover &&
            targetDir === undefined &&
            (isAbsolute(token) ||
                token.startsWith("./") ||
                token.startsWith("~/"))
        ) {
            // First path-like token in handover mode is the target directory
            targetDir = token;
        } else {
            goalParts.push(token);
        }
        i++;
    }

    return { goal: goalParts.join(" "), targetDir, launchMode };
}

// ── Launch helpers ───────────────────────────────────────────────────

function escapeShell(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildPiCommand(targetDir: string, prompt: string): string {
    return `cd ${escapeShell(targetDir)} && pi -p ${escapeShell(prompt)}`;
}

async function launchTab(command: string): Promise<void> {
    const osascript = `
        tell application "Terminal"
            activate
            set newTab to do script "${command.replace(/"/g, '\\"').replace(/\\/g, "\\\\")}"
        end tell
    `;
    execSync(`osascript -e '${osascript.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
    });
}

async function launchTmux(command: string): Promise<void> {
    const sessionName = `handoff-${Date.now()}`;
    execSync(
        `tmux new-session -d -s ${sessionName} "${command.replace(/"/g, '\\"')}"`,
        { encoding: "utf-8" }
    );
    execSync(`tmux switch-client -t ${sessionName}`, {
        encoding: "utf-8",
    });
}

async function launchClip(command: string): Promise<void> {
    const { execFileSync } = await import("node:child_process");
    execFileSync("pbcopy", { input: command, encoding: "utf-8" });
}

// ── Core handoff logic ───────────────────────────────────────────────

async function performHandoff(
    ctx: Parameters<
        Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
    >[1],
    args: HandoffArgs,
    accessedPaths: string[],
    cwd: string
): Promise<void> {
    if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
    }

    if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
    }

    if (!args.goal) {
        ctx.ui.notify(
            "Usage: /handoff <goal> [--dir <path>] [--tab|--tmux|--clip|--print]",
            "error"
        );
        return;
    }

    // Determine target directory
    let targetDir = args.targetDir;
    if (targetDir) {
        // Expand ~/
        if (targetDir.startsWith("~/")) {
            const { homedir } = await import("node:os");
            targetDir = resolve(homedir(), targetDir.slice(2));
        } else if (!isAbsolute(targetDir)) {
            targetDir = resolve(cwd, targetDir);
        }
    }

    // If still no target dir and different from cwd, suggest auto-detected root
    const autoRoot = detectLastGitRoot(accessedPaths, cwd);
    if (targetDir === undefined && autoRoot && autoRoot !== cwd) {
        const choice = await ctx.ui.select(`Handoff to which directory?`, [
            `${autoRoot} (auto-detected git root)`,
            `${cwd} (current directory)`,
            "Cancel",
        ]);
        if (choice?.includes("auto-detected")) {
            targetDir = autoRoot;
        } else if (choice?.includes("current")) {
            targetDir = cwd;
        } else {
            ctx.ui.notify("Cancelled", "info");
            return;
        }
    }

    const sameDir = targetDir === undefined || targetDir === cwd;

    // Generate handoff prompt via LLM
    const messages = getHandoffMessages(ctx.sessionManager.getBranch());

    if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
    }

    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);

    const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
            const loader = new BorderedLoader(
                tui,
                theme,
                `Generating handoff prompt...`
            );
            loader.onAbort = () => done(null);

            const doGenerate = async () => {
                const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
                    ctx.model as Model<Api>
                );
                if (!auth.ok || !auth.apiKey) {
                    throw new Error(
                        auth.ok
                            ? `No API key for ${(ctx.model as Model<Api>).provider}`
                            : auth.error
                    );
                }

                const userMessage: Message = {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${args.goal}`,
                        },
                    ],
                    timestamp: Date.now(),
                };

                const response = await complete(
                    ctx.model as Model<Api>,
                    {
                        systemPrompt: SYSTEM_PROMPT,
                        messages: [userMessage],
                    },
                    {
                        apiKey: auth.apiKey,
                        headers: auth.headers,
                        signal: loader.signal,
                    }
                );

                if (response.stopReason === "aborted") {
                    return null;
                }

                return response.content
                    .filter(
                        (c): c is { type: "text"; text: string } =>
                            c.type === "text"
                    )
                    .map((c) => c.text)
                    .join("\n");
            };

            doGenerate()
                .then(done)
                .catch((err) => {
                    console.error("Handoff generation failed:", err);
                    done(null);
                });

            return loader;
        }
    );

    if (result === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
    }

    const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

    if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
    }

    // Same-directory handoff: use built-in session switch
    if (sameDir) {
        const currentSessionFile = ctx.sessionManager.getSessionFile();
        const newSessionResult = await ctx.newSession({
            parentSession: currentSessionFile,
            withSession: async (replacementCtx) => {
                replacementCtx.ui.setEditorText(editedPrompt);
                replacementCtx.ui.notify(
                    "Handoff ready. Submit when ready.",
                    "info"
                );
            },
        });

        if (newSessionResult.cancelled) {
            ctx.ui.notify("New session cancelled", "info");
        }
        return;
    }

    // Different-directory handoff: launch a new pi process
    const command = buildPiCommand(targetDir!, editedPrompt);

    switch (args.launchMode) {
        case "tab":
            await launchTab(command);
            ctx.ui.notify(
                `Handoff launched in new terminal tab → ${targetDir}`,
                "info"
            );
            break;
        case "tmux":
            await launchTmux(command);
            ctx.ui.notify(
                `Handoff launched in tmux session → ${targetDir}`,
                "info"
            );
            break;
        case "clip":
            await launchClip(command);
            ctx.ui.notify(`Command copied to clipboard → ${targetDir}`, "info");
            break;
        case "print":
            ctx.ui.notify(`Run in a new terminal:\n\n${command}`, "info");
            break;
    }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerHandoff(pi: ExtensionAPI, state: TauState): void {
    pi.registerCommand("handoff", {
        description:
            "Transfer context to a new focused session. " +
            "Usage: /handoff <goal> [--dir <path>] [--tab|--tmux|--clip|--print]",
        handler: async (args, ctx) => {
            const parsed = parseHandoffArgs(args, false);
            await performHandoff(ctx, parsed, state.accessedFilePaths, ctx.cwd);
        },
    });

    pi.registerCommand("handover", {
        description:
            "Transfer context to a new session in a different git directory. " +
            "Usage: /handover <goal> [path] [--tab|--tmux|--clip|--print]",
        handler: async (args, ctx) => {
            const parsed = parseHandoffArgs(args, true);
            await performHandoff(ctx, parsed, state.accessedFilePaths, ctx.cwd);
        },
    });
}
