import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantText, truncateNotificationBody } from "../utils.ts";

void describe("lastAssistantText — edge cases", () => {
    void it("extracts text from string content", () => {
        const messages = [{ role: "assistant", content: "string response" }];
        // String content is not array — should return undefined
        assert.equal(lastAssistantText(messages as never), undefined);
    });

    void it("extracts from content with mixed block types", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash" },
                    { type: "text", text: "here is the output" },
                ],
            },
        ];
        assert.equal(lastAssistantText(messages), "here is the output");
    });

    void it("skips blocks without text", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "" },
                    { type: "image", url: "http://x" },
                ],
            },
        ];
        assert.equal(lastAssistantText(messages), undefined);
    });
});

void describe("truncateNotificationBody — edge cases", () => {
    void it("handles exactly 200 characters", () => {
        const text = "a".repeat(200);
        assert.equal(truncateNotificationBody(text), text);
    });

    void it("handles exactly 201 characters", () => {
        const text = "a".repeat(201);
        const result = truncateNotificationBody(text);
        assert.equal(result.length, 200);
        assert.ok(result.endsWith("…"));
    });
});
