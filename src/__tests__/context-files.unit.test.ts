import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir, homedir } from "node:os";
import {
    parseFrontmatter,
    stripHtmlComments,
    extractIncludePaths,
    findMarkdownFiles,
    discoverContextFiles,
} from "../features/context-files.ts";

void describe("parseFrontmatter", () => {
    void it("returns raw content when no frontmatter", () => {
        const result = parseFrontmatter("hello world");
        assert.equal(result.content, "hello world");
        assert.equal(result.globs, undefined);
    });

    void it("extracts content without frontmatter", () => {
        const input = "---\npaths: *.ts\n---\nbody text";
        const result = parseFrontmatter(input);
        assert.equal(result.content, "body text");
        assert.deepEqual(result.globs, ["*.ts"]);
    });

    void it("handles comma-separated paths", () => {
        const input = "---\npaths: *.ts, *.tsx, *.js\n---\nbody";
        const result = parseFrontmatter(input);
        assert.deepEqual(result.globs, ["*.ts", "*.tsx", "*.js"]);
    });

    void it("expands brace patterns", () => {
        const input = "---\npaths: src/*.{ts,tsx}\n---\nbody";
        const result = parseFrontmatter(input);
        assert.deepEqual(result.globs, ["src/*.ts", "src/*.tsx"]);
    });

    void it("returns undefined globs for match-all **", () => {
        const input = "---\npaths: **\n---\nbody";
        const result = parseFrontmatter(input);
        assert.equal(result.globs, undefined);
    });

    void it("returns undefined globs when no paths field", () => {
        const input = "---\ndescription: test\n---\nbody";
        const result = parseFrontmatter(input);
        assert.equal(result.globs, undefined);
        assert.equal(result.content, "body");
    });
});

void describe("stripHtmlComments", () => {
    void it("returns content unchanged when no comments", () => {
        assert.equal(stripHtmlComments("hello"), "hello");
    });

    void it("strips block-level HTML comments", () => {
        const input = "before\n<!-- this is a comment -->\nafter";
        const result = stripHtmlComments(input);
        assert.ok(!result.includes("this is a comment"));
        assert.ok(result.includes("before"));
        assert.ok(result.includes("after"));
    });

    void it("preserves comments inside code blocks", () => {
        const input = "```\n<!-- kept -->\n```\nafter";
        const result = stripHtmlComments(input);
        assert.ok(result.includes("<!-- kept -->"));
    });

    void it("keeps residual text after comment close on same line", () => {
        const input = "<!-- note -->Use bun\nnext line";
        const result = stripHtmlComments(input);
        assert.ok(result.includes("Use bun"));
        assert.ok(!result.includes("note"));
    });
});

void describe("extractIncludePaths", () => {
    void it("extracts relative paths", () => {
        const result = extractIncludePaths(
            "see @./shared.md for details",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/shared.md"]);
    });

    void it("extracts absolute paths", () => {
        const result = extractIncludePaths(
            "see @/etc/config.yaml",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, ["/etc/config.yaml"]);
    });

    void it("extracts home-relative paths", () => {
        const result = extractIncludePaths(
            "see @~/.config/settings.json",
            "/project/AGENTS.md"
        );
        const expected = path.resolve(homedir(), ".config/settings.json");
        assert.deepEqual(result, [expected]);
    });

    void it("extracts bare paths (treated as relative)", () => {
        const result = extractIncludePaths(
            "see @helpers/utils.md",
            "/project/sub/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/sub/helpers/utils.md"]);
    });

    void it("skips @mentions inside fenced code blocks", () => {
        const result = extractIncludePaths(
            "```\n@./inside-code.md\n```\n@./outside.md",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/outside.md"]);
    });

    void it("strips fragment identifiers", () => {
        const result = extractIncludePaths(
            "see @./doc.md#section",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/doc.md"]);
    });

    void it("skips email-like @mentions", () => {
        const result = extractIncludePaths(
            "email user@example.com and @./real.md",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/real.md"]);
    });
});

void describe("findMarkdownFiles", () => {
    const testDir = path.join(tmpdir(), "tau-test-find-md");

    beforeEach(() => {
        fs.mkdirSync(path.join(testDir, "sub"), { recursive: true });
        fs.writeFileSync(path.join(testDir, "a.md"), "");
        fs.writeFileSync(path.join(testDir, "b.md"), "");
        fs.writeFileSync(path.join(testDir, "c.txt"), "");
        fs.writeFileSync(path.join(testDir, "sub", "d.md"), "");
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    void it("finds .md files recursively", () => {
        const result = findMarkdownFiles(testDir);
        assert.deepEqual(result.sort(), ["a.md", "b.md", "sub/d.md"]);
    });

    void it("returns empty for nonexistent directory", () => {
        assert.deepEqual(findMarkdownFiles("/nonexistent"), []);
    });
});

void describe("discoverContextFiles", () => {
    const testRoot = path.join(tmpdir(), "tau-test-context-discover");

    beforeEach(() => {
        // Create a directory structure:
        // testRoot/
        //   AGENTS.md
        //   CLAUDE.local.md
        //   .agents/
        //     AGENTS.md
        //     rules/
        //       naming.md
        //   .claude/
        //     CLAUDE.md
        //     rules/
        //       testing.md
        //   sub/
        //     AGENTS.md
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRoot, ".agents", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, ".claude", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, "sub"), { recursive: true });

        fs.writeFileSync(path.join(testRoot, "AGENTS.md"), "# Root agents");
        fs.writeFileSync(
            path.join(testRoot, "CLAUDE.local.md"),
            "# Local config"
        );
        fs.writeFileSync(
            path.join(testRoot, ".agents", "AGENTS.md"),
            "# Agents dir"
        );
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "naming.md"),
            "---\npaths: *.ts\n---\nUse camelCase"
        );
        fs.writeFileSync(
            path.join(testRoot, ".claude", "CLAUDE.md"),
            "# Claude dir"
        );
        fs.writeFileSync(
            path.join(testRoot, ".claude", "rules", "testing.md"),
            "Always write tests"
        );
        fs.writeFileSync(
            path.join(testRoot, "sub", "AGENTS.md"),
            "# Sub project"
        );
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("discovers files from root level", () => {
        const files = discoverContextFiles(testRoot);
        const paths = files.map((f) => f.path);

        assert.ok(
            paths.some((p) => p.endsWith("AGENTS.md") && !p.includes("sub")),
            "root AGENTS.md"
        );
        assert.ok(
            paths.some((p) => p.endsWith("CLAUDE.local.md")),
            "local file"
        );
        assert.ok(
            paths.some((p) => p.includes(".agents/AGENTS.md")),
            ".agents/AGENTS.md"
        );
        assert.ok(
            paths.some((p) => p.includes(".agents/rules/naming.md")),
            ".agents/rules/naming.md"
        );
        assert.ok(
            paths.some((p) => p.includes(".claude/CLAUDE.md")),
            ".claude/CLAUDE.md"
        );
        assert.ok(
            paths.some((p) => p.includes(".claude/rules/testing.md")),
            ".claude/rules/testing.md"
        );
    });

    void it("discovers files from subdirectory (walk includes root)", () => {
        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const paths = files.map((f) => f.path);

        // Root files come first, then sub files
        assert.ok(
            paths.some((p) => p.endsWith("AGENTS.md") && !p.includes("sub")),
            "root AGENTS.md"
        );
        assert.ok(
            paths.some((p) => p.includes("sub/AGENTS.md")),
            "sub AGENTS.md"
        );

        // Root AGENTS.md should appear before sub AGENTS.md
        const rootIdx = paths.findIndex(
            (p) => p.endsWith("AGENTS.md") && !p.includes("sub")
        );
        const subIdx = paths.findIndex((p) => p.includes("sub/AGENTS.md"));
        assert.ok(rootIdx < subIdx, "root before sub");
    });

    void it("extracts globs from frontmatter", () => {
        const files = discoverContextFiles(testRoot);
        const naming = files.find((f) => f.path.includes("naming.md"));
        assert.ok(naming);
        assert.deepEqual(naming?.globs, ["*.ts"]);
    });

    void it("strips HTML comments from content", () => {
        fs.writeFileSync(
            path.join(testRoot, "sub", "AGENTS.md"),
            "# Sub\n<!-- secret -->\nproject"
        );
        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const sub = files.find((f) => f.path.includes("sub/AGENTS.md"));
        assert.ok(sub);
        assert.ok(!sub?.content.includes("secret"));
        assert.ok(sub?.content.includes("project"));
    });

    void it("resolves @include directives", () => {
        fs.mkdirSync(path.join(testRoot, "shared"), { recursive: true });
        fs.writeFileSync(
            path.join(testRoot, "shared", "base.md"),
            "Base instructions"
        );
        fs.writeFileSync(
            path.join(testRoot, "AGENTS.md"),
            "# Root\n@include @./shared/base.md"
        );

        const files = discoverContextFiles(testRoot);
        const included = files.find((f) => f.path.includes("shared/base.md"));
        assert.ok(included, "@included file found");
        assert.equal(included?.content, "Base instructions");
        assert.ok(
            included?.parent?.endsWith("AGENTS.md"),
            "parent points to including file"
        );
    });

    void it("deduplicates files across the walk", () => {
        // Root has AGENTS.md + .agents/AGENTS.md, sub has AGENTS.md
        // Total unique AGENTS.md: root (top-level), .agents/AGENTS.md, sub/AGENTS.md = 3
        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const agentsPaths = files
            .filter((f) => f.path.endsWith("AGENTS.md"))
            .map((f) => f.path);
        // Same file should never appear twice
        const unique = new Set(agentsPaths);
        assert.equal(unique.size, agentsPaths.length, "no duplicate paths");
    });

    void it("prefers AGENTS.md over CLAUDE.md (first match wins)", () => {
        // Both exist at root — only AGENTS.md should be loaded
        const files = discoverContextFiles(testRoot);
        const topLevel = files.filter(
            (f) =>
                !f.path.includes(".agents") &&
                !f.path.includes(".claude") &&
                !f.path.includes("sub") &&
                !f.path.includes("local")
        );
        // AGENTS.md should be the only top-level project file
        const hasClaude = topLevel.some((f) => f.path.endsWith("CLAUDE.md"));
        assert.ok(
            !hasClaude,
            "CLAUDE.md at root should be skipped when AGENTS.md exists"
        );
    });
});
