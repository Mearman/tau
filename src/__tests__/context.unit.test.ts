import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
    formatTokens,
    roughTokens,
    analyseContext,
    buildGrid,
    generateSuggestions,
} from "../features/context.ts";

// Helper: build a valid SessionMessageEntry
function msgEntry(role: string, content: unknown[]): SessionEntry {
    return {
        type: "message",
        id: `entry-${Math.random()}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role, content, timestamp: Date.now() },
    } as SessionEntry;
}

const NO_TOOLS: ToolInfo[] = [];
const THEME = { fg: (_c: string, t: string) => t };

// ─── formatTokens ───────────────────────────────────────────────────

void describe("formatTokens", () => {
    void it("formats thousands with k suffix", () => {
        assert.equal(formatTokens(1_500), "2k");
        assert.equal(formatTokens(15_000), "15k");
        assert.equal(formatTokens(150_000), "150k");
    });

    void it("formats millions with M suffix", () => {
        assert.equal(formatTokens(1_500_000), "1.5M");
        assert.equal(formatTokens(2_000_000), "2.0M");
    });

    void it("formats small numbers as-is", () => {
        assert.equal(formatTokens(0), "0");
        assert.equal(formatTokens(42), "42");
        assert.equal(formatTokens(999), "999");
    });
});

// ─── roughTokens ────────────────────────────────────────────────────

void describe("roughTokens", () => {
    void it("estimates 1 token per 4 characters", () => {
        assert.equal(roughTokens("aaaa"), 1);
        assert.equal(roughTokens("a"), 1); // ceiling
        assert.equal(roughTokens(""), 0);
    });
});

// ─── analyseContext ─────────────────────────────────────────────────

void describe("analyseContext", () => {
    void it("categorises system prompt tokens", () => {
        const result = analyseContext(
            [],
            "You are a helpful assistant.",
            NO_TOOLS,
            100,
            200_000,
            "test-model"
        );
        const sysCat = result.categories.find(
            (c) => c.name === "System prompt"
        );
        assert.ok(sysCat);
        assert.ok(sysCat.tokens > 0);
    });

    void it("categorises tool definition tokens", () => {
        const tools: ToolInfo[] = [
            {
                name: "read",
                description: "Read a file",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                },
                sourceInfo: {} as ToolInfo["sourceInfo"],
            },
            {
                name: "bash",
                description: "Run a command",
                parameters: {
                    type: "object",
                    properties: { command: { type: "string" } },
                },
                sourceInfo: {} as ToolInfo["sourceInfo"],
            },
        ];
        const result = analyseContext([], "", tools, 500, 200_000, "test");
        const toolsCat = result.categories.find((c) => c.name === "Tools");
        assert.ok(toolsCat);
        assert.ok(toolsCat.tokens > 0);
        assert.equal(result.toolDefinitions.length, 2);
        assert.ok(
            result.toolDefinitions[0].tokens >= result.toolDefinitions[1].tokens
        );
    });

    void it("separates context files from system prompt", () => {
        const contextFiles = [
            {
                path: "/project/AGENTS.md",
                content: "Some project instructions here".repeat(10),
            },
            {
                path: "/home/user/.pi/agent/AGENTS.md",
                content: "Global instructions".repeat(10),
            },
        ];
        const result = analyseContext(
            [],
            "System prompt with lots of content including context files",
            NO_TOOLS,
            1000,
            200_000,
            "test",
            contextFiles
        );

        const ctxCat = result.categories.find(
            (c) => c.name === "Context files"
        );
        assert.ok(ctxCat);
        assert.ok(ctxCat.tokens > 0);
        assert.equal(result.contextFiles.length, 2);
        // Sorted by tokens descending
        assert.ok(
            result.contextFiles[0].tokens >= result.contextFiles[1].tokens
        );
    });

    void it("subtracts context file tokens from system prompt", () => {
        const basePrompt = "Base system prompt. ".repeat(500); // ~6k tokens
        const contextFiles = [
            { path: "/project/AGENTS.md", content: "x".repeat(400) }, // ~100 tokens
        ];
        const ctxFileTokens = roughTokens("x".repeat(400));
        const resultWith = analyseContext(
            [],
            basePrompt,
            NO_TOOLS,
            1000,
            200_000,
            "test",
            contextFiles
        );
        const resultWithout = analyseContext(
            [],
            basePrompt,
            NO_TOOLS,
            1000,
            200_000,
            "test"
        );
        const sysWith = resultWith.categories.find(
            (c) => c.name === "System prompt"
        );
        const sysWithout = resultWithout.categories.find(
            (c) => c.name === "System prompt"
        );
        assert.ok(sysWith && sysWithout);
        assert.equal(sysWith.tokens, sysWithout.tokens - ctxFileTokens);
    });

    void it("categorises skills", () => {
        const skillCommands = [
            {
                name: "journal",
                description: "Record temporal entries",
                source: "skill" as const,
                sourceInfo:
                    {} as import("@earendil-works/pi-coding-agent").SourceInfo,
            },
            {
                name: "memory",
                description: "Extract reusable patterns",
                source: "skill" as const,
                sourceInfo:
                    {} as import("@earendil-works/pi-coding-agent").SourceInfo,
            },
        ];
        const result = analyseContext(
            [],
            "",
            NO_TOOLS,
            500,
            200_000,
            "test",
            undefined,
            skillCommands
        );
        const skillsCat = result.categories.find((c) => c.name === "Skills");
        assert.ok(skillsCat);
        assert.ok(skillsCat.tokens > 0);
        assert.equal(result.skills.length, 2);
    });

    void it("subtracts skill tokens from system prompt", () => {
        const basePrompt = "Base prompt. ".repeat(500); // ~6k tokens
        const skillCommands = [
            {
                name: "journal",
                description: "A long description " + "x".repeat(400),
                source: "skill" as const,
                sourceInfo:
                    {} as import("@earendil-works/pi-coding-agent").SourceInfo,
            },
        ];
        const resultWith = analyseContext(
            [],
            basePrompt,
            NO_TOOLS,
            1000,
            200_000,
            "test",
            undefined,
            skillCommands
        );
        const resultWithout = analyseContext(
            [],
            basePrompt,
            NO_TOOLS,
            1000,
            200_000,
            "test"
        );
        const sysWith = resultWith.categories.find(
            (c) => c.name === "System prompt"
        );
        const sysWithout = resultWithout.categories.find(
            (c) => c.name === "System prompt"
        );
        assert.ok(sysWith && sysWithout);
        assert.ok(sysWith.tokens < sysWithout.tokens);
    });

    void it("breaks down assistant and user messages", () => {
        const entries: SessionEntry[] = [
            msgEntry("user", [{ type: "text", text: "Hello" }]),
            msgEntry("assistant", [
                { type: "text", text: "Let me check." },
                {
                    type: "toolCall",
                    name: "read",
                    arguments: { path: "/file.ts" },
                },
            ]),
        ];
        const result = analyseContext(
            entries,
            "",
            NO_TOOLS,
            1000,
            200_000,
            "test"
        );
        const msgCat = result.categories.find((c) => c.name === "Messages");
        assert.ok(msgCat);
        assert.ok(result.messageBreakdown.assistantTextTokens > 0);
        assert.ok(result.messageBreakdown.userTextTokens > 0);
        assert.ok(result.messageBreakdown.toolCallTokens > 0);
    });

    void it("tracks tool results by tool name", () => {
        const entries: SessionEntry[] = [
            msgEntry("user", [
                {
                    type: "toolResult",
                    name: "read",
                    content:
                        "file contents here that are reasonably long to have tokens",
                },
            ]),
        ];
        const result = analyseContext(
            entries,
            "",
            NO_TOOLS,
            800,
            200_000,
            "test"
        );
        const readTool = result.messageBreakdown.toolCallsByType.find(
            (t) => t.name === "read"
        );
        assert.ok(readTool);
    });

    void it("uses authoritative total when provided", () => {
        const result = analyseContext(
            [],
            "prompt",
            NO_TOOLS,
            50_000,
            200_000,
            "test"
        );
        assert.equal(result.totalTokens, 50_000);
    });

    void it("falls back to estimated total", () => {
        const result = analyseContext(
            [msgEntry("user", [{ type: "text", text: "Hi" }])],
            "prompt",
            NO_TOOLS,
            null,
            200_000,
            "test"
        );
        assert.ok(result.totalTokens > 0);
    });

    void it("sorts tool breakdown by total descending", () => {
        const entries: SessionEntry[] = [
            msgEntry("assistant", [
                { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
            ]),
            msgEntry("assistant", [
                { type: "toolCall", name: "read", arguments: { path: "a" } },
                { type: "toolCall", name: "read", arguments: { path: "b" } },
                { type: "toolCall", name: "read", arguments: { path: "c" } },
            ]),
        ];
        const result = analyseContext(
            entries,
            "",
            NO_TOOLS,
            1000,
            200_000,
            "test"
        );
        assert.ok(result.messageBreakdown.toolCallsByType.length >= 2);
        assert.equal(result.messageBreakdown.toolCallsByType[0].name, "read");
    });

    void it("skips non-message entries", () => {
        const entries: SessionEntry[] = [
            {
                type: "compaction",
                id: "c1",
                parentId: null,
                timestamp: new Date().toISOString(),
                summary: "old stuff",
                firstKeptEntryId: "e1",
                tokensBefore: 0,
            },
        ];
        const result = analyseContext(
            entries,
            "",
            NO_TOOLS,
            0,
            200_000,
            "test"
        );
        const msgCat = result.categories.find((c) => c.name === "Messages");
        assert.equal(msgCat, undefined);
    });

    void it("includes autocompact or compact buffer category", () => {
        const result = analyseContext([], "", NO_TOOLS, 0, 200_000, "test");
        const buf = result.categories.find(
            (c) =>
                c.name === "Autocompact buffer" || c.name === "Compact buffer"
        );
        assert.ok(buf);
    });

    void it("includes free space category", () => {
        const result = analyseContext([], "", NO_TOOLS, 0, 200_000, "test");
        const free = result.categories.find((c) => c.name === "Free space");
        assert.ok(free);
        assert.ok(free.tokens > 0);
    });

    void it("reports percent from authoritative total", () => {
        const result = analyseContext(
            [],
            "",
            NO_TOOLS,
            100_000,
            200_000,
            "test"
        );
        assert.equal(result.percent, 50);
    });

    void it("reports null percent when no authoritative total", () => {
        const result = analyseContext([], "", NO_TOOLS, null, 200_000, "test");
        assert.equal(result.percent, null);
    });
});

// ─── buildGrid ──────────────────────────────────────────────────────

void describe("buildGrid", () => {
    void it("fills the grid to totalSquares (100 for 200k)", () => {
        const data = analyseContext(
            [],
            "sys",
            NO_TOOLS,
            60_000,
            200_000,
            "test"
        );
        const { grid } = buildGrid(data, THEME);
        let total = 0;
        for (const row of grid) total += row.length;
        assert.equal(total, 100);
        assert.equal(grid.length, 10); // 10 rows
    });

    void it("uses 20×10 grid for 1M+ context", () => {
        const data = analyseContext(
            [],
            "sys",
            NO_TOOLS,
            100_000,
            1_000_000,
            "test"
        );
        const { grid } = buildGrid(data, THEME);
        let total = 0;
        for (const row of grid) total += row.length;
        assert.equal(total, 200);
        assert.equal(grid.length, 10);
    });

    void it("has legend entries for categories, free space, and buffer", () => {
        const data = analyseContext(
            [],
            "sys",
            NO_TOOLS,
            10_000,
            200_000,
            "test"
        );
        const { legend } = buildGrid(data, THEME);
        assert.ok(legend.length >= 3);
    });

    void it("handles zero-token state", () => {
        const data = analyseContext([], "", NO_TOOLS, 0, 200_000, "test");
        const { grid, legend } = buildGrid(data, THEME);
        let total = 0;
        for (const row of grid) total += row.length;
        assert.equal(total, 100);
        assert.ok(legend.length >= 1);
    });
});

// ─── generateSuggestions ────────────────────────────────────────────

void describe("generateSuggestions", () => {
    void it("warns when near capacity", () => {
        const data = analyseContext([], "", NO_TOOLS, 170_000, 200_000, "test");
        const suggestions = generateSuggestions(data);
        assert.ok(
            suggestions.some(
                (s) => s.severity === "warning" && s.title.includes("85% full")
            )
        );
    });

    void it("warns about large tool results", () => {
        const longText = "x".repeat(200_000);
        const entries: SessionEntry[] = [
            msgEntry("assistant", [
                {
                    type: "toolCall",
                    name: "bash",
                    arguments: { cmd: longText },
                },
            ]),
        ];
        const data = analyseContext(
            entries,
            "",
            NO_TOOLS,
            180_000,
            200_000,
            "test"
        );
        const suggestions = generateSuggestions(data);
        assert.ok(suggestions.some((s) => s.title.includes("bash")));
    });

    void it("warns about context file bloat", () => {
        const contextFiles = [
            {
                path: "/project/AGENTS.md",
                content: "x".repeat(100_000),
            },
        ];
        const data = analyseContext(
            [],
            "",
            NO_TOOLS,
            150_000,
            200_000,
            "test",
            contextFiles
        );
        const suggestions = generateSuggestions(data);
        assert.ok(suggestions.some((s) => s.title.includes("Context files")));
    });

    void it("warns when autocompact disabled and over 50%", () => {
        const data = analyseContext([], "", NO_TOOLS, 120_000, 200_000, "test");
        data.autoCompactEnabled = false;
        data.percent = 60;
        const suggestions = generateSuggestions(data);
        assert.ok(
            suggestions.some((s) => s.title === "Autocompact is disabled")
        );
    });

    void it("sorts warnings before info", () => {
        const data = analyseContext([], "", NO_TOOLS, 170_000, 200_000, "test");
        data.autoCompactEnabled = false;
        data.percent = 85;
        const suggestions = generateSuggestions(data);
        const firstWarning = suggestions.findIndex(
            (s) => s.severity === "warning"
        );
        const firstInfo = suggestions.findIndex((s) => s.severity === "info");
        if (firstWarning >= 0 && firstInfo >= 0) {
            assert.ok(firstWarning < firstInfo);
        }
    });

    void it("returns empty for healthy context", () => {
        const data = analyseContext([], "", NO_TOOLS, 10_000, 200_000, "test");
        data.autoCompactEnabled = true;
        const suggestions = generateSuggestions(data);
        assert.equal(suggestions.length, 0);
    });
});
