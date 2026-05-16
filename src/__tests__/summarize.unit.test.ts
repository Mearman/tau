import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    extractTextParts,
    extractToolCallLines,
    buildConversationText,
    buildSummaryPrompt,
} from "../features/summarize.ts";

void describe("extractTextParts", () => {
    void it("extracts from a plain string", () => {
        assert.deepEqual(extractTextParts("hello"), ["hello"]);
    });

    void it("extracts text blocks from an array", () => {
        const content = [
            { type: "text", text: "first" },
            { type: "image", url: "http://example.com" },
            { type: "text", text: "second" },
        ];
        assert.deepEqual(extractTextParts(content), ["first", "second"]);
    });

    void it("returns empty for non-string non-array", () => {
        assert.deepEqual(extractTextParts(42), []);
        assert.deepEqual(extractTextParts(null), []);
        assert.deepEqual(extractTextParts(undefined), []);
    });

    void it("skips non-object array entries", () => {
        assert.deepEqual(extractTextParts([null, "string", 42]), []);
    });

    void it("returns empty for empty array", () => {
        assert.deepEqual(extractTextParts([]), []);
    });
});

void describe("extractToolCallLines", () => {
    void it("extracts tool calls from content array", () => {
        const content = [
            {
                type: "toolCall",
                name: "read",
                arguments: { path: "/src/file.ts" },
            },
            { type: "text", text: "hello" },
        ];
        const lines = extractToolCallLines(content);
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes("Tool read was called"));
        assert.ok(lines[0].includes("path"));
    });

    void it("returns empty for non-array", () => {
        assert.deepEqual(extractToolCallLines("string"), []);
        assert.deepEqual(extractToolCallLines(null), []);
    });

    void it("skips entries without name", () => {
        const content = [{ type: "toolCall", arguments: {} }];
        assert.deepEqual(extractToolCallLines(content), []);
    });

    void it("uses empty object for missing arguments", () => {
        const content = [{ type: "toolCall", name: "bash" }];
        const lines = extractToolCallLines(content);
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes("args {}"));
    });
});

void describe("buildConversationText", () => {
    void it("builds text from user and assistant messages", () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "Hello" }],
                },
            },
            {
                type: "message",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Hi there" }],
                },
            },
        ];
        const text = buildConversationText(entries);
        assert.ok(text.includes("User: Hello"));
        assert.ok(text.includes("Assistant: Hi there"));
    });

    void it("skips non-user/assistant roles", () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "system",
                    content: [{ type: "text", text: "sys" }],
                },
            },
        ];
        assert.equal(buildConversationText(entries), "");
    });

    void it("skips entries without type=message", () => {
        const entries = [{ type: "toolResult", message: { role: "user" } }];
        assert.equal(buildConversationText(entries), "");
    });

    void it("skips entries without a role", () => {
        const entries = [{ type: "message", message: {} }];
        assert.equal(buildConversationText(entries), "");
    });

    void it("includes tool call lines for assistant messages", () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Running" },
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "ls" },
                        },
                    ],
                },
            },
        ];
        const text = buildConversationText(entries);
        assert.ok(text.includes("Assistant: Running"));
        assert.ok(text.includes("Tool bash was called"));
    });

    void it("returns empty string for empty entries", () => {
        assert.equal(buildConversationText([]), "");
    });
});

void describe("buildSummaryPrompt", () => {
    void it("builds a prompt with conversation text", () => {
        const prompt = buildSummaryPrompt("some conversation");
        assert.ok(prompt.includes("some conversation"));
        assert.ok(prompt.includes("<conversation>"));
        assert.ok(prompt.includes("</conversation>"));
        assert.ok(prompt.includes("Summarize this conversation"));
    });

    void it("includes instructions about structure", () => {
        const prompt = buildSummaryPrompt("");
        assert.ok(prompt.includes("goals"));
        assert.ok(prompt.includes("key decisions"));
    });
});
