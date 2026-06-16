/**
 * Unit tests for the Claude-session -> pi-message converter.
 * Pure transform, no SDK dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertClaudeSession } from "../features/claude-resume.ts";

void describe("convertClaudeSession", () => {
    void it("converts a user text turn into a pi user message", () => {
        const out = convertClaudeSession([
            { type: "user", message: { role: "user", content: "hello" } },
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0].role, "user");
        const content = (out[0] as { content: unknown }).content;
        assert.deepEqual(content, [{ type: "text", text: "hello" }]);
    });

    void it("converts an assistant text turn with model + usage", () => {
        const out = convertClaudeSession([
            {
                type: "assistant",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "hi there" }],
                    model: "claude-haiku-4-5",
                    usage: { input_tokens: 5, output_tokens: 9 },
                    stop_reason: "end_turn",
                },
            },
        ]);
        assert.equal(out.length, 1);
        const am = out[0] as import("@earendil-works/pi-ai").AssistantMessage;
        assert.equal(am.role, "assistant");
        assert.equal(am.model, "claude-haiku-4-5");
        assert.equal(am.usage.input, 5);
        assert.equal(am.usage.output, 9);
        assert.equal(am.stopReason, "stop");
        assert.deepEqual(am.content, [{ type: "text", text: "hi there" }]);
    });

    void it("preserves assistant thinking with its signature", () => {
        const out = convertClaudeSession([
            {
                type: "assistant",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "thinking",
                            thinking: "reasoning here",
                            signature: "SIG",
                        },
                        { type: "text", text: "answer" },
                    ],
                    model: "claude-opus-4-7",
                    stop_reason: "end_turn",
                },
            },
        ]);
        const am = out[0] as import("@earendil-works/pi-ai").AssistantMessage;
        assert.equal(am.content[0].type, "thinking");
        assert.equal(
            (am.content[0] as { thinkingSignature?: string }).thinkingSignature,
            "SIG"
        );
    });

    void it("maps tool_use -> ToolCall and resolves tool_result names by id", () => {
        const out = convertClaudeSession([
            {
                type: "user",
                message: { role: "user", content: "read the file" },
            },
            {
                type: "assistant",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_1",
                            name: "Read",
                            input: { file_path: "/x" },
                        },
                    ],
                    model: "claude-opus-4-7",
                    stop_reason: "tool_use",
                },
            },
            {
                type: "user",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_1",
                            content: "file contents",
                            is_error: false,
                        },
                    ],
                },
            },
        ]);
        const am = out[1] as import("@earendil-works/pi-ai").AssistantMessage;
        assert.equal(am.stopReason, "toolUse");
        const call = am.content[0] as import("@earendil-works/pi-ai").ToolCall;
        assert.equal(call.type, "toolCall");
        assert.equal(call.id, "toolu_1");
        assert.equal(call.name, "Read");
        const tr = out[2] as import("@earendil-works/pi-ai").ToolResultMessage;
        assert.equal(tr.role, "toolResult");
        assert.equal(tr.toolCallId, "toolu_1");
        assert.equal(tr.toolName, "Read"); // resolved from the prior tool_use
        assert.equal(tr.isError, false);
    });

    void it("skips system and unmappable entries", () => {
        const out = convertClaudeSession([
            { type: "system", message: { role: "system", content: "meta" } },
            { type: "custom-title", message: "a title" },
            { type: "user", message: { role: "user", content: [] } }, // empty -> dropped
            { type: "assistant", message: "not a record" },
            { type: "user", message: { role: "user", content: "real" } },
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0].role, "user");
    });
});
