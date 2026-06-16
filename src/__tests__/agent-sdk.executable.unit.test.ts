/**
 * Unit tests for the Claude Code executable candidate resolution.
 * Only the pure candidate-listing is tested; the live resolver touches the
 * filesystem and the installed optional dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    claudeCodeExecutableCandidates,
    CLAUDE_CODE_EXECUTABLE_ENV,
} from "../features/agent-sdk/executable.ts";

void describe("claudeCodeExecutableCandidates", () => {
    void it("lists musl before glibc on linux", () => {
        const candidates = claudeCodeExecutableCandidates("linux", "arm64");
        assert.equal(candidates.length, 2);
        assert.ok(candidates[0].includes("-musl/"));
        assert.ok(candidates[1].includes("-arm64/claude"));
        assert.ok(!candidates[1].includes("-musl"));
        // No .exe on linux.
        assert.ok(!candidates[0].endsWith(".exe"));
    });

    void it("appends .exe on win32", () => {
        const candidates = claudeCodeExecutableCandidates("win32", "x64");
        assert.equal(candidates.length, 1);
        assert.ok(candidates[0].endsWith(".exe"));
        assert.ok(candidates[0].includes("win32-x64"));
    });

    void it("returns a single glibc-free candidate on darwin", () => {
        const candidates = claudeCodeExecutableCandidates("darwin", "arm64");
        assert.equal(candidates.length, 1);
        assert.ok(candidates[0].includes("darwin-arm64/claude"));
        assert.ok(!candidates[0].endsWith(".exe"));
    });

    void it("threads arch through for every platform", () => {
        for (const arch of ["arm64", "x64"]) {
            const c = claudeCodeExecutableCandidates("darwin", arch);
            assert.ok(c[0].includes(`darwin-${arch}`));
        }
    });
});

void describe("CLAUDE_CODE_EXECUTABLE_ENV", () => {
    void it("names the documented override variable", () => {
        assert.equal(CLAUDE_CODE_EXECUTABLE_ENV, "CLAUDE_CODE_EXECUTABLE");
    });
});
