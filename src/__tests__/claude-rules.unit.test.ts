import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMarkdownFiles } from "../features/claude-rules.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tau-test-claude-rules");

void describe("findMarkdownFiles", () => {
    void it("returns empty array for non-existent directory", () => {
        assert.deepEqual(
            findMarkdownFiles("/nonexistent/path/that/does/not/exist"),
            []
        );
    });

    void it("finds markdown files in a flat directory", () => {
        mkdirSync(TEST_DIR, { recursive: true });
        try {
            writeFileSync(join(TEST_DIR, "rule1.md"), "rule 1");
            writeFileSync(join(TEST_DIR, "rule2.md"), "rule 2");
            writeFileSync(join(TEST_DIR, "ignore.txt"), "not md");

            const results = findMarkdownFiles(TEST_DIR);
            assert.equal(results.length, 2);
            assert.ok(results.includes("rule1.md"));
            assert.ok(results.includes("rule2.md"));
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    void it("finds markdown files in nested directories", () => {
        const nested = join(TEST_DIR, "sub", "deep");
        mkdirSync(nested, { recursive: true });
        try {
            writeFileSync(join(TEST_DIR, "top.md"), "top");
            writeFileSync(join(nested, "nested.md"), "nested");

            const results = findMarkdownFiles(TEST_DIR);
            assert.equal(results.length, 2);
            assert.ok(results.includes("top.md"));
            assert.ok(results.includes("sub/deep/nested.md"));
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    void it("uses basePath prefix for nested results", () => {
        mkdirSync(TEST_DIR, { recursive: true });
        try {
            writeFileSync(join(TEST_DIR, "test.md"), "content");
            const results = findMarkdownFiles(TEST_DIR, "prefix");
            assert.equal(results.length, 1);
            assert.equal(results[0], "prefix/test.md");
        } finally {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
});
