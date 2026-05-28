/**
 * Tests for plan file management module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    sessionSlug,
    getPlansDir,
    getPlanFilePath,
    ensurePlansDir,
    createPlanFile,
    readPlanFile,
    writePlanFile,
    isPlanFilePath,
    isInPlansDir,
} from "../features/plan-file.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

void describe("plan-file", () => {
    void describe("sessionSlug", () => {
        void it("extracts first UUID segment", () => {
            assert.equal(
                sessionSlug("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
                "a1b2c3d4"
            );
        });

        void it("falls back to first 8 chars for non-UUID input", () => {
            assert.equal(sessionSlug("short"), "short");
        });
    });

    void describe("getPlansDir", () => {
        void it("returns .pi/plans under cwd", () => {
            const dir = getPlansDir("/project");
            assert.ok(dir.endsWith(".pi/plans"));
            assert.ok(dir.startsWith("/project"));
        });
    });

    void describe("getPlanFilePath", () => {
        void it("returns .pi/plans/<slug>.md under cwd", () => {
            const filePath = getPlanFilePath("/project", "abc123");
            assert.equal(filePath, "/project/.pi/plans/abc123.md");
        });
    });

    void describe("ensurePlansDir", () => {
        void it("creates the directory if it doesn't exist", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                const dir = ensurePlansDir(tmp);
                assert.ok(dir.endsWith(".pi/plans"));
                assert.ok(existsSync(dir));
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });

        void it("does not fail if directory already exists", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                ensurePlansDir(tmp);
                ensurePlansDir(tmp);
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    });

    void describe("createPlanFile", () => {
        void it("creates a plan file with template", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                createPlanFile(tmp, "abc123", "Test Plan");
                const content = readPlanFile(tmp, "abc123");
                assert.ok(content);
                assert.ok(content.includes("# Test Plan"));
                assert.ok(content.includes("## Context"));
                assert.ok(content.includes("## Approach"));
                assert.ok(content.includes("## Files"));
                assert.ok(content.includes("## Verification"));
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });

        void it("does not overwrite existing plan file", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                createPlanFile(tmp, "abc123", "First");
                writePlanFile(tmp, "abc123", "Custom content");
                createPlanFile(tmp, "abc123", "Second");
                const content = readPlanFile(tmp, "abc123");
                assert.equal(content, "Custom content");
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    });

    void describe("readPlanFile", () => {
        void it("returns undefined for non-existent file", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                assert.equal(readPlanFile(tmp, "nonexistent"), undefined);
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    });

    void describe("writePlanFile", () => {
        void it("writes content to the plan file", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                writePlanFile(tmp, "abc123", "# My Plan\n\nContent here.");
                const content = readPlanFile(tmp, "abc123");
                assert.equal(content, "# My Plan\n\nContent here.");
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    });

    void describe("isPlanFilePath", () => {
        void it("returns true for exact match", () => {
            assert.ok(
                isPlanFilePath(
                    "/project/.pi/plans/abc123.md",
                    "/project",
                    "abc123"
                )
            );
        });

        void it("returns false for different slug", () => {
            assert.ok(
                !isPlanFilePath(
                    "/project/.pi/plans/other.md",
                    "/project",
                    "abc123"
                )
            );
        });

        void it("returns false for different directory", () => {
            assert.ok(
                !isPlanFilePath(
                    "/other/.pi/plans/abc123.md",
                    "/project",
                    "abc123"
                )
            );
        });
    });

    void describe("isInPlansDir", () => {
        void it("returns true for any file in plans directory", () => {
            assert.ok(
                isInPlansDir("/project/.pi/plans/anything.md", "/project")
            );
        });

        void it("returns false for file outside plans directory", () => {
            assert.ok(!isInPlansDir("/project/src/foo.ts", "/project"));
        });
    });
});
