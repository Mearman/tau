/**
 * Unit tests for the memory feature. Mirrors the test patterns in
 * `context-files.unit.test.ts` — tmpdir-based fixtures with beforeEach/
 * afterEach cleanup.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
    MEMORY_ENTRYPOINT_NAME,
    MEMORY_MAX_LINES,
    MEMORY_MAX_BYTES,
    truncateMemoryEntrypoint,
    discoverMemory,
    buildMemoryPrompt,
} from "../features/memory.ts";

void describe("truncateMemoryEntrypoint", () => {
    void it("returns raw content when under both caps", () => {
        const result = truncateMemoryEntrypoint("foo\nbar");
        assert.equal(result.content, "foo\nbar");
        assert.equal(result.lineCount, 2);
        assert.equal(result.byteCount, 7);
        assert.equal(result.wasLineTruncated, false);
        assert.equal(result.wasByteTruncated, false);
    });

    void it("trims leading and trailing whitespace before counting", () => {
        const result = truncateMemoryEntrypoint("  \nfoo\nbar\n  ");
        assert.equal(result.content, "foo\nbar");
        assert.equal(result.lineCount, 2);
    });

    void it("does not truncate at exactly 200 lines", () => {
        const content = Array.from({ length: 200 }, () => "x").join("\n");
        const result = truncateMemoryEntrypoint(content);
        assert.equal(result.wasLineTruncated, false);
        assert.equal(result.wasLineTruncated, false);
    });

    void it("truncates at 201 lines with warning", () => {
        const content = Array.from({ length: 201 }, () => "x").join("\n");
        const result = truncateMemoryEntrypoint(content);
        assert.equal(result.wasLineTruncated, true);
        assert.ok(result.content.includes("WARNING"));
        assert.ok(result.content.includes("201 lines"));
    });

    void it("byte-truncates a single long line", () => {
        const content = "x".repeat(MEMORY_MAX_BYTES + 1000);
        const result = truncateMemoryEntrypoint(content);
        assert.equal(result.wasByteTruncated, true);
        assert.ok(result.content.includes("WARNING"));
        assert.ok(result.content.length <= MEMORY_MAX_BYTES + 200); // + warning
    });

    void it("flags both caps when both would fire", () => {
        const content = Array.from({ length: 201 }, () => "x".repeat(200)).join(
            "\n"
        );
        const result = truncateMemoryEntrypoint(content);
        assert.equal(result.wasLineTruncated, true);
        assert.equal(result.wasByteTruncated, true);
    });

    void it("does not byte-truncate at exactly 25000 bytes", () => {
        const content = "x".repeat(MEMORY_MAX_BYTES);
        const result = truncateMemoryEntrypoint(content);
        assert.equal(result.wasByteTruncated, false);
    });

    void it("handles empty input", () => {
        // "".split("\n") returns [""], so lineCount is 1 by JS semantics.
        // The function matches the upstream memdir.ts behaviour.
        const result = truncateMemoryEntrypoint("");
        assert.equal(result.content, "");
        assert.equal(result.lineCount, 1);
        assert.equal(result.byteCount, 0);
        assert.equal(result.wasLineTruncated, false);
        assert.equal(result.wasByteTruncated, false);
    });

    void it("warning text names the formatted reason", () => {
        const content = Array.from({ length: 300 }, () => "x").join("\n");
        const result = truncateMemoryEntrypoint(content);
        assert.ok(result.content.includes("WARNING"));
        assert.ok(result.content.includes("300 lines"));
        assert.ok(result.content.includes(`limit: ${MEMORY_MAX_LINES}`));
    });
});

void describe("discoverMemory", () => {
    const testRoot = path.join(tmpdir(), "tau-test-memory-discover");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("returns null when no memory dir exists", () => {
        const cwd = path.join(testRoot, "project");
        fs.mkdirSync(cwd, { recursive: true });
        assert.equal(discoverMemory(cwd), null);
    });

    void it("finds .agents/memory/MEMORY.md at the cwd level", () => {
        const cwd = path.join(testRoot, "project");
        fs.mkdirSync(path.join(cwd, ".agents", "memory"), { recursive: true });
        fs.writeFileSync(
            path.join(cwd, ".agents", "memory", "MEMORY.md"),
            "- [foo](foo.md) — hook"
        );
        const result = discoverMemory(cwd);
        assert.ok(result);
        assert.equal(result.entrypoint.source, "agents");
        assert.equal(
            result.entrypoint.path,
            path.join(cwd, ".agents", "memory", "MEMORY.md")
        );
    });

    void it("falls back to .claude/memory/MEMORY.md when .agents/ absent", () => {
        const cwd = path.join(testRoot, "project");
        fs.mkdirSync(path.join(cwd, ".claude", "memory"), { recursive: true });
        fs.writeFileSync(
            path.join(cwd, ".claude", "memory", "MEMORY.md"),
            "- [bar](bar.md) — hook"
        );
        const result = discoverMemory(cwd);
        assert.ok(result);
        assert.equal(result.entrypoint.source, "claude");
    });

    void it("walks up to root, cwd wins over ancestor", () => {
        const cwd = path.join(testRoot, "outer", "inner");
        fs.mkdirSync(path.join(cwd, ".agents", "memory"), { recursive: true });
        fs.mkdirSync(path.join(testRoot, "outer", ".claude", "memory"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(cwd, ".agents", "memory", "MEMORY.md"),
            "inner"
        );
        fs.writeFileSync(
            path.join(testRoot, "outer", ".claude", "memory", "MEMORY.md"),
            "outer"
        );
        const result = discoverMemory(cwd);
        assert.ok(result);
        assert.equal(
            result.entrypoint.path,
            path.join(cwd, ".agents", "memory", "MEMORY.md")
        );
    });

    void it("dedupes topic files at the same level, .agents/ wins on conflict", () => {
        const cwd = path.join(testRoot, "project");
        fs.mkdirSync(path.join(cwd, ".agents", "memory"), { recursive: true });
        fs.mkdirSync(path.join(cwd, ".claude", "memory"), { recursive: true });
        fs.writeFileSync(path.join(cwd, ".agents", "memory", "MEMORY.md"), "x");
        fs.writeFileSync(
            path.join(cwd, ".agents", "memory", "shared.md"),
            "agents"
        );
        fs.writeFileSync(
            path.join(cwd, ".claude", "memory", "shared.md"),
            "claude"
        );
        fs.writeFileSync(
            path.join(cwd, ".claude", "memory", "only-claude.md"),
            "claude-only"
        );
        const result = discoverMemory(cwd);
        assert.ok(result);
        const names = result.topicFiles.map((p) => path.basename(p));
        assert.ok(names.includes("shared.md"));
        assert.ok(names.includes("only-claude.md"));
        // .agents/ version of shared.md should win
        const sharedPath = result.topicFiles.find((p) =>
            p.endsWith("shared.md")
        );
        assert.ok(sharedPath?.includes(".agents/"));
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0]?.canonicalName, "shared");
    });

    void it("skips the entrypoint file from the topic files list", () => {
        const cwd = path.join(testRoot, "project");
        fs.mkdirSync(path.join(cwd, ".agents", "memory"), { recursive: true });
        fs.writeFileSync(path.join(cwd, ".agents", "memory", "MEMORY.md"), "x");
        fs.writeFileSync(path.join(cwd, ".agents", "memory", "topic.md"), "y");
        const result = discoverMemory(cwd);
        assert.ok(result);
        const names = result.topicFiles.map((p) => path.basename(p));
        assert.ok(!names.includes("MEMORY.md"));
        assert.ok(names.includes("topic.md"));
    });
});

void describe("buildMemoryPrompt", () => {
    const testRoot = path.join(tmpdir(), "tau-test-memory-prompt");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(testRoot, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("emits 'currently empty' fallback for an empty MEMORY.md", () => {
        const memDir = path.join(testRoot, ".agents", "memory");
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, "MEMORY.md"), "");
        const discovered = discoverMemory(testRoot);
        assert.ok(discovered);
        const section = buildMemoryPrompt(discovered);
        assert.equal(section.wasEmpty, true);
        assert.equal(section.truncated, false);
        assert.ok(section.text.includes("currently empty"));
    });

    void it("includes the MEMORY.md content in the section text", () => {
        const memDir = path.join(testRoot, ".agents", "memory");
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(
            path.join(memDir, "MEMORY.md"),
            "- [test](test.md) — test hook"
        );
        const discovered = discoverMemory(testRoot);
        assert.ok(discovered);
        const section = buildMemoryPrompt(discovered);
        assert.ok(section.text.includes("[test](test.md)"));
        assert.ok(section.text.includes("test hook"));
    });

    void it("marks truncated when MEMORY.md exceeds the line cap", () => {
        const memDir = path.join(testRoot, ".agents", "memory");
        fs.mkdirSync(memDir, { recursive: true });
        const lines = Array.from(
            { length: 300 },
            (_, i) => `- [t${i}](t${i}.md) — hook ${i}`
        );
        fs.writeFileSync(path.join(memDir, "MEMORY.md"), lines.join("\n"));
        const discovered = discoverMemory(testRoot);
        assert.ok(discovered);
        const section = buildMemoryPrompt(discovered);
        assert.equal(section.truncated, true);
        assert.ok(section.text.includes("WARNING"));
    });

    void it("does NOT include topic file content in the prompt", () => {
        // Topic files are read on demand; only the index is auto-loaded.
        const memDir = path.join(testRoot, ".agents", "memory");
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, "MEMORY.md"), "- [foo](foo.md)");
        fs.writeFileSync(
            path.join(memDir, "foo.md"),
            "SHOULD-NOT-APPEAR-IN-PROMPT secret content"
        );
        const discovered = discoverMemory(testRoot);
        assert.ok(discovered);
        const section = buildMemoryPrompt(discovered);
        assert.ok(!section.text.includes("SHOULD-NOT-APPEAR-IN-PROMPT"));
        assert.ok(!section.text.includes("secret content"));
    });

    void it("includes the four-type taxonomy", () => {
        const memDir = path.join(testRoot, ".agents", "memory");
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, "MEMORY.md"), "x");
        const discovered = discoverMemory(testRoot);
        assert.ok(discovered);
        const section = buildMemoryPrompt(discovered);
        assert.ok(section.text.includes("user"));
        assert.ok(section.text.includes("feedback"));
        assert.ok(section.text.includes("project"));
        assert.ok(section.text.includes("reference"));
    });
});

void describe("memory constants", () => {
    void it("exports the expected names", () => {
        assert.equal(MEMORY_ENTRYPOINT_NAME, "MEMORY.md");
        assert.equal(MEMORY_MAX_LINES, 200);
        assert.equal(MEMORY_MAX_BYTES, 25_000);
    });
});
