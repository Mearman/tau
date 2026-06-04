/**
 * Tests for plan file management module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    slugifyTitle,
    planIdFromTitle,
    planIdFromSession,
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
    void describe("slugifyTitle", () => {
        void it("lowercases and hyphenates", () => {
            assert.equal(slugifyTitle("Refactor Auth Module"), "refactor-auth-module");
        });

        void it("strips non-alphanumeric characters", () => {
            assert.equal(slugifyTitle("Fix bug #123!!!"), "fix-bug-123");
        });

        void it("trims to 64 characters", () => {
            const long = "a".repeat(100);
            assert.equal(slugifyTitle(long).length, 64);
        });

        void it("returns empty for all-special input", () => {
            assert.equal(slugifyTitle("!!!"), "");
        });
    });

    void describe("planIdFromTitle", () => {
        void it("produces timestamp-title format", () => {
            const id = planIdFromTitle("Refactor Auth");
            assert.ok(id.includes("-refactor-auth"));
            assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(id));
        });

        void it("omits title when slug is empty", () => {
            const id = planIdFromTitle("!!!");
            assert.ok(!id.endsWith("-"));
            assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(id));
        });
    });

    void describe("planIdFromSession", () => {
        void it("produces timestamp-uuid-segment format", () => {
            const id = planIdFromSession("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
            assert.ok(id.endsWith("-a1b2c3d4"));
            assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(id));
        });
    });

    void describe("getPlansDir", () => {
        void it("returns plans/ under the session dir", () => {
            const dir = getPlansDir("/session/dir");
            assert.equal(dir, "/session/dir/plans");
        });
    });

    void describe("getPlanFilePath", () => {
        void it("returns plans/{planId}.md under session dir", () => {
            const filePath = getPlanFilePath("/session/dir", "2026-06-04T12-00-00-refactor");
            assert.equal(filePath, "/session/dir/plans/2026-06-04T12-00-00-refactor.md");
        });
    });

    void describe("ensurePlansDir", () => {
        void it("creates the directory if it doesn't exist", () => {
            const tmp = mkdtempSync(join(tmpdir(), "tau-plan-test-"));
            try {
                const dir = ensurePlansDir(tmp);
                assert.ok(dir.endsWith("/plans"));
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
                createPlanFile(tmp, "2026-06-04T12-00-00-test", "Test Plan");
                const content = readPlanFile(tmp, "2026-06-04T12-00-00-test");
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
                createPlanFile(tmp, "2026-06-04T12-00-00-test", "First");
                writePlanFile(tmp, "2026-06-04T12-00-00-test", "Custom content");
                createPlanFile(tmp, "2026-06-04T12-00-00-test", "Second");
                const content = readPlanFile(tmp, "2026-06-04T12-00-00-test");
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
                writePlanFile(tmp, "2026-06-04T12-00-00-test", "# My Plan\n\nContent here.");
                const content = readPlanFile(tmp, "2026-06-04T12-00-00-test");
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
                    "/session/dir/plans/2026-06-04T12-00-00-test.md",
                    "/session/dir",
                    "2026-06-04T12-00-00-test"
                )
            );
        });

        void it("returns false for different plan ID", () => {
            assert.ok(
                !isPlanFilePath(
                    "/session/dir/plans/other.md",
                    "/session/dir",
                    "2026-06-04T12-00-00-test"
                )
            );
        });

        void it("returns false for different session dir", () => {
            assert.ok(
                !isPlanFilePath(
                    "/other/dir/plans/2026-06-04T12-00-00-test.md",
                    "/session/dir",
                    "2026-06-04T12-00-00-test"
                )
            );
        });
    });

    void describe("isInPlansDir", () => {
        void it("returns true for any file in plans directory", () => {
            assert.ok(
                isInPlansDir("/session/dir/plans/anything.md", "/session/dir")
            );
        });

        void it("returns false for file outside plans directory", () => {
            assert.ok(!isInPlansDir("/session/dir/src/foo.ts", "/session/dir"));
        });
    });
});
