import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entryToMessage, getHandoffMessages } from "../features/handoff.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

void describe("entryToMessage", () => {
    void it("returns the message for message-type entries", () => {
        const entry = {
            type: "message",
            id: "e1",
            parentId: "p1",
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: "hello", timestamp: 0 },
        } as SessionEntry;
        const result = entryToMessage(entry);
        assert.ok(result);
        assert.equal("role" in result && result.role, "user");
    });

    void it("returns a compaction summary for compaction entries", () => {
        const entry = {
            type: "compaction",
            id: "e2",
            parentId: "p1",
            timestamp: new Date().toISOString(),
            summary: "summarised context",
            tokensBefore: 1000,
            firstKeptEntryId: "e3",
        } as SessionEntry;
        const result = entryToMessage(entry);
        assert.ok(result);
        if (result && "summary" in result) {
            assert.equal(result.summary, "summarised context");
        }
    });

    void it("returns undefined for unknown entry types", () => {
        assert.equal(
            entryToMessage({ type: "toolResult" } as never),
            undefined
        );
    });
});

void describe("getHandoffMessages", () => {
    function msgEntry(role: string, content: string, id = "e1"): SessionEntry {
        return {
            type: "message",
            id,
            parentId: "p1",
            timestamp: new Date(0).toISOString(),
            message: { role, content, timestamp: 0 },
        } as SessionEntry;
    }

    void it("converts all messages when no compaction", () => {
        const branch: SessionEntry[] = [
            msgEntry("user", "hi", "e1"),
            msgEntry("assistant", "hello", "e2"),
        ];
        const messages = getHandoffMessages(branch);
        assert.equal(messages.length, 2);
    });

    void it("returns empty for empty branch", () => {
        assert.deepEqual(getHandoffMessages([]), []);
    });

    void it("uses compaction as starting point when present", () => {
        const branch: SessionEntry[] = [
            msgEntry("user", "old", "e0"),
            {
                type: "compaction",
                id: "comp-1",
                parentId: "p1",
                timestamp: new Date().toISOString(),
                summary: "context",
                tokensBefore: 500,
                firstKeptEntryId: "e3",
            },
            msgEntry("user", "recent", "e3"),
            msgEntry("assistant", "response", "e4"),
        ];
        const messages = getHandoffMessages(branch);
        assert.ok(messages.length >= 2);
        const first = messages[0];
        assert.ok(first && "summary" in first);
        assert.equal(first.summary, "context");
    });

    void it("filters out undefined entries", () => {
        const branch: SessionEntry[] = [
            { type: "toolResult" } as never,
            msgEntry("user", "hi", "e1"),
        ];
        const messages = getHandoffMessages(branch);
        assert.equal(messages.length, 1);
    });
});
