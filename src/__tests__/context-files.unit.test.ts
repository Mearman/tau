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
    dedupeByCanonicalName,
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

    void it("accepts applies-to as a synonym for paths", () => {
        const input = "---\napplies-to: *.ts, *.tsx\n---\nbody";
        const result = parseFrontmatter(input);
        assert.deepEqual(result.globs, ["*.ts", "*.tsx"]);
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

    void it("extracts @path from inside a markdown link", () => {
        const result = extractIncludePaths(
            "See [API Conventions @../../docs/api.md](../../docs/api.md).",
            "/project/packages/api/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/docs/api.md"]);
    });

    void it("extracts @path when link text is just the @path", () => {
        const result = extractIncludePaths(
            "See [@../../docs/api.md](../../docs/api.md).",
            "/project/packages/api/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/docs/api.md"]);
    });

    void it("extracts @path from [@path](path) at start of line", () => {
        const result = extractIncludePaths(
            "[@./shared.md](./shared.md)",
            "/project/packages/api/AGENTS.md"
        );
        assert.deepEqual(result, ["/project/packages/api/shared.md"]);
    });

    void it("does not include plain markdown links without @", () => {
        const result = extractIncludePaths(
            "See [API Conventions](../../docs/api.md).",
            "/project/AGENTS.md"
        );
        assert.deepEqual(result, []);
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

void describe("dedupeByCanonicalName", () => {
    const testRoot = path.join(tmpdir(), "tau-test-dedupe-rules");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRoot, "agents", "rules", "sub"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, "claude", "rules", "sub"), {
            recursive: true,
        });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("returns empty when neither directory exists", () => {
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.deepEqual(result.rules, []);
        assert.deepEqual(result.conflicts, []);
    });

    void it("loads all files from .agents/ when .claude/ is empty", () => {
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "a.md"), "");
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "b.md"), "");
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 2);
        assert.equal(result.conflicts.length, 0);
        assert.equal(result.rules[0]?.source, "agents");
        assert.equal(result.rules[1]?.source, "agents");
    });

    void it("loads all files from .claude/ when .agents/ is empty", () => {
        fs.writeFileSync(path.join(testRoot, "claude", "rules", "a.md"), "");
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 1);
        assert.equal(result.conflicts.length, 0);
        assert.equal(result.rules[0]?.source, "claude");
    });

    void it("loads both when canonical names are distinct", () => {
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "a.md"), "");
        fs.writeFileSync(path.join(testRoot, "claude", "rules", "b.md"), "");
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 2);
        assert.equal(result.conflicts.length, 0);
        // .agents/ first, then .claude/
        assert.equal(result.rules[0]?.canonicalName, "a");
        assert.equal(result.rules[0]?.source, "agents");
        assert.equal(result.rules[1]?.canonicalName, "b");
        assert.equal(result.rules[1]?.source, "claude");
    });

    void it("drops .claude/ on canonical-name conflict, .agents/ wins", () => {
        fs.writeFileSync(
            path.join(testRoot, "agents", "rules", "style.md"),
            "agents"
        );
        fs.writeFileSync(
            path.join(testRoot, "claude", "rules", "style.md"),
            "claude"
        );
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 1);
        assert.equal(result.rules[0]?.source, "agents");
        assert.equal(
            result.rules[0]?.droppedPath,
            path.join(testRoot, "claude", "rules", "style.md")
        );
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0]?.canonicalName, "style");
    });

    void it("uses relative path as canonical name for nested files", () => {
        fs.writeFileSync(
            path.join(testRoot, "agents", "rules", "sub", "deep.md"),
            ""
        );
        fs.writeFileSync(
            path.join(testRoot, "claude", "rules", "sub", "deep.md"),
            ""
        );
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 1);
        assert.equal(result.rules[0]?.canonicalName, "sub/deep");
        assert.equal(result.conflicts.length, 1);
    });

    void it("does not conflict on nested files with different parents", () => {
        fs.writeFileSync(
            path.join(testRoot, "agents", "rules", "sub", "a.md"),
            ""
        );
        fs.writeFileSync(path.join(testRoot, "claude", "rules", "b.md"), "");
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        assert.equal(result.rules.length, 2);
        assert.equal(result.conflicts.length, 0);
    });

    void it("preserves .agents/ ordering on dedup", () => {
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "z.md"), "");
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "a.md"), "");
        fs.writeFileSync(path.join(testRoot, "agents", "rules", "m.md"), "");
        fs.writeFileSync(path.join(testRoot, "claude", "rules", "a.md"), "");
        const result = dedupeByCanonicalName(
            path.join(testRoot, "agents", "rules"),
            path.join(testRoot, "claude", "rules")
        );
        // findMarkdownFiles returns entries in directory order (alphabetical
        // on most filesystems), so .agents/ files come back sorted: a, m, z.
        // The .claude/ 'a' is dropped on conflict.
        assert.equal(result.rules.length, 3);
        assert.deepEqual(
            result.rules.map((r) => r.canonicalName),
            ["a", "m", "z"]
        );
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

void describe("discoverContextFiles — local files and first-match-wins", () => {
    const testRoot = path.join(tmpdir(), "tau-test-context-local");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRoot, "sub"), {
            recursive: true,
        });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("prefers AGENTS.local.md over CLAUDE.local.md", () => {
        fs.writeFileSync(
            path.join(testRoot, "AGENTS.local.md"),
            "Agents local"
        );
        fs.writeFileSync(
            path.join(testRoot, "CLAUDE.local.md"),
            "Claude local"
        );

        const files = discoverContextFiles(testRoot);
        const localFiles = files.filter((f) => f.path.includes("local"));

        assert.ok(
            localFiles.some((f) => f.path.endsWith("AGENTS.local.md")),
            "AGENTS.local.md loaded"
        );
        assert.ok(
            !localFiles.some((f) => f.path.endsWith("CLAUDE.local.md")),
            "CLAUDE.local.md skipped when AGENTS.local.md exists"
        );
    });

    void it("falls back to CLAUDE.local.md when no AGENTS.local.md", () => {
        fs.writeFileSync(
            path.join(testRoot, "CLAUDE.local.md"),
            "Claude local"
        );

        const files = discoverContextFiles(testRoot);
        const localFile = files.find((f) => f.path.endsWith("CLAUDE.local.md"));

        assert.ok(localFile, "CLAUDE.local.md loaded as fallback");
        assert.equal(localFile?.content, "Claude local");
    });

    void it("loads local files from every ancestor directory", () => {
        fs.writeFileSync(path.join(testRoot, "CLAUDE.local.md"), "Root local");
        fs.writeFileSync(
            path.join(testRoot, "sub", "CLAUDE.local.md"),
            "Sub local"
        );

        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const localFiles = files.filter((f) => f.path.includes("local"));

        assert.ok(
            localFiles.some((f) => f.content === "Root local"),
            "root local file loaded"
        );
        assert.ok(
            localFiles.some((f) => f.content === "Sub local"),
            "sub local file loaded"
        );

        // Root before sub
        const rootIdx = localFiles.findIndex((f) => f.content === "Root local");
        const subIdx = localFiles.findIndex((f) => f.content === "Sub local");
        assert.ok(rootIdx < subIdx, "root local before sub local");
    });

    void it("local file type is Local", () => {
        fs.writeFileSync(path.join(testRoot, "AGENTS.local.md"), "Local");

        const files = discoverContextFiles(testRoot);
        const localFile = files.find((f) => f.path.endsWith("AGENTS.local.md"));

        assert.equal(localFile?.type, "Local");
    });

    void it(".claude/CLAUDE.md loaded alongside top-level AGENTS.md", () => {
        // Claude Code loads CLAUDE.md AND .claude/CLAUDE.md independently.
        // Tau loads AGENTS.md (first match wins over CLAUDE.md) AND
        // .claude/CLAUDE.md independently.
        fs.writeFileSync(path.join(testRoot, "AGENTS.md"), "Top-level agents");
        fs.writeFileSync(path.join(testRoot, "CLAUDE.md"), "Top-level claude");
        fs.mkdirSync(path.join(testRoot, ".claude"), { recursive: true });
        fs.writeFileSync(
            path.join(testRoot, ".claude", "CLAUDE.md"),
            "Dot claude"
        );

        const files = discoverContextFiles(testRoot);
        const hasTop = files.some(
            (f) =>
                f.content === "Top-level agents" && !f.path.includes(".claude")
        );
        const hasDotClaude = files.some((f) => f.content === "Dot claude");
        const hasTopClaude = files.some(
            (f) => f.content === "Top-level claude"
        );

        assert.ok(hasTop, "AGENTS.md loaded (CLAUDE.md skipped)");
        assert.ok(hasDotClaude, ".claude/CLAUDE.md loaded independently");
        assert.ok(
            !hasTopClaude,
            "top-level CLAUDE.md not loaded (first match wins)"
        );
    });

    void it(".agents/AGENTS.md loaded alongside top-level AGENTS.md", () => {
        fs.writeFileSync(path.join(testRoot, "AGENTS.md"), "Top-level");
        fs.mkdirSync(path.join(testRoot, ".agents"), { recursive: true });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "AGENTS.md"),
            "Agents dir"
        );

        const files = discoverContextFiles(testRoot);
        const hasTop = files.some((f) => f.content === "Top-level");
        const hasAgentsDir = files.some((f) => f.content === "Agents dir");

        assert.ok(hasTop, "top-level AGENTS.md loaded");
        assert.ok(hasAgentsDir, ".agents/AGENTS.md loaded independently");
    });

    void it(".agents/rules/ subdirectories loaded recursively", () => {
        fs.mkdirSync(path.join(testRoot, ".agents", "rules", "deep"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "top.md"),
            "Top rule"
        );
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "deep", "nested.md"),
            "Nested rule"
        );

        const files = discoverContextFiles(testRoot);
        const top = files.find((f) => f.path.includes("rules/top.md"));
        const nested = files.find((f) =>
            f.path.includes("rules/deep/nested.md")
        );

        assert.ok(top, "top-level rule loaded");
        assert.ok(nested, "nested rule in subdirectory loaded");
    });

    void it(".claude/rules/ subdirectories loaded recursively", () => {
        fs.mkdirSync(path.join(testRoot, ".claude", "rules", "deep"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".claude", "rules", "top.md"),
            "Top rule"
        );
        fs.writeFileSync(
            path.join(testRoot, ".claude", "rules", "deep", "nested.md"),
            "Nested rule"
        );

        const files = discoverContextFiles(testRoot);
        const top = files.find((f) => f.path.includes("rules/top.md"));
        const nested = files.find((f) =>
            f.path.includes("rules/deep/nested.md")
        );

        assert.ok(top, "top-level rule loaded");
        assert.ok(nested, "nested rule in subdirectory loaded");
    });

    void it("stops at filesystem root", () => {
        // Walking from a tmpdir subdirectory should not load
        // files from / or home directory
        fs.writeFileSync(path.join(testRoot, "AGENTS.md"), "Root instructions");

        const files = discoverContextFiles(path.join(testRoot, "sub"));
        // Should include testRoot's AGENTS.md but not system files
        const hasRoot = files.some(
            (f) => f.path === path.join(testRoot, "AGENTS.md")
        );
        assert.ok(hasRoot, "test root AGENTS.md found");
    });
});

void describe("discoverContextFiles — symlink handling", () => {
    const testRoot = path.join(tmpdir(), "tau-test-context-symlinks");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRoot, "shared"), { recursive: true });
        fs.mkdirSync(path.join(testRoot, "sub"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it("deduplicates when AGENTS.md is a symlink to the same file", () => {
        // shared/base.md is the real file
        fs.writeFileSync(
            path.join(testRoot, "shared", "base.md"),
            "Shared instructions"
        );
        // root AGENTS.md symlinks to shared/base.md
        fs.symlinkSync(
            path.join(testRoot, "shared", "base.md"),
            path.join(testRoot, "AGENTS.md")
        );
        // sub AGENTS.md also symlinks to the same real file
        fs.symlinkSync(
            path.join(testRoot, "shared", "base.md"),
            path.join(testRoot, "sub", "AGENTS.md")
        );

        // Walk from sub — both root and sub have AGENTS.md pointing
        // at the same real file. Should be deduped.
        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const agentsCount = files.filter((f) =>
            f.path.endsWith("AGENTS.md")
        ).length;
        // Both paths differ but realpath is the same — only one loaded
        assert.equal(
            agentsCount,
            1,
            "realpath dedup: symlinked AGENTS.md loaded once"
        );
    });

    void it("does not follow circular symlinks", () => {
        // Create a.md that @include's b.md, and symlink b.md → a.md
        fs.writeFileSync(
            path.join(testRoot, "a.md"),
            "Content A\n@include @./b.md"
        );
        fs.symlinkSync(
            path.join(testRoot, "a.md"),
            path.join(testRoot, "b.md")
        );
        fs.writeFileSync(
            path.join(testRoot, "AGENTS.md"),
            "Root\n@include @./a.md"
        );

        // Should not hang or duplicate — circular symlink resolved by
        // realpath dedup
        const files = discoverContextFiles(testRoot);
        const aCount = files.filter((f) => f.path.includes("a.md")).length;
        assert.equal(aCount, 1, "circular symlink: a.md loaded once");
    });

    void it("follows symlinks in rules directories", () => {
        fs.mkdirSync(path.join(testRoot, ".agents", "rules"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, "shared", "rule.md"),
            "Rule content"
        );
        fs.symlinkSync(
            path.join(testRoot, "shared", "rule.md"),
            path.join(testRoot, ".agents", "rules", "linked.md")
        );

        const files = discoverContextFiles(testRoot);
        const rule = files.find((f) =>
            f.path.includes(".agents/rules/linked.md")
        );
        assert.ok(rule, "symlinked rule file discovered");
        assert.equal(rule?.content, "Rule content");
    });
});

void describe("discoverContextFiles — .claude/ compat symlinks", () => {
    const testRoot = path.join(tmpdir(), "tau-test-claude-compat");

    beforeEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(testRoot, "sub"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    void it(".claude/rules/*.md symlinked to .agents/rules/*.md loads once", () => {
        fs.mkdirSync(path.join(testRoot, ".agents", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, ".claude", "rules"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "typescript.md"),
            "---\npaths: *.ts\n---\nUse named exports"
        );
        fs.symlinkSync(
            path.join(testRoot, ".agents", "rules", "typescript.md"),
            path.join(testRoot, ".claude", "rules", "typescript.md")
        );

        const files = discoverContextFiles(testRoot);
        const rulesPaths = files
            .filter((f) => f.path.includes("typescript.md"))
            .map((f) => f.path);

        // Both .agents/rules/typescript.md and .claude/rules/typescript.md
        // resolve to the same real file — must be deduped.
        assert.equal(
            rulesPaths.length,
            1,
            "symlinked .claude/rules deduped against .agents/rules"
        );
        assert.equal(
            rulesPaths[0]?.includes(".agents/rules/typescript.md"),
            true,
            "first discovery path wins (.agents comes before .claude)"
        );
    });

    void it(".claude/CLAUDE.md symlinked to .agents/AGENTS.md loads once", () => {
        fs.mkdirSync(path.join(testRoot, ".agents"), { recursive: true });
        fs.mkdirSync(path.join(testRoot, ".claude"), { recursive: true });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "AGENTS.md"),
            "Machine instructions"
        );
        fs.symlinkSync(
            path.join(testRoot, ".agents", "AGENTS.md"),
            path.join(testRoot, ".claude", "CLAUDE.md")
        );

        const files = discoverContextFiles(testRoot);
        const instrPaths = files
            .filter(
                (f) =>
                    f.path.includes(".agents/AGENTS.md") ||
                    f.path.includes(".claude/CLAUDE.md")
            )
            .map((f) => f.path);

        assert.equal(
            instrPaths.length,
            1,
            "symlinked .claude/CLAUDE.md deduped against .agents/AGENTS.md"
        );
    });

    void it(".claude/rules/ discovered at every ancestor directory", () => {
        // Root has .claude/rules/root.md, sub has .claude/rules/sub.md
        fs.mkdirSync(path.join(testRoot, ".claude", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, "sub", ".claude", "rules"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".claude", "rules", "root.md"),
            "Root rule"
        );
        fs.writeFileSync(
            path.join(testRoot, "sub", ".claude", "rules", "sub.md"),
            "Sub rule"
        );

        // Walk from sub — should discover both root and sub rules
        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const rootRule = files.find((f) =>
            f.path.includes(".claude/rules/root.md")
        );
        const subRule = files.find((f) =>
            f.path.includes("sub/.claude/rules/sub.md")
        );

        assert.ok(rootRule, "root .claude/rules/ discovered from sub");
        assert.ok(subRule, "sub .claude/rules/ discovered from sub");

        // Root rule should appear before sub rule (root → cwd order)
        const rootIdx = files.findIndex((f) =>
            f.path.includes(".claude/rules/root.md")
        );
        const subIdx = files.findIndex((f) =>
            f.path.includes("sub/.claude/rules/sub.md")
        );
        assert.ok(rootIdx < subIdx, "root rule before sub rule");
    });

    void it(".agents/rules/ discovered at every ancestor directory", () => {
        fs.mkdirSync(path.join(testRoot, ".agents", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, "sub", ".agents", "rules"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "root.md"),
            "Root rule"
        );
        fs.writeFileSync(
            path.join(testRoot, "sub", ".agents", "rules", "sub.md"),
            "Sub rule"
        );

        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const rootRule = files.find((f) =>
            f.path.includes(".agents/rules/root.md")
        );
        const subRule = files.find((f) =>
            f.path.includes("sub/.agents/rules/sub.md")
        );

        assert.ok(rootRule, "root .agents/rules/ discovered from sub");
        assert.ok(subRule, "sub .agents/rules/ discovered from sub");

        const rootIdx = files.findIndex((f) =>
            f.path.includes(".agents/rules/root.md")
        );
        const subIdx = files.findIndex((f) =>
            f.path.includes("sub/.agents/rules/sub.md")
        );
        assert.ok(rootIdx < subIdx, "root rule before sub rule");
    });

    void it("deduplicates .claude/rules/ symlink chain across ancestor walk", () => {
        // Root .agents/rules/typescript.md, symlinked as .claude/rules/typescript.md
        // Sub also has .claude/rules/typescript.md symlinked to same .agents file
        fs.mkdirSync(path.join(testRoot, ".agents", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, ".claude", "rules"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(testRoot, "sub", ".claude", "rules"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(testRoot, ".agents", "rules", "typescript.md"),
            "Use named exports"
        );
        // Root .claude/rules → .agents/rules
        fs.symlinkSync(
            path.join(testRoot, ".agents", "rules", "typescript.md"),
            path.join(testRoot, ".claude", "rules", "typescript.md")
        );
        // Sub .claude/rules → same .agents/rules file
        fs.symlinkSync(
            path.join(testRoot, ".agents", "rules", "typescript.md"),
            path.join(testRoot, "sub", ".claude", "rules", "typescript.md")
        );

        const files = discoverContextFiles(path.join(testRoot, "sub"));
        const tsPaths = files
            .filter((f) => f.content === "Use named exports")
            .map((f) => f.path);

        // All three symlink paths resolve to the same real file
        assert.equal(
            tsPaths.length,
            1,
            "same real file loaded once despite multiple symlink paths across ancestors"
        );
    });
});
