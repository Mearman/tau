/**
 * /claude-resume — load a Claude Code (~/.claude) session into pi.
 *
 * Lists the Claude Code sessions stored for the current project, lets the user
 * pick one (or takes a session-id prefix argument), and imports its transcript
 * into a fresh pi session by converting Claude's message format into pi's and
 * appending each message. The result is a pi session that continues the Claude
 * Code conversation, usable with any model.
 *
 * Listing and reading use the Agent SDK's `listSessions` / `getSessionMessages`
 * (lazy-loaded, so tau still runs without the SDK installed).
 */

import type {
    AssistantMessage,
    ImageContent,
    Message,
    TextContent,
    ThinkingContent,
    ToolCall,
    ToolResultMessage,
    Usage,
    UserMessage,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import { loadAgentSdk } from "./agent-sdk/sdk-loader.ts";

/** A Claude Code session entry — the slice of SessionMessage we convert. */
export interface ClaudeEntry {
    type: string;
    message: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function mapUsage(u: unknown): Usage {
    if (!isRecord(u)) return zeroUsage();
    const num = (k: string): number => (typeof u[k] === "number" ? u[k] : 0);
    const input = num("input_tokens");
    const output = num("output_tokens");
    const cacheRead = num("cache_read_input_tokens");
    const cacheWrite = num("cache_creation_input_tokens");
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function mapStopReason(r: unknown): AssistantMessage["stopReason"] {
    switch (r) {
        case "tool_use":
            return "toolUse";
        case "max_tokens":
            return "length";
        default:
            return "stop";
    }
}

function mapImage(source: unknown): ImageContent | undefined {
    if (!isRecord(source) || source.type !== "base64") return undefined;
    const data = source.data;
    const mimeType = source.media_type;
    if (typeof data !== "string" || typeof mimeType !== "string")
        return undefined;
    return { type: "image", data, mimeType };
}

/** Claude assistant content blocks -> pi text/thinking/toolCall blocks. */
function mapAssistantBlocks(
    blocks: unknown[],
    toolUseIdToName: Map<string, string>
): (TextContent | ThinkingContent | ToolCall)[] {
    const out: (TextContent | ThinkingContent | ToolCall)[] = [];
    for (const b of blocks) {
        if (!isRecord(b)) continue;
        if (b.type === "text" && typeof b.text === "string") {
            out.push({ type: "text", text: b.text });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
            const thinking: ThinkingContent = {
                type: "thinking",
                thinking: b.thinking,
            };
            if (typeof b.signature === "string")
                thinking.thinkingSignature = b.signature;
            out.push(thinking);
        } else if (
            b.type === "tool_use" &&
            typeof b.id === "string" &&
            typeof b.name === "string"
        ) {
            toolUseIdToName.set(b.id, b.name);
            out.push({
                type: "toolCall",
                id: b.id,
                name: b.name,
                arguments: isRecord(b.input) ? b.input : {},
            });
        }
        // server_tool_use / tool_result (shouldn't appear on assistant) skipped.
    }
    return out;
}

/** Claude user content blocks -> pi text/image blocks. */
function mapUserBlocks(blocks: unknown[]): (TextContent | ImageContent)[] {
    const out: (TextContent | ImageContent)[] = [];
    for (const b of blocks) {
        if (!isRecord(b)) continue;
        if (b.type === "text" && typeof b.text === "string") {
            out.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
            const img = mapImage(b.source);
            if (img) out.push(img);
        }
    }
    return out;
}

/**
 * Convert a Claude Code session transcript into pi messages.
 *
 * Pure and SDK-free (operates on the `{type, message}` slice of SessionMessage)
 * so it is fully unit-testable. Tool results are emitted as `ToolResultMessage`s
 * keyed by the prior tool_use id; tool names are resolved from the assistant
 * turn that proposed the call. system/metadata entries are skipped, and
 * unmappable entries are dropped rather than producing invalid pi messages.
 */
export function convertClaudeSession(
    entries: readonly ClaudeEntry[]
): Message[] {
    const out: Message[] = [];
    const toolUseIdToName = new Map<string, string>();
    let ts = 0;
    for (const entry of entries) {
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        if (!isRecord(entry.message)) continue;
        const msg = entry.message;
        const role = msg.role;
        const content = msg.content;

        if (role === "user") {
            if (
                Array.isArray(content) &&
                content.some((b) => isRecord(b) && b.type === "tool_result")
            ) {
                for (const b of content) {
                    if (!isRecord(b) || b.type !== "tool_result") continue;
                    const toolUseId = b.tool_use_id;
                    if (typeof toolUseId !== "string") continue;
                    const resultContent = Array.isArray(b.content)
                        ? b.content
                        : [];
                    out.push({
                        role: "toolResult",
                        toolCallId: toolUseId,
                        toolName: toolUseIdToName.get(toolUseId) ?? "tool",
                        content: mapUserBlocks(resultContent),
                        isError: b.is_error === true,
                        timestamp: ts++,
                    } satisfies ToolResultMessage);
                }
            } else {
                const blocks: (TextContent | ImageContent)[] = Array.isArray(
                    content
                )
                    ? mapUserBlocks(content)
                    : typeof content === "string"
                      ? [{ type: "text", text: content }]
                      : [];
                if (blocks.length === 0) continue;
                out.push({
                    role: "user",
                    content: blocks,
                    timestamp: ts++,
                } satisfies UserMessage);
            }
        } else if (role === "assistant") {
            const blocks = Array.isArray(content)
                ? mapAssistantBlocks(content, toolUseIdToName)
                : [];
            if (blocks.length === 0) continue;
            out.push({
                role: "assistant",
                content: blocks,
                api: "anthropic-messages",
                provider: "anthropic",
                model: typeof msg.model === "string" ? msg.model : "claude",
                usage: mapUsage(msg.usage),
                stopReason: mapStopReason(msg.stop_reason),
                timestamp: ts++,
            } satisfies AssistantMessage);
        }
    }
    return out;
}

/**
 * SDK calls the command needs, abstracted so the command logic is testable
 * without the optional Agent SDK installed.
 */
export interface ClaudeResumeHandlers {
    listSessions: (
        dir: string
    ) => Promise<
        Array<{ sessionId: string; summary: string; lastModified: number }>
    >;
    getSessionMessages: (
        sessionId: string,
        dir: string
    ) => Promise<ClaudeEntry[]>;
}

/** Build the /claude-resume command definition (registered by index.ts). */
export function buildClaudeResumeCommand(
    state: TauState,
    sdk: ClaudeResumeHandlers
) {
    return {
        description:
            "Load a Claude Code (~/.claude) session into a new pi session",
        handler: async (
            args: string,
            ctx: ExtensionCommandContext
        ): Promise<void> => {
            if (!isFeatureEnabled(state, "claude-resume")) {
                ctx.ui.notify(
                    "claude-resume is disabled. Enable it with /tau.",
                    "warning"
                );
                return;
            }
            const cwd = ctx.cwd;
            let sessions;
            try {
                sessions = await sdk.listSessions(cwd);
            } catch (e) {
                ctx.ui.notify(
                    `Failed to list Claude sessions: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                    "error"
                );
                return;
            }
            if (sessions.length === 0) {
                ctx.ui.notify(
                    `No Claude Code sessions found for ${cwd}`,
                    "info"
                );
                return;
            }
            sessions.sort(
                (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0)
            );

            const idArg = args.trim();
            let target: {
                sessionId: string;
                summary: string;
                lastModified: number;
            };
            if (idArg) {
                const match = sessions.find(
                    (s) =>
                        s.sessionId === idArg || s.sessionId.startsWith(idArg)
                );
                if (!match) {
                    ctx.ui.notify(
                        `No Claude session matching '${idArg}'`,
                        "warning"
                    );
                    return;
                }
                target = match;
            } else {
                const labels = sessions.map(
                    (s) =>
                        `${s.summary || s.sessionId.slice(0, 8)}  ·  ${new Date(
                            s.lastModified
                        ).toLocaleString()}`
                );
                const choice = await ctx.ui.select(
                    "Load Claude session",
                    labels
                );
                if (!choice) return;
                const idx = labels.indexOf(choice);
                if (idx < 0) return;
                target = sessions[idx];
            }

            let entries;
            try {
                entries = await sdk.getSessionMessages(target.sessionId, cwd);
            } catch (e) {
                ctx.ui.notify(
                    `Failed to read Claude session: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                    "error"
                );
                return;
            }
            const messages = convertClaudeSession(entries);
            if (messages.length === 0) {
                ctx.ui.notify(
                    "That Claude session had no importable messages",
                    "info"
                );
                return;
            }

            const summary = target.summary || target.sessionId.slice(0, 8);
            const result = await ctx.newSession({
                setup: async (sessionManager) => {
                    sessionManager.appendSessionInfo(`Claude: ${summary}`);
                    for (const message of messages) {
                        sessionManager.appendMessage(message);
                    }
                },
            });
            if (result.cancelled) return;
            ctx.ui.notify(
                `Loaded Claude session (${messages.length} messages): ${summary}`,
                "info"
            );
        },
    };
}

/**
 * Register /claude-resume, binding the Agent SDK's listSessions/getSessionMessages
 * at handler time (lazy) so tau loads without the optional SDK installed.
 */
export function registerClaudeResumeCommand(
    pi: ExtensionAPI,
    state: TauState
): void {
    pi.registerCommand("claude-resume", {
        ...buildClaudeResumeCommand(state, {
            listSessions: async (dir) => {
                const sdk = await loadAgentSdk();
                return sdk.listSessions({ dir });
            },
            getSessionMessages: async (sessionId, dir) => {
                const sdk = await loadAgentSdk();
                return sdk.getSessionMessages(sessionId, { dir });
            },
        }),
    });
}
