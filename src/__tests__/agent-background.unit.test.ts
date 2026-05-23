/**
 * Tests for the agent-background feature — context extraction and path choosing.
 *
 * All tests import directly from the source module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    chooseBackgroundPath,
    extractTextFromContent,
    extractLastAssistantSummary,
    extractOriginalPrompt,
    estimateConversationBytes,
} from "../features/agent-background.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ─── chooseBackgroundPath ────────────────────────────────────────────

void describe("chooseBackgroundPath", () => {
    void it("chooses fork when conversation is small", () => {
        // 4KB conversation, 128K context → ~1K tokens / 128K ≈ 0.8%
        assert.equal(chooseBackgroundPath(4096, 131072), "fork");
    });

    void it("chooses summary when conversation exceeds 40%", () => {
        // 250KB / 4 = 62.5K tokens / 128K ≈ 49%
        assert.equal(chooseBackgroundPath(250000, 128000), "summary");
    });

    void it("chooses fork at boundary 39%", () => {
        // boundary = 1.6 * tokens. 128000 * 1.6 = 204800
        assert.equal(chooseBackgroundPath(204000, 128000), "fork");
    });

    void it("chooses summary at boundary 41%", () => {
        assert.equal(chooseBackgroundPath(205000, 128000), "summary");
    });

    void it("defaults to fork for empty conversation", () => {
        assert.equal(chooseBackgroundPath(0, 32768), "fork");
    });
});

// ─── extractTextFromContent ──────────────────────────────────────────

void describe("extractTextFromContent", () => {
    void it("extracts from string content", () => {
        const result = extractTextFromContent("hello");
        assert.equal(result, "hello");
    });

    void it("extracts from text blocks", () => {
        const content = [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
        ];
        const result = extractTextFromContent(content);
        assert.equal(result, "line 1\nline 2");
    });

    void it("skips non-text blocks", () => {
        const content = [
            { type: "text", text: "visible" },
            { type: "thinking", thinking: "hidden" },
        ];
        const result = extractTextFromContent(content);
        assert.equal(result, "visible");
    });

    void it("returns empty string for empty array", () => {
        const result = extractTextFromContent([]);
        assert.equal(result, "");
    });
});

// ─── extractLastAssistantSummary ─────────────────────────────────────

void describe("extractLastAssistantSummary", () => {
    void it("extracts the last assistant message", () => {
        const entries = [
            makeMessage("user", "hello"),
            makeMessage("assistant", "first response"),
            makeMessage("user", "continue"),
            makeMessage("assistant", "final response with more detail"),
        ];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "final response with more detail");
    });

    void it("truncates to 2000 characters", () => {
        const longText = "x".repeat(3000);
        const entries = [makeMessage("assistant", longText)];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result.length, 2000);
    });

    void it("returns empty string when no assistant messages exist", () => {
        const entries = [makeMessage("user", "hello")];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "");
    });

    void it("skips non-message entries", () => {
        const entries: SessionEntry[] = [
            { type: "compaction" } as SessionEntry,
            makeMessage("assistant", "visible"),
        ];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "visible");
    });
});

// ─── extractOriginalPrompt ───────────────────────────────────────────

void describe("extractOriginalPrompt", () => {
    void it("extracts the first user message", () => {
        const entries = [
            makeMessage("user", "original prompt"),
            makeMessage("assistant", "response"),
            makeMessage("user", "follow-up"),
        ];
        const result = extractOriginalPrompt(entries);
        assert.equal(result, "original prompt");
    });

    void it("truncates to 2000 characters", () => {
        const longText = "y".repeat(3000);
        const entries = [makeMessage("user", longText)];
        const result = extractOriginalPrompt(entries);
        assert.equal(result.length, 2000);
    });

    void it("returns empty string when no user messages", () => {
        const entries = [makeMessage("assistant", "hello")];
        const result = extractOriginalPrompt(entries);
        assert.equal(result, "");
    });
});

// ─── estimateConversationBytes ───────────────────────────────────────

void describe("estimateConversationBytes", () => {
    void it("counts string content length", () => {
        const entries = [makeMessage("user", "hello")];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 5);
    });

    void it("sums across multiple messages", () => {
        const entries = [
            makeMessage("user", "hello"),
            makeMessage("assistant", "world"),
        ];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 10);
    });

    void it("counts text block content", () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "hello" },
                        { type: "thinking", thinking: "hidden" },
                    ],
                },
            } as SessionEntry,
        ];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 5);
    });

    void it("returns 0 for empty entries", () => {
        const result = estimateConversationBytes([]);
        assert.equal(result, 0);
    });
});

// ─── Test helpers ────────────────────────────────────────────────────

function makeMessage(role: string, text: string): SessionEntry {
    return {
        type: "message",
        message: { role, content: text },
    } as SessionEntry;
}
