import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAssistantMessage, getTextContent } from "../features/plan-mode.ts";

void describe("isAssistantMessage", () => {
    void it("returns true for assistant messages with array content", () => {
        assert.equal(
            isAssistantMessage({
                role: "assistant",
                content: [{ type: "text", text: "hi" }],
            }),
            true
        );
    });

    void it("returns false for non-assistant roles", () => {
        assert.equal(
            isAssistantMessage({ role: "user", content: "hi" }),
            false
        );
    });

    void it("returns false for assistant with non-array content", () => {
        assert.equal(
            isAssistantMessage({ role: "assistant", content: "string" }),
            false
        );
    });

    void it("returns false for undefined content", () => {
        assert.equal(isAssistantMessage({ role: "assistant" }), false);
    });
});

void describe("getTextContent", () => {
    void it("extracts text from text blocks", () => {
        const msg = {
            role: "assistant",
            content: [
                { type: "text", text: "hello" },
                { type: "text", text: "world" },
            ],
            api: "openai",
            provider: "openai",
            model: "gpt-4",
            usage: { input: 0, output: 0, cost: { total: 0 } },
            stopReason: "stop",
            timestamp: 0,
        };
        assert.equal(getTextContent(msg as never), "hello\nworld");
    });

    void it("returns empty string when no text blocks", () => {
        const msg = {
            role: "assistant",
            content: [{ type: "image", url: "http://x" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4",
            usage: { input: 0, output: 0, cost: { total: 0 } },
            stopReason: "stop",
            timestamp: 0,
        };
        assert.equal(getTextContent(msg as never), "");
    });
});
