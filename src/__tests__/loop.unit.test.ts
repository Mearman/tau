/**
 * Tests for /loop feature — parsing, inference, and formatting.
 *
 * All tests import directly from the source module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    parseDuration,
    parseCron,
    extractCompletionPromise,
    parseLoopArgs,
    formatDuration,
    inferInterval,
    inferPrompt,
    truncatePrompt,
} from "../features/loop.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ─── Duration parsing ────────────────────────────────────────────────

void describe("loop parseDuration", () => {
    void it("parses seconds", () => {
        assert.deepStrictEqual(parseDuration("30s"), {
            ms: 30_000,
            human: "30s",
        });
    });

    void it("parses minutes", () => {
        assert.deepStrictEqual(parseDuration("5m"), {
            ms: 300_000,
            human: "5m",
        });
    });

    void it("parses hours", () => {
        assert.deepStrictEqual(parseDuration("2h"), {
            ms: 7_200_000,
            human: "2h",
        });
    });

    void it("parses days", () => {
        assert.deepStrictEqual(parseDuration("1d"), {
            ms: 86_400_000,
            human: "1d",
        });
    });

    void it("returns null for plain number", () => {
        assert.equal(parseDuration("5"), null);
    });

    void it("returns null for text", () => {
        assert.equal(parseDuration("hello"), null);
    });
});

// ─── Cron parsing ────────────────────────────────────────────────────

void describe("loop parseCron", () => {
    void it("parses every-N-minutes", () => {
        assert.deepStrictEqual(parseCron("*/5 * * * *"), {
            ms: 300_000,
            human: "every 5m",
        });
    });

    void it("parses every-N-hours", () => {
        assert.deepStrictEqual(parseCron("0 */2 * * *"), {
            ms: 7_200_000,
            human: "every 2h",
        });
    });

    void it("parses every-N-days", () => {
        assert.deepStrictEqual(parseCron("0 0 */3 * *"), {
            ms: 259_200_000,
            human: "every 3d",
        });
    });

    void it("returns null for invalid expressions", () => {
        assert.equal(parseCron("* * *"), null);
        assert.equal(parseCron("hello world foo bar baz"), null);
    });

    void it("returns null for unsupported patterns", () => {
        // Specific minute + specific hour is not a simple periodic pattern
        assert.equal(parseCron("30 2 * * *"), null);
    });
});

// ─── Completion promise extraction ────────────────────────────────────

void describe("loop extractCompletionPromise", () => {
    void it("returns null when flag is absent", () => {
        const result = extractCompletionPromise("do something");
        assert.equal(result.completionPromise, null);
        assert.equal(result.remaining.trim(), "do something");
    });

    void it("extracts bare flag as default", () => {
        const result = extractCompletionPromise(
            "do something --completion-promise"
        );
        assert.equal(result.completionPromise, "default");
    });

    void it("extracts quoted value with =", () => {
        const result = extractCompletionPromise(
            'do something --completion-promise="all done"'
        );
        assert.equal(result.completionPromise, "all done");
    });

    void it("extracts unquoted value with =", () => {
        const result = extractCompletionPromise(
            "do something --completion-promise=custom-phrase"
        );
        assert.equal(result.completionPromise, "custom-phrase");
    });

    void it("extracts quoted value with space", () => {
        const result = extractCompletionPromise(
            'do something --completion-promise "all done"'
        );
        assert.equal(result.completionPromise, "all done");
    });
});

// ─── parseLoopArgs (integration of all parsers) ───────────────────────

void describe("loop parseLoopArgs", () => {
    void it("parses count mode with prompt", () => {
        const result = parseLoopArgs("5 do something");
        assert.equal(result.mode.kind, "count");
        if (result.mode.kind === "count") {
            assert.equal(result.mode.count, 5);
        }
        assert.equal(result.prompt, "do something");
    });

    void it("parses bare number as count mode with empty prompt", () => {
        const result = parseLoopArgs("5");
        assert.equal(result.mode.kind, "count");
        if (result.mode.kind === "count") {
            assert.equal(result.mode.count, 5);
        }
        assert.equal(result.prompt, "");
    });

    void it("parses interval mode with duration", () => {
        const result = parseLoopArgs("5m check the deploy");
        assert.equal(result.mode.kind, "interval");
        if (result.mode.kind === "interval") {
            assert.equal(result.mode.ms, 300_000);
        }
        assert.equal(result.prompt, "check the deploy");
    });

    void it("parses infinite mode with no prefix", () => {
        const result = parseLoopArgs("keep working");
        assert.equal(result.mode.kind, "infinite");
        assert.equal(result.prompt, "keep working");
    });

    void it("parses empty input as infinite with empty prompt", () => {
        const result = parseLoopArgs("");
        assert.equal(result.mode.kind, "infinite");
        assert.equal(result.prompt, "");
    });

    void it("preserves completion promise", () => {
        const result = parseLoopArgs(
            '5m check deploy --completion-promise="deployed"'
        );
        assert.equal(result.completionPromise, "deployed");
    });
});

// ─── Duration formatting ─────────────────────────────────────────────

void describe("loop formatDuration", () => {
    void it("formats seconds", () => {
        assert.equal(formatDuration(30_000), "30s");
    });

    void it("formats minutes", () => {
        assert.equal(formatDuration(300_000), "5m");
    });

    void it("formats hours", () => {
        assert.equal(formatDuration(7_200_000), "2h");
    });

    void it("formats days", () => {
        assert.equal(formatDuration(86_400_000), "1d");
    });
});

// ─── Interval inference ──────────────────────────────────────────────

void describe("loop inferInterval", () => {
    void it("infers 5s for watch keywords", () => {
        const entries = [makeMessageEntry("user", "watch the logs for errors")];
        const result = inferInterval(entries);
        assert.equal(result.ms, 5_000);
    });

    void it("infers 1m for deploy keywords", () => {
        const entries = [
            makeMessageEntry("assistant", "starting the deploy now"),
        ];
        const result = inferInterval(entries);
        assert.equal(result.ms, 60_000);
    });

    void it("infers 30s for test keywords", () => {
        const entries = [makeMessageEntry("user", "run the test suite")];
        const result = inferInterval(entries);
        assert.equal(result.ms, 30_000);
    });

    void it("infers 5m default for unrelated text", () => {
        const entries = [makeMessageEntry("user", "write some documentation")];
        const result = inferInterval(entries);
        assert.equal(result.ms, 300_000);
    });

    void it("infers default for empty entries", () => {
        const result = inferInterval([]);
        assert.equal(result.ms, 300_000);
    });

    void it("picks first matching hint from recent messages", () => {
        const entries = [
            makeMessageEntry("user", "build the project"),
            makeMessageEntry("assistant", "watch the build output"),
        ];
        const result = inferInterval(entries);
        // "watch" (5s) should win over "build" (1m) because it's first in hints
        assert.equal(result.ms, 5_000);
    });
});

// ─── Prompt inference ────────────────────────────────────────────────

void describe("loop inferPrompt", () => {
    void it("uses last user message as prompt", () => {
        const entries = [
            makeMessageEntry("assistant", "building the project"),
            makeMessageEntry("user", "check the test results"),
        ];
        const result = inferPrompt(entries);
        assert.equal(result, "check the test results");
    });

    void it("skips tick messages", () => {
        const entries = [
            makeMessageEntry("user", "original task"),
            {
                type: "message",
                message: {
                    role: "user",
                    content: `<tick>${new Date().toISOString()}</tick>`,
                },
            } as SessionEntry,
        ];
        const result = inferPrompt(entries);
        assert.equal(result, "original task");
    });

    void it("falls back to last assistant message", () => {
        const entries = [
            makeMessageEntry("assistant", "running the tests now"),
        ];
        const result = inferPrompt(entries);
        assert.equal(result, "running the tests now");
    });

    void it("returns default for empty entries", () => {
        const result = inferPrompt([]);
        assert.equal(result, "Continue working");
    });
});

// ─── Prompt truncation ───────────────────────────────────────────────

void describe("loop truncatePrompt", () => {
    void it("preserves short prompts unchanged", () => {
        assert.equal(truncatePrompt("check the build"), "check the build");
    });

    void it("truncates at sentence boundary when possible", () => {
        const long =
            "First sentence here. Second sentence here. Third sentence that makes it too long and keeps going and going and going and going and going and going and going and going.";
        const result = truncatePrompt(long);
        assert.ok(result.length <= 200);
        assert.ok(result.endsWith("."));
    });

    void it("appends ellipsis when no good boundary", () => {
        const long = "a".repeat(300);
        const result = truncatePrompt(long);
        assert.ok(result.endsWith("…"));
        assert.ok(result.length <= 201);
    });
});

// ─── Test helpers ────────────────────────────────────────────────────

function makeMessageEntry(role: string, text: string): SessionEntry {
    return {
        type: "message",
        message: { role, content: text },
    } as SessionEntry;
}
