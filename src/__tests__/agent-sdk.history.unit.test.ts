/**
 * Unit tests for the agent-sdk structured-history replay builder.
 *
 * These verify the spec's core improvement: pi's conversation is replayed as
 * real alternating-turn SDKUserMessages with shouldQuery control, preserving
 * thinking signatures and folding tool results into valid user turns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHistoryIterable } from "../features/agent-sdk/provider.ts";
import type {
    AssistantMessage,
    Context,
    ToolResultMessage,
    UserMessage,
} from "@earendil-works/pi-ai";

type Yielded = {
    message: { role: string; content: unknown };
    shouldQuery?: boolean;
};

async function collect(context: Context): Promise<Yielded[]> {
    const out: Yielded[] = [];
    for await (const msg of buildHistoryIterable(context, new Map())) {
        out.push({
            message: msg.message,
            shouldQuery: msg.shouldQuery,
        });
    }
    return out;
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

void describe("buildHistoryIterable", () => {
    void it("yields a single empty trigger when there is no history", async () => {
        const out = await collect({ messages: [] });
        assert.equal(out.length, 1);
        assert.equal(out[0].message.role, "user");
        assert.equal(out[0].shouldQuery, undefined);
    });

    void it("marks all but the final frame shouldQuery:false", async () => {
        const out = await collect({
            messages: [
                user("hello"),
                assistant([{ type: "text", text: "hi" }]),
                user("again"),
            ],
        });
        assert.equal(out.length, 3);
        assert.deepEqual(
            out.map((m) => m.message.role),
            ["user", "assistant", "user"]
        );
        assert.equal(out[0].shouldQuery, false);
        assert.equal(out[1].shouldQuery, false);
        assert.equal(out[2].shouldQuery, undefined); // trigger
    });

    void it("folds tool results into a user turn and keeps alternation", async () => {
        const out = await collect({
            messages: [
                user("do a thing"),
                assistant([
                    { type: "toolCall", id: "t1", name: "read", arguments: {} },
                ]),
                toolResult("t1", "file contents"),
                user("thanks"),
            ],
        });
        // toolResult and the trailing user text merge into one user turn.
        assert.deepEqual(
            out.map((m) => m.message.role),
            ["user", "assistant", "user"]
        );
        const toolFrame = out[2].message.content as Array<{
            type: string;
            tool_use_id?: string;
            text?: string;
        }>;
        assert.ok(
            toolFrame.some(
                (b) => b.type === "tool_result" && b.tool_use_id === "t1"
            )
        );
        assert.ok(
            toolFrame.some((b) => b.type === "text" && b.text === "thanks")
        );
        // The merged user turn is the trigger.
        assert.equal(out[2].shouldQuery, undefined);
        assert.equal(out[1].shouldQuery, false);
    });

    void it("merges consecutive tool results into one user frame", async () => {
        const out = await collect({
            messages: [
                assistant([
                    { type: "toolCall", id: "a", name: "read", arguments: {} },
                    { type: "toolCall", id: "b", name: "read", arguments: {} },
                ]),
                toolResult("a", "one"),
                toolResult("b", "two"),
            ],
        });
        assert.deepEqual(
            out.map((m) => m.message.role),
            ["assistant", "user"]
        );
        const userFrame = out[1].message.content as Array<{
            type: string;
            tool_use_id?: string;
        }>;
        assert.equal(
            userFrame.filter((b) => b.type === "tool_result").length,
            2
        );
    });

    void it("preserves thinking signatures on assistant replay", async () => {
        const out = await collect({
            messages: [
                assistant([
                    {
                        type: "thinking",
                        thinking: "reasoning",
                        thinkingSignature: "SIG",
                    },
                    { type: "text", text: "answer" },
                ]),
                user("ok"),
            ],
        });
        const asst = out[0].message.content as Array<Record<string, unknown>>;
        const thinking = asst.find((b) => b["type"] === "thinking");
        assert.equal(thinking?.["signature"], "SIG");
        assert.equal(thinking?.["thinking"], "reasoning");
    });

    void it("drops signatureless thinking rather than fabricating it", async () => {
        const out = await collect({
            messages: [
                assistant([
                    { type: "thinking", thinking: "no sig" },
                    { type: "text", text: "answer" },
                ]),
                user("ok"),
            ],
        });
        const asst = out[0].message.content as Array<Record<string, unknown>>;
        assert.equal(
            asst.find((b) => b["type"] === "thinking"),
            undefined
        );
    });

    void it("maps redacted thinking to a redacted_thinking block", async () => {
        const out = await collect({
            messages: [
                assistant([
                    {
                        type: "thinking",
                        thinking: "[redacted]",
                        thinkingSignature: "OPAQUE",
                        redacted: true,
                    },
                    { type: "text", text: "answer" },
                ]),
                user("ok"),
            ],
        });
        const asst = out[0].message.content as Array<Record<string, unknown>>;
        const redacted = asst.find((b) => b["type"] === "redacted_thinking");
        assert.equal(redacted?.["data"], "OPAQUE");
    });

    void it("maps assistant tool calls to Claude Code names and args", async () => {
        const out = await collect({
            messages: [
                assistant([
                    {
                        type: "toolCall",
                        id: "t1",
                        name: "read",
                        arguments: { path: "/x", limit: 5 },
                    },
                ]),
                user("ok"),
            ],
        });
        const asst = out[0].message.content as Array<Record<string, unknown>>;
        const use = asst.find((b) => b["type"] === "tool_use");
        assert.equal(use?.["name"], "Read");
        const input = use?.["input"] as Record<string, unknown>;
        assert.equal(input["file_path"], "/x");
    });
});
