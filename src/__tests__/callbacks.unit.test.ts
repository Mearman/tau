/**
 * Tests for the callbacks feature — duration parsing and formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Duration parsing (replicated from callbacks.ts for unit testing) ---

const DURATION_RE = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;

function parseDurationToMs(input: string): number | null {
    const match = input.match(DURATION_RE);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = match[2];
    const units: Record<string, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
    };
    return value * units[unit];
}

function formatDuration(ms: number): string {
    const abs = Math.abs(ms);
    if (abs < 60_000) return `${Math.round(abs / 1_000)}s`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
    return `${Math.round(abs / 86_400_000)}d`;
}

void describe("callback duration parsing", () => {
    void it("parses seconds", () => {
        assert.equal(parseDurationToMs("30s"), 30_000);
        assert.equal(parseDurationToMs("1s"), 1_000);
    });

    void it("parses minutes", () => {
        assert.equal(parseDurationToMs("5m"), 300_000);
        assert.equal(parseDurationToMs("1m"), 60_000);
    });

    void it("parses hours", () => {
        assert.equal(parseDurationToMs("2h"), 7_200_000);
        assert.equal(parseDurationToMs("1h"), 3_600_000);
    });

    void it("parses days", () => {
        assert.equal(parseDurationToMs("1d"), 86_400_000);
        assert.equal(parseDurationToMs("7d"), 604_800_000);
    });

    void it("parses fractional durations", () => {
        assert.equal(parseDurationToMs("0.5s"), 500);
        assert.equal(parseDurationToMs("1.5m"), 90_000);
    });

    void it("returns null for invalid input", () => {
        assert.equal(parseDurationToMs("hello"), null);
        assert.equal(parseDurationToMs("5"), null);
        assert.equal(parseDurationToMs(""), null);
        assert.equal(parseDurationToMs("5x"), null);
    });
});

void describe("callback duration formatting", () => {
    void it("formats seconds", () => {
        assert.equal(formatDuration(30_000), "30s");
        assert.equal(formatDuration(500), "1s");
    });

    void it("formats minutes", () => {
        assert.equal(formatDuration(300_000), "5m");
        assert.equal(formatDuration(90_000), "2m");
    });

    void it("formats hours", () => {
        assert.equal(formatDuration(7_200_000), "2h");
        assert.equal(formatDuration(3_600_000), "1h");
    });

    void it("formats days", () => {
        assert.equal(formatDuration(86_400_000), "1d");
        assert.equal(formatDuration(172_800_000), "2d");
    });
});
