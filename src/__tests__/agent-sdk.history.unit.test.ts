/**
 * Tests for the agent-sdk prompt builder.
 *
 * The Agent SDK only accepts role:"user" messages in its prompt iterable, so
 * pi's conversation is flattened into a single user message. These tests pin
 * that shape: a lone user turn passes through verbatim (images preserved);
 * multi-turn history is flattened with role labels; historical tool calls and
 * results are rendered as non-executable text for context.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildHistoryIterable,
    buildIncrementalPrompt,
} from "../features/agent-sdk/provider.ts";
import type {
    AssistantMessage,
    Context,
    Message,
    ToolResultMessage,
    UserMessage,
} from "@earendil-works/pi-ai";

type Block = {
    type: string;
    text?: string;
    source?: unknown;
    tool_use_id?: string;
    is_error?: boolean;
};

async function content(context: Context): Promise<Block[]> {
    for await (const msg of buildHistoryIterable(context, new Map())) {
        return msg.message.content as Block[];
    }
    throw new Error("no message yielded");
}

/** Concatenate every text block so labelled content can be asserted as one string. */
function joined(blocks: Block[]): string {
    return blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
}

function user(text: string): UserMessage {
    return { role: "user", content: text, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-7",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: "stop",
        timestamp: 0,
    };
}

function toolResult(id: string, text: string): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
    };
}

void describe("buildHistoryIterable (flattened single user message)", () => {
    void it("passes a lone user turn through verbatim, unlabelled", async () => {
        const blocks = await content({ messages: [user("hello")] });
        // Fast path: content is just the user's text, no "USER:" label.
        assert.deepEqual(
            blocks.map((b) => b.type),
            ["text"]
        );
        assert.equal(blocks[0]?.text, "hello");
    });

    void it("yields a single empty user message when there is no history", async () => {
        const blocks = await content({ messages: [] });
        assert.deepEqual(
            blocks.map((b) => b.type),
            ["text"]
        );
        assert.equal(blocks[0]?.text, "");
    });

    void it("flattens alternating turns into one user message with labels", async () => {
        const blocks = await content({
            messages: [
                user("hello"),
                assistant([{ type: "text", text: "hi there" }]),
                user("again"),
            ],
        });
        const text = joined(blocks);
        assert.match(text, /USER:\nhello/);
        assert.match(text, /ASSISTANT:\nhi there/);
        assert.match(text, /USER:\nagain/);
    });

    void it("renders historical assistant tool calls as non-executable text", async () => {
        const blocks = await content({
            messages: [
                assistant([
                    {
                        type: "toolCall",
                        id: "t1",
                        name: "read",
                        arguments: { path: "/x" },
                    },
                ]),
                user("ok"),
            ],
        });
        const text = joined(blocks);
        assert.match(text, /Historical tool call \(non-executable\): Read/);
        assert.match(text, /"path":"\/x"/);
    });

    void it("labels tool results with their tool name and call id", async () => {
        const blocks = await content({
            messages: [
                assistant([
                    {
                        type: "toolCall",
                        id: "t1",
                        name: "read",
                        arguments: {},
                    },
                ]),
                toolResult("t1", "file contents"),
                user("thanks"),
            ],
        });
        const text = joined(blocks);
        assert.match(text, /TOOL RESULT \(Read, id=t1\):/);
        assert.match(text, /file contents/);
    });
});

async function incremental(
    messages: Message[],
    sentCount: number
): Promise<Block[]> {
    for await (const msg of buildIncrementalPrompt(
        messages,
        sentCount,
        new Map()
    )) {
        return msg.message.content as Block[];
    }
    throw new Error("no message yielded");
}

void describe("buildIncrementalPrompt (session mode)", () => {
    void it("skips assistant turns and sends only new user/tool-result messages", async () => {
        // sentCount=1: messages[0] (user "hello") already in the SDK session;
        // messages[1] is the SDK's assistant turn (skip); messages[2..] are new.
        const blocks = await incremental(
            [
                user("hello"),
                assistant([{ type: "text", text: "hi" }]),
                toolResult("toolu_1", "the file contents"),
                user("next question"),
            ],
            1
        );
        // No assistant text leaked through.
        assert.equal(
            blocks.find((b) => b.type === "text" && b.text === "hi"),
            undefined
        );
        // Tool result is a real tool_result block keyed by the SDK's tool_use id.
        const result = blocks.find((b) => b.type === "tool_result");
        assert.equal(result?.tool_use_id, "toolu_1");
        // The new user message is present.
        assert.ok(
            blocks.some((b) => b.type === "text" && b.text === "next question")
        );
    });

    void it("yields an empty user message when there is nothing new", async () => {
        const blocks = await incremental([user("hello")], 1);
        assert.deepEqual(
            blocks.map((b) => b.type),
            ["text"]
        );
        assert.equal(blocks[0]?.text, "");
    });
});
