/**
 * Claude Agent SDK provider — the streaming core.
 *
 * The single big idea (spec improvement #1 over the reference extension): we
 * replay pi's conversation as a real, structured, alternating-turn transcript
 * via an `AsyncIterable<SDKUserMessage>` with `shouldQuery` control, instead of
 * flattening the whole context into one labelled string. That preserves prompt
 * caching and reasoning continuity across turns.
 *
 * Tool execution is deny-and-reroute: the SDK runs in `permissionMode:
 * "dontAsk"` with a `canUseTool` that always denies, so `tool_use` blocks
 * stream out for pi to execute natively (tau's bash override, permissions, etc.
 * all apply). Billing is decided by which loop makes the completion call — the
 * SDK subprocess — so subscription vs API-key is an auth concern, not a tool
 * concern. See {@link ./auth.ts}.
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
    MessageParam,
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
    mapPiArgsToSdk,
    mapPiToolNameToSdk,
    mapSdkArgsToPi,
    mapSdkToolNameToPi,
    resolveSdkTools,
    type ResolvedSdkTools,
} from "./tools.ts";
import { resolveClaudeCodeExecutable } from "./executable.ts";
import { loadAgentSdk } from "./sdk-loader.ts";
import { assertSubscriptionAuth, buildSdkEnv } from "./auth.ts";
import type { AgentSdkSettings } from "./settings.ts";

export { PROVIDER_API, PROVIDER_DISPLAY_NAME, PROVIDER_ID };

// ── Small shared helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Map a pi assistant message's content into Anthropic input blocks, preserving
 * thinking signatures (spec improvement #8). Redacted thinking becomes a
 * `redacted_thinking` block carrying its encrypted data; plain thinking without
 * a signature is dropped, since Anthropic requires a signature to continue a
 * reasoning chain and we will not fabricate one.
 */
function toAssistantContentBlocks(
    content: AssistantMessage["content"],
    customToolNameToSdk: ReadonlyMap<string, string>
): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = [];
    for (const block of content) {
        if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
            if (block.redacted) {
                if (block.thinkingSignature) {
                    blocks.push({
                        type: "redacted_thinking",
                        data: block.thinkingSignature,
                    });
                }
                continue;
            }
            if (block.thinkingSignature) {
                blocks.push({
                    type: "thinking",
                    thinking: block.thinking,
                    signature: block.thinkingSignature,
                });
            }
            // No signature -> cannot replay; drop rather than fabricate.
        } else if (block.type === "toolCall") {
            blocks.push({
                type: "tool_use",
                id: block.id,
                name: mapPiToolNameToSdk(block.name, customToolNameToSdk),
                input: mapPiArgsToSdk(block.name, block.arguments),
            });
        }
    }
    return blocks;
}

/** A single alternating turn in the replayed transcript. */
interface ReplayFrame {
    role: "user" | "assistant";
    blocks: ContentBlockParam[];
}

/**
 * Fold pi's message list into strictly role-alternating frames.
 *
 * Consecutive same-role messages are merged (pi user steers, and multiple tool
 * results all land in one user turn as separate `tool_result` blocks). Empty
 * assistant turns are dropped (Anthropic rejects them). Tool-result messages
 * become user-role `tool_result` blocks.
 */
function buildReplayFrames(
    messages: Message[],
    customToolNameToSdk: ReadonlyMap<string, string>
): ReplayFrame[] {
    const frames: ReplayFrame[] = [];

    for (const msg of messages) {
        let role: "user" | "assistant";
        let blocks: ContentBlockParam[];
        if (msg.role === "user") {
            role = "user";
            blocks = toUserContentBlocks(msg.content);
        } else if (msg.role === "assistant") {
            role = "assistant";
            blocks = toAssistantContentBlocks(msg.content, customToolNameToSdk);
            if (blocks.length === 0) continue;
        } else {
            // toolResult
            role = "user";
            blocks = [
                {
                    type: "tool_result",
                    tool_use_id: msg.toolCallId,
                    content: toUserContentBlocks(msg.content),
                    is_error: msg.isError,
                },
            ];
        }

        const last = frames[frames.length - 1];
        if (last !== undefined && last.role === role) {
            last.blocks.push(...blocks);
        } else {
            frames.push({ role, blocks });
        }
    }

    return frames;
}

/**
 * Build the SDK prompt iterable from pi's context.
 *
 * Every frame is yielded as an `SDKUserMessage` whose `message` carries the
 * real role and content; all but the final frame set `shouldQuery: false`
 * (append to the transcript without triggering a turn), and the final frame
 * triggers the assistant turn. Because {@link buildReplayFrames} enforces
 * strict role alternation, the replay is valid regardless of how the SDK
 * reconciles consecutive non-querying messages.
 */
export function buildHistoryIterable(
    context: Context,
    customToolNameToSdk: ReadonlyMap<string, string>
): AsyncIterable<SDKUserMessage> {
    const frames = buildReplayFrames(context.messages, customToolNameToSdk);

    async function* generate(): AsyncGenerator<SDKUserMessage> {
        if (frames.length === 0) {
            yield {
                type: "user",
                message: { role: "user", content: "" },
                parent_tool_use_id: null,
                session_id: REPLAY_SESSION_ID,
            };
            return;
        }
        const lastIndex = frames.length - 1;
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const message: MessageParam = {
                role: frame.role,
                content: frame.blocks,
            };
            yield {
                type: "user",
                message,
                parent_tool_use_id: null,
                session_id: REPLAY_SESSION_ID,
                ...(i === lastIndex ? {} : { shouldQuery: false }),
            };
        }
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

interface StreamDeps {
    settings: AgentSdkSettings;
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
    let authVerified = deps.settings.authMode !== "subscription";

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
        const prompt = buildHistoryIterable(
            context,
            resolved.customToolNameToSdk
        );
        const mcpServers = buildCustomToolServers(sdk, resolved);
        const thinking = resolveThinkingOptions(
            model,
            options?.reasoning,
            options?.thinkingBudgets
        );

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
            ...thinking,
        };

        queryHandle = sdk.query({ prompt, options: queryOptions });

        let stopEarly = false;
        for await (const message of queryHandle) {
            if (!started) {
                stream.push({ type: "start", partial: output });
                started = true;
            }

            // Auth determinism: check the init message exactly once.
            if (!authVerified && isSystemInitMessage(message)) {
                assertSubscriptionAuth(
                    message.apiKeySource,
                    deps.settings.authMode
                );
                authVerified = true;
            }

            if (isStreamEventMessage(message)) {
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
                handleResultMessage(message, output, started);
            }

            if (stopEarly) break;
        }

        if (options?.signal?.aborted) {
            throw new Error("Operation aborted");
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
        output.errorMessage =
            error instanceof Error ? error.message : String(error);
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
