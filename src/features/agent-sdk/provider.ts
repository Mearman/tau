/**
 * Claude Agent SDK provider — the streaming core.
 *
 * Two history modes, selectable via `tau.claudeAgentSdk.mode`:
 *
 * - `"flatten"` (default): the whole transcript is sent each turn as one user
 *   message. The Agent SDK's prompt iterable only accepts `role: "user"`
 *   messages ("Expected message role 'user', got 'assistant'"), so assistant
 *   turns are rendered as labelled text. Robust to pi's session tree and
 *   compaction; caching still works because the flattened block prefix is
 *   append-only and thus stable.
 * - `"session"`: the SDK keeps the real alternating transcript (thinking
 *   signatures, tool_use/tool_result pairs) and each turn we send only the new
 *   user/tool-result messages since the last turn, resuming the SDK session by
 *   id. Avoids flattening assistant turns. A fork or compact resets to a fresh
 *   SDK session (seeded with a flattened snapshot), because the SDK session is
 *   linear and can't follow pi's tree/compaction.
 *
 * Tool execution is deny-and-reroute in both modes: the SDK runs in
 * `permissionMode: "dontAsk"` with a `canUseTool` that always denies, so
 * `tool_use` blocks stream out for pi to execute natively (tau's bash override,
 * permissions, etc. all apply). Billing is decided by which loop makes the
 * completion call — the SDK subprocess — so subscription vs API-key is an auth
 * concern, not a tool concern. See {@link ./auth.ts}.
 *
 * Event mapping mirrors pi-ai's built-in `anthropic-messages` provider: the
 * SDK's `stream_event` messages wrap the raw Anthropic SSE events, and we apply
 * the same mapping to pi's `AssistantMessageEvent` protocol. Type-guard
 * narrowing over the SDK's exported message types and the raw Anthropic event
 * union — no `any`, no `as` (spec improvement #5).
 */

import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Context,
    ImageContent,
    Message,
    Model,
    SimpleStreamOptions,
    TextContent,
    ThinkingLevel,
    ToolCall,
    Usage,
} from "@earendil-works/pi-ai";
import {
    calculateCost,
    createAssistantMessageEventStream,
    parseStreamingJson,
} from "@earendil-works/pi-ai";

// Type-only imports from the optional dependency. These are erased at runtime,
// so the module loads without the SDK installed; only streamSimple's execution
// triggers the dynamic import in sdk-loader.
import type {
    EffortLevel,
    Options,
    SDKMessage,
    SDKUserMessage,
    ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type {
    Base64ImageSource,
    ContentBlockParam,
    ImageBlockParam,
    TextBlockParam,
} from "@anthropic-ai/sdk/resources";
// The raw Anthropic SSE event carried by SDK stream_event messages.
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import {
    ADAPTIVE_THINKING_MODEL_FRAGMENTS,
    DEFAULT_THINKING_LEVEL_TO_EFFORT,
    LEGACY_THINKING_BUDGETS,
    MAX_LEGACY_THINKING_BUDGET,
    MIN_THINKING_BUDGET,
    MCP_SERVER_NAME,
    PROVIDER_API,
    PROVIDER_DISPLAY_NAME,
    PROVIDER_ID,
    REPLAY_SESSION_ID,
    TOOL_EXECUTION_DENIED_MESSAGE,
} from "./constants.ts";
import {
    mapPiToolNameToSdk,
    mapSdkArgsToPi,
    mapSdkToolNameToPi,
    resolveSdkTools,
    type ResolvedSdkTools,
} from "./tools.ts";
import { createHash } from "node:crypto";
import { resolveClaudeCodeExecutable } from "./executable.ts";
import { loadAgentSdk } from "./sdk-loader.ts";
import { assertSubscriptionAuth, buildSdkEnv } from "./auth.ts";
import type { AgentSdkSettings } from "./settings.ts";

export { PROVIDER_API, PROVIDER_DISPLAY_NAME, PROVIDER_ID };

// ── Small shared helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cheap fingerprint of the first message, used to detect that pi's transcript
 * prefix still matches what the SDK session holds. Compaction rewrites the
 * front of the transcript (replacing early turns with a summary), which changes
 * the head even when the message count stays the same — so a mismatch means the
 * SDK session is stale and must be re-seeded rather than resumed.
 */
export function headFingerprint(messages: readonly Message[]): string {
    const head = messages[0];
    if (head === undefined) return "";
    const sample =
        typeof head.content === "string"
            ? head.content
            : head.content
                  .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
                  .join("");
    return createHash("sha1").update(`${head.role}:${sample}`).digest("hex");
}

// ── SDK message type guards (narrow the SDKMessage union safely) ───────

function isStreamEventMessage(
    msg: SDKMessage
): msg is Extract<SDKMessage, { type: "stream_event" }> {
    return msg.type === "stream_event";
}

function isSystemInitMessage(
    msg: SDKMessage
): msg is Extract<
    SDKMessage,
    { type: "system"; subtype: "init"; apiKeySource: string }
> {
    return msg.type === "system" && msg.subtype === "init";
}

function isResultMessage(
    msg: SDKMessage
): msg is Extract<SDKMessage, { type: "result" }> {
    return msg.type === "result";
}

// ── History replay: pi Message[] -> AsyncIterable<SDKUserMessage> ──────

type ImageMime = Base64ImageSource["media_type"];
const SUPPORTED_IMAGE_MIMES: ReadonlySet<ImageMime> = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
]);

function isSupportedImageMime(mime: string): mime is ImageMime {
    return (SUPPORTED_IMAGE_MIMES as Set<string>).has(mime);
}

/** Content blocks that may appear in a user-role or tool-result message. */
type UserContentBlock = TextBlockParam | ImageBlockParam;

/** pi user/toolResult content (text + image) -> Anthropic content blocks. */
function toUserContentBlocks(
    content: string | (TextContent | ImageContent)[]
): UserContentBlock[] {
    if (typeof content === "string") {
        return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    const blocks: UserContentBlock[] = [];
    for (const block of content) {
        if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
            blocks.push(toImageBlockParam(block));
        }
    }
    return blocks;
}

function toImageBlockParam(image: ImageContent): ImageBlockParam {
    const mediaType = isSupportedImageMime(image.mimeType)
        ? image.mimeType
        : "image/png";
    return {
        type: "image",
        source: {
            type: "base64",
            media_type: mediaType,
            data: image.data,
        },
    };
}

/**
 * Build the SDK prompt as a single user message.
 *
 * The Agent SDK's prompt iterable only accepts `role: "user"` messages — it
 * rejects assistant-role replay outright ("Expected message role 'user', got
 * 'assistant'"), so pi's conversation is flattened into one user message. Each
 * prior turn is prefixed with a role label and appended as text; assistant
 * thinking is omitted (it cannot be replayed as a structured block once
 * flattened) and historical tool calls are rendered as non-executable text for
 * context. Images are preserved as image blocks so vision still works.
 *
 * A lone user turn (the common first-turn case) is passed through verbatim, so
 * images and prompt-cache breakpoints stay clean. This flattened shape is the
 * empirically necessary one — the spec's structured alternating-turn replay is
 * not supported by the SDK's API.
 */
export function buildHistoryIterable(
    context: Context,
    customToolNameToSdk: ReadonlyMap<string, string>
): AsyncIterable<SDKUserMessage> {
    async function* generate(): AsyncGenerator<SDKUserMessage> {
        yield buildPromptMessage(context, customToolNameToSdk);
    }
    return generate();
}

/** Common fields for the single replayed user message. */
const PROMPT_BASE = {
    type: "user" as const,
    parent_tool_use_id: null as string | null,
    session_id: REPLAY_SESSION_ID,
};

function buildPromptMessage(
    context: Context,
    customToolNameToSdk: ReadonlyMap<string, string>
): SDKUserMessage {
    const messages = context.messages;

    // Fast path: a lone user turn — pass its content through verbatim.
    if (messages.length === 1 && messages[0].role === "user") {
        return {
            ...PROMPT_BASE,
            message: {
                role: "user",
                content: toUserContentBlocks(messages[0].content),
            },
        };
    }

    const blocks: ContentBlockParam[] = [];
    const label = (text: string): void => {
        blocks.push({
            type: "text",
            text: `${blocks.length > 0 ? "\n\n" : ""}${text}`,
        });
    };

    for (const msg of messages) {
        if (msg.role === "user") {
            label("USER:");
            for (const block of toUserContentBlocks(msg.content)) {
                blocks.push(block);
            }
        } else if (msg.role === "assistant") {
            label("ASSISTANT:");
            const before = blocks.length;
            for (const block of msg.content) {
                if (block.type === "text") {
                    blocks.push({ type: "text", text: block.text });
                } else if (block.type === "toolCall") {
                    blocks.push({
                        type: "text",
                        text: `Historical tool call (non-executable): ${mapPiToolNameToSdk(block.name, customToolNameToSdk)} args=${safeStringify(block.arguments)}`,
                    });
                }
                // thinking is omitted from the flattened transcript.
            }
            if (blocks.length === before) {
                blocks.push({ type: "text", text: "(no visible output)" });
            }
        } else {
            label(
                `TOOL RESULT (${mapPiToolNameToSdk(msg.toolName, customToolNameToSdk)}, id=${msg.toolCallId}):`
            );
            for (const block of toUserContentBlocks(msg.content)) {
                blocks.push(block);
            }
        }
    }

    if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
    }
    return {
        ...PROMPT_BASE,
        message: { role: "user", content: blocks },
    };
}

/** JSON.stringify that never throws (tool args may contain cycles). */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "{}";
    } catch {
        return "{}";
    }
}

/**
 * Build the `session`-mode prompt: only the user/tool-result messages pi has
 * added since the SDK session was last advanced (`sentCount`). Assistant turns
 * are skipped — the SDK session already holds them (with thinking signatures
 * and tool_use blocks). Tool results become real `tool_result` blocks keyed by
 * the SDK's tool_use id, so the resumed session accumulates a proper
 * alternating transcript instead of a flattened blob.
 */
export function buildIncrementalPrompt(
    messages: Message[],
    sentCount: number
): AsyncIterable<SDKUserMessage> {
    async function* generate(): AsyncGenerator<SDKUserMessage> {
        const blocks: ContentBlockParam[] = [];
        for (let i = sentCount; i < messages.length; i++) {
            const msg = messages[i];
            if (msg === undefined) continue;
            if (msg.role === "assistant") {
                // The SDK generated this turn last call; it's in the session.
                continue;
            }
            if (msg.role === "user") {
                for (const block of toUserContentBlocks(msg.content)) {
                    blocks.push(block);
                }
            } else {
                // toolResult — pair it with the SDK's prior tool_use by id.
                blocks.push({
                    type: "tool_result",
                    tool_use_id: msg.toolCallId,
                    content: toUserContentBlocks(msg.content),
                    is_error: msg.isError,
                });
            }
        }
        if (blocks.length === 0) {
            blocks.push({ type: "text", text: "" });
        }
        yield {
            type: "user",
            message: { role: "user", content: blocks },
            parent_tool_use_id: null,
            session_id: REPLAY_SESSION_ID,
        };
    }
    return generate();
}

// ── Thinking configuration ────────────────────────────────────────────

/** True for adaptive-thinking models driven by `effort` (not a token budget). */
function supportsAdaptiveThinking(modelId: string): boolean {
    return ADAPTIVE_THINKING_MODEL_FRAGMENTS.some((fragment) =>
        modelId.includes(fragment)
    );
}

/**
 * Resolve a pi thinking level to a Claude Code effort, honouring the model's
 * `thinkingLevelMap` (e.g. Opus 4.6 maps xhigh -> "max") before the default
 * table.
 */
function resolveEffort(model: Model<Api>, level: ThinkingLevel): EffortLevel {
    const mapped = model.thinkingLevelMap?.[level];
    if (typeof mapped === "string") {
        return mapped as EffortLevel;
    }
    return DEFAULT_THINKING_LEVEL_TO_EFFORT[level] ?? "high";
}

interface ThinkingOptions {
    thinking?: ThinkingConfig;
    effort?: EffortLevel;
    maxThinkingTokens?: number;
}

/** ThinkingBudgets has no `xhigh` key; map it to `high` for legacy models. */
type LegacyBudgetLevel = "minimal" | "low" | "medium" | "high";

/**
 * Derive the SDK thinking options for a model + reasoning level.
 *
 * Adaptive models use `thinking: adaptive` + `effort`. Legacy budget-based
 * models use `maxThinkingTokens`, clamped to Anthropic's `[MIN, MAX]` envelope
 * and to one below the model's output cap (the API requires budget < max_tokens).
 */
function resolveThinkingOptions(
    model: Model<Api>,
    reasoning: ThinkingLevel | undefined,
    thinkingBudgets: SimpleStreamOptions["thinkingBudgets"]
): ThinkingOptions {
    if (!reasoning) {
        return { thinking: { type: "disabled" } };
    }
    if (supportsAdaptiveThinking(model.id)) {
        return {
            thinking: { type: "adaptive", display: "summarized" },
            effort: resolveEffort(model, reasoning),
        };
    }
    const budgetLevel: LegacyBudgetLevel =
        reasoning === "xhigh" ? "high" : reasoning;
    const custom = thinkingBudgets?.[budgetLevel];
    const levelBudget =
        typeof custom === "number" && Number.isFinite(custom) && custom > 0
            ? custom
            : (LEGACY_THINKING_BUDGETS[reasoning] ??
              MAX_LEGACY_THINKING_BUDGET);
    const budget = Math.max(
        MIN_THINKING_BUDGET,
        Math.min(levelBudget, MAX_LEGACY_THINKING_BUDGET, model.maxTokens - 1)
    );
    return { maxThinkingTokens: budget };
}

// ── Streaming scratch ─────────────────────────────────────────────────

/** Per-content-block scratch: SDK index -> output position + partial JSON. */
interface BlockScratch {
    contentIndex: number;
    partialJson: string;
}

function createEmptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function createAssistantOutput(model: Model<Api>): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createEmptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function mapStopReason(
    reason: string | undefined
): "stop" | "length" | "toolUse" | "error" {
    switch (reason) {
        case "end_turn":
        case "pause_turn":
        case "stop_sequence":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "toolUse";
        case "refusal":
        case "sensitive":
            return "error";
        default:
            return "stop";
    }
}

function setUsage(
    usage: Usage,
    next: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    }
): void {
    usage.input = next.input;
    usage.output = next.output;
    usage.cacheRead = next.cacheRead;
    usage.cacheWrite = next.cacheWrite;
    usage.totalTokens =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

type AssistantStream = ReturnType<typeof createAssistantMessageEventStream>;

// ── Event handlers ────────────────────────────────────────────────────

/**
 * Apply one raw Anthropic stream event to the output message, emitting pi
 * protocol events. Mirrors pi-ai's anthropic provider, applied to pre-parsed
 * events from the SDK's `stream_event`. Returns true when a tool_use block
 * started, so the caller can stop the loop once tool calls are complete.
 */
function handleStreamEvent(
    event: BetaRawMessageStreamEvent,
    output: AssistantMessage,
    scratch: Map<number, BlockScratch>,
    stream: AssistantStream,
    model: Model<Api>,
    customToolNameToPi: ReadonlyMap<string, string>
): boolean {
    switch (event.type) {
        case "message_start": {
            const usage = event.message.usage;
            setUsage(output.usage, {
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheWrite: usage.cache_creation_input_tokens ?? 0,
            });
            calculateCost(model, output.usage);
            return false;
        }
        case "content_block_start":
            return handleBlockStart(
                event,
                output,
                scratch,
                stream,
                customToolNameToPi
            );
        case "content_block_delta":
            handleBlockDelta(event, output, scratch, stream);
            return false;
        case "content_block_stop":
            handleBlockStop(event, output, scratch, stream, customToolNameToPi);
            return false;
        case "message_delta":
            handleUsageDelta(event, output, model);
            return false;
        case "message_stop":
            return false;
        default:
            return false;
    }
}

function handleUsageDelta(
    event: Extract<BetaRawMessageStreamEvent, { type: "message_delta" }>,
    output: AssistantMessage,
    model: Model<Api>
): void {
    if (event.delta.stop_reason) {
        output.stopReason = mapStopReason(event.delta.stop_reason);
    }
    const usage = event.usage;
    if (!usage) return;
    setUsage(output.usage, {
        input:
            usage.input_tokens != null
                ? usage.input_tokens
                : output.usage.input,
        output:
            usage.output_tokens != null
                ? usage.output_tokens
                : output.usage.output,
        cacheRead:
            usage.cache_read_input_tokens != null
                ? usage.cache_read_input_tokens
                : output.usage.cacheRead,
        cacheWrite:
            usage.cache_creation_input_tokens != null
                ? usage.cache_creation_input_tokens
                : output.usage.cacheWrite,
    });
    calculateCost(model, output.usage);
}

function handleBlockStart(
    event: Extract<BetaRawMessageStreamEvent, { type: "content_block_start" }>,
    output: AssistantMessage,
    scratch: Map<number, BlockScratch>,
    stream: AssistantStream,
    customToolNameToPi: ReadonlyMap<string, string>
): boolean {
    const block = event.content_block;
    if (block.type === "text") {
        output.content.push({ type: "text", text: "" });
        record(scratch, event.index, output.content.length - 1);
        emitStart(stream, output, "text");
        return false;
    }
    if (block.type === "thinking") {
        output.content.push({
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
        });
        record(scratch, event.index, output.content.length - 1);
        emitStart(stream, output, "thinking");
        return false;
    }
    if (block.type === "redacted_thinking") {
        output.content.push({
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: block.data,
            redacted: true,
        });
        record(scratch, event.index, output.content.length - 1);
        emitStart(stream, output, "thinking");
        return false;
    }
    if (block.type === "tool_use") {
        output.content.push({
            type: "toolCall",
            id: block.id,
            name: mapSdkToolNameToPi(block.name, customToolNameToPi),
            arguments: isRecord(block.input) ? block.input : {},
        });
        record(scratch, event.index, output.content.length - 1);
        emitStart(stream, output, "toolcall");
        return true;
    }
    // Other block types (server tool use, web search results, ...) are ignored.
    return false;
}

function handleBlockDelta(
    event: Extract<BetaRawMessageStreamEvent, { type: "content_block_delta" }>,
    output: AssistantMessage,
    scratch: Map<number, BlockScratch>,
    stream: AssistantStream
): void {
    const entry = scratch.get(event.index);
    if (!entry) return;
    const block = output.content[entry.contentIndex];
    if (block === undefined) return;
    const delta = event.delta;

    if (delta.type === "text_delta" && block.type === "text") {
        block.text += delta.text;
        stream.push({
            type: "text_delta",
            contentIndex: entry.contentIndex,
            delta: delta.text,
            partial: output,
        });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
        block.thinking += delta.thinking;
        stream.push({
            type: "thinking_delta",
            contentIndex: entry.contentIndex,
            delta: delta.thinking,
            partial: output,
        });
    } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
        entry.partialJson += delta.partial_json;
        block.arguments = parseStreamingJson(entry.partialJson);
        stream.push({
            type: "toolcall_delta",
            contentIndex: entry.contentIndex,
            delta: delta.partial_json,
            partial: output,
        });
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
        block.thinkingSignature =
            (block.thinkingSignature ?? "") + delta.signature;
    }
}

function handleBlockStop(
    event: Extract<BetaRawMessageStreamEvent, { type: "content_block_stop" }>,
    output: AssistantMessage,
    scratch: Map<number, BlockScratch>,
    stream: AssistantStream,
    customToolNameToPi: ReadonlyMap<string, string>
): void {
    const entry = scratch.get(event.index);
    if (!entry) return;
    const block = output.content[entry.contentIndex];
    if (block === undefined) return;

    if (block.type === "text") {
        stream.push({
            type: "text_end",
            contentIndex: entry.contentIndex,
            content: block.text,
            partial: output,
        });
    } else if (block.type === "thinking") {
        stream.push({
            type: "thinking_end",
            contentIndex: entry.contentIndex,
            content: block.thinking,
            partial: output,
        });
    } else if (block.type === "toolCall") {
        // Strict-at-stop JSON (spec improvement #7): lenient parse is correct
        // mid-stream, but genuinely malformed JSON at block end is an error.
        if (entry.partialJson.trim().length > 0) {
            try {
                const parsed: unknown = JSON.parse(entry.partialJson);
                block.arguments = isRecord(parsed) ? parsed : {};
            } catch (error) {
                throw new Error(
                    `Malformed tool-call JSON at content_block_stop: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    { cause: error }
                );
            }
        }
        block.arguments = mapSdkArgsToPi(
            mapSdkToolNameToPi(block.name, customToolNameToPi),
            block.arguments
        );
        const toolCall: ToolCall = {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
            ...(block.thoughtSignature
                ? { thoughtSignature: block.thoughtSignature }
                : {}),
        };
        stream.push({
            type: "toolcall_end",
            contentIndex: entry.contentIndex,
            toolCall,
            partial: output,
        });
    }
}

function handleResultMessage(
    message: Extract<SDKMessage, { type: "result" }>,
    output: AssistantMessage,
    sawStreamEvent: boolean
): void {
    // If the SDK produced no stream events (e.g. a direct text result without
    // partial messages), surface the result text as the assistant message.
    if (sawStreamEvent) return;
    if (message.subtype === "success") {
        if (message.result) {
            output.content.push({ type: "text", text: message.result });
        }
        return;
    }
    // Error subtypes start with "error".
    output.stopReason = "error";
    const errors = message.errors;
    if (errors && errors.length > 0) {
        output.errorMessage = errors.join("; ");
    }
}

function record(
    scratch: Map<number, BlockScratch>,
    sdkIndex: number,
    contentIndex: number
): void {
    scratch.set(sdkIndex, { contentIndex, partialJson: "" });
}

function emitStart(
    stream: AssistantStream,
    output: AssistantMessage,
    kind: "text" | "thinking" | "toolcall"
): void {
    const contentIndex = output.content.length - 1;
    if (kind === "text") {
        stream.push({ type: "text_start", contentIndex, partial: output });
    } else if (kind === "thinking") {
        stream.push({ type: "thinking_start", contentIndex, partial: output });
    } else {
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
    }
}

// ── Custom-tool MCP server ────────────────────────────────────────────

/**
 * Surface pi's non-builtin tools as schema carriers on an in-process MCP
 * server. Their handlers always deny: the model names them and emits tool_use
 * blocks, but pi executes them natively.
 */
function buildCustomToolServers(
    sdk: typeof import("@anthropic-ai/claude-agent-sdk"),
    resolved: ResolvedSdkTools
): NonNullable<Options["mcpServers"]> | undefined {
    if (resolved.customTools.length === 0) return undefined;
    const tools = resolved.customTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Empty raw shape: the SDK validates inputSchema as Zod/raw shape and
        // rejects plain JSON Schema. These stubs are always denied anyway.
        inputSchema: {},
        handler: async () => ({
            content: [
                { type: "text" as const, text: TOOL_EXECUTION_DENIED_MESSAGE },
            ],
            isError: true,
        }),
    }));
    const server = sdk.createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "1.0.0",
        tools,
    });
    return { [MCP_SERVER_NAME]: server };
}

// ── The streaming core ────────────────────────────────────────────────

/**
 * Subscription rate-limit snapshot, captured from the SDK result message's
 * `rate_limit_info` and surfaced to the host (e.g. tau's status bar).
 */
export interface AgentSdkRateLimit {
    status: "allowed" | "allowed_warning" | "rejected";
    /** 0–100 utilisation of the binding window, when reported. */
    utilization: number | undefined;
    /** Which window the limit applies to. */
    rateLimitType: string | undefined;
    /** Unix-seconds reset time of the binding window. */
    resetsAt: number | undefined;
    /** True when drawing from the paid overage pool. */
    isUsingOverage: boolean | undefined;
    /** When this snapshot was captured (epoch ms). */
    updatedAt: number;
}

interface StreamDeps {
    settings: AgentSdkSettings;
    /**
     * Per-pi-session SDK session cursor, used only in `session` mode. The
     * provider reads the prior `{ sdkSessionId, sentCount }` to resume and
     * writes the updated cursor after a successful turn.
     */
    sdkSessions: Map<
        string,
        { sdkSessionId: string | undefined; sentCount: number; head: string }
    >;
    /** Called with the subscription rate-limit snapshot when the SDK reports it. */
    onRateLimit?: (info: AgentSdkRateLimit) => void;
}

/**
 * The provider's `streamSimple`. Runs a single SDK `query()` over the replayed
 * history, maps the raw Anthropic events to pi's protocol, and lets pi execute
 * the resulting tool calls natively on the next turn.
 *
 * Exported for the feature module to wrap with the feature-toggle gate and
 * bind to the resolved settings.
 */
export function streamClaudeAgentSdk(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    deps: StreamDeps
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void runAgentSdkQuery(stream, model, context, options, deps);
    return stream;
}

async function runAgentSdkQuery(
    stream: AssistantStream,
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    deps: StreamDeps
): Promise<void> {
    const output = createAssistantOutput(model);
    const scratch = new Map<number, BlockScratch>();
    let started = false;
    let sawToolCall = false;
    let sawStreamEvent = false;
    let authVerified = deps.settings.authMode !== "subscription";
    // Capture the SDK subprocess stderr so a crash (e.g. "process exited with
    // code 1") surfaces its real reason instead of a bare exit code.
    const subprocessStderr: string[] = [];

    const sdk = await loadAgentSdk();

    let queryHandle: ReturnType<typeof sdk.query> | undefined;
    const onAbort = () => {
        if (!queryHandle) return;
        void queryHandle.interrupt().catch(() => {
            try {
                queryHandle?.close();
            } catch {
                // shutdown errors are not actionable
            }
        });
    };
    if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
        const resolved = resolveSdkTools(context);
        const mcpServers = buildCustomToolServers(sdk, resolved);
        const thinking = resolveThinkingOptions(
            model,
            options?.reasoning,
            options?.thinkingBudgets
        );

        // Session mode: resume the SDK session and send only new user/tool-
        // result messages. Flatten mode: send the whole transcript. pi's
        // session id keys the SDK session; a missing/stale cursor (first turn,
        // a compact that shrank the transcript, or a compact that rewrote the
        // prefix while keeping the length — detected via the head fingerprint)
        // seeds a fresh session.
        const piSessionId = options?.sessionId;
        const sessionMode =
            deps.settings.mode === "session" && piSessionId !== undefined;
        let resumeId: string | undefined;
        let cursorSentCount = 0;
        let prompt: AsyncIterable<SDKUserMessage>;
        // Head fingerprint of the current transcript; reused for the stale-
        // resume guard and stored on the cursor for next turn.
        const head = headFingerprint(context.messages);
        if (sessionMode) {
            const cursor = deps.sdkSessions.get(piSessionId);
            if (
                cursor !== undefined &&
                cursor.sdkSessionId !== undefined &&
                cursor.sentCount <= context.messages.length &&
                cursor.head === head
            ) {
                resumeId = cursor.sdkSessionId;
                cursorSentCount = context.messages.length;
                prompt = buildIncrementalPrompt(
                    context.messages,
                    cursor.sentCount
                );
            } else {
                deps.sdkSessions.delete(piSessionId);
                cursorSentCount = context.messages.length;
                prompt = buildHistoryIterable(
                    context,
                    resolved.customToolNameToSdk
                );
            }
        } else {
            prompt = buildHistoryIterable(
                context,
                resolved.customToolNameToSdk
            );
        }
        let capturedSdkSessionId: string | undefined;

        const queryOptions: Options = {
            cwd:
                (options as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
            model: model.id,
            tools: resolved.sdkTools,
            permissionMode: "dontAsk",
            includePartialMessages: true,
            canUseTool: async () => ({
                behavior: "deny",
                message: TOOL_EXECUTION_DENIED_MESSAGE,
            }),
            env: buildSdkEnv(deps.settings.authMode),
            pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
            stderr: (data) => {
                subprocessStderr.push(data);
            },
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                ...(deps.settings.appendSystemPrompt && context.systemPrompt
                    ? { append: context.systemPrompt }
                    : {}),
            },
            ...(deps.settings.settingSources
                ? { settingSources: deps.settings.settingSources }
                : {}),
            ...(deps.settings.strictMcpConfig
                ? { extraArgs: { "strict-mcp-config": null } }
                : {}),
            ...(mcpServers ? { mcpServers } : {}),
            ...(resumeId ? { resume: resumeId } : {}),
            ...thinking,
        };

        queryHandle = sdk.query({ prompt, options: queryOptions });

        let stopEarly = false;
        for await (const message of queryHandle) {
            if (!started) {
                stream.push({ type: "start", partial: output });
                started = true;
            }

            // Auth determinism + (session mode) capture the SDK session id.
            if (isSystemInitMessage(message)) {
                if (message.session_id)
                    capturedSdkSessionId = message.session_id;
                if (!authVerified) {
                    assertSubscriptionAuth(
                        message.apiKeySource,
                        deps.settings.authMode
                    );
                    authVerified = true;
                }
            }

            if (isStreamEventMessage(message)) {
                sawStreamEvent = true;
                if (
                    handleStreamEvent(
                        message.event,
                        output,
                        scratch,
                        stream,
                        model,
                        resolved.customToolNameToPi
                    )
                ) {
                    sawToolCall = true;
                }
                if (message.event.type === "message_stop" && sawToolCall) {
                    stopEarly = true;
                }
            } else if (isResultMessage(message)) {
                handleResultMessage(message, output, sawStreamEvent);
            } else if (
                message.type === "rate_limit_event" &&
                deps.onRateLimit
            ) {
                // The SDK emits a rate_limit_event whenever the subscription
                // window (five-hour / seven-day) changes — the same data Claude
                // Code shows. Surface it to the host for the status bar.
                const rl = message.rate_limit_info;
                deps.onRateLimit({
                    status: rl.status,
                    // The SDK reports utilization as a 0–1 fraction; convert to
                    // 0–100 for display. Values already > 1 are left as-is.
                    utilization:
                        rl.utilization !== undefined
                            ? rl.utilization <= 1
                                ? rl.utilization * 100
                                : rl.utilization
                            : undefined,
                    rateLimitType: rl.rateLimitType,
                    resetsAt: rl.resetsAt,
                    isUsingOverage: rl.isUsingOverage,
                    updatedAt: Date.now(),
                });
            }

            if (stopEarly) break;
        }

        if (options?.signal?.aborted) {
            throw new Error("Operation aborted");
        }

        // Advance the session-mode cursor so the next turn resumes this SDK
        // session and only sends messages added after this point.
        if (
            sessionMode &&
            piSessionId !== undefined &&
            capturedSdkSessionId !== undefined
        ) {
            deps.sdkSessions.set(piSessionId, {
                sdkSessionId: capturedSdkSessionId,
                sentCount: cursorSentCount,
                head,
            });
        }

        stream.push({
            type: "done",
            reason:
                output.stopReason === "toolUse"
                    ? "toolUse"
                    : output.stopReason === "length"
                      ? "length"
                      : "stop",
            message: output,
        });
        stream.end();
    } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        output.stopReason = reason;
        const baseMessage =
            error instanceof Error ? error.message : String(error);
        const stderrText = subprocessStderr.join("").trim();
        // Append the subprocess stderr when present: a non-zero exit carries no
        // detail on its own, so the captured stderr is the only way to see why
        // Claude Code crashed (e.g. an unsupported replay shape).
        output.errorMessage = stderrText
            ? `${baseMessage}\n${stderrText}`
            : baseMessage;
        stream.push({
            type: "error",
            reason,
            error: output,
        });
        stream.end();
    } finally {
        if (options?.signal) {
            options.signal.removeEventListener("abort", onAbort);
        }
        queryHandle?.close();
    }
}
