import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermissions } from "../features/permissions/bash.ts";

void describe("wildcard deny rules — no false positives on substring match", () => {
    const denyRmRoot = [
        {
            rule: "Bash(*rm* /)",
            behavior: "deny" as const,
            source: "userSettings" as const,
        },
    ];

    void it("does not match 'biome format --write /tmp/file.js' (rm is a substring of format)", () => {
        const result = checkBashPermissions(
            denyRmRoot,
            "biome format --write /tmp/file.js"
        );
        assert.equal(result, undefined);
    });

    void it("matches 'rm -rf /'", () => {
        const result = checkBashPermissions(denyRmRoot, "rm -rf /");
        assert.equal(result?.decision, "deny");
    });
});

void describe("bash permission pattern matching — git commit.*--no-verify", () => {
    const rules = [
        {
            // . is literal — this matches "git commit.--no-verify", not
            // "git commit --no-verify" (space).
            rule: "Bash(git commit.*--no-verify)",
            behavior: "ask" as const,
            source: "userSettings" as const,
        },
    ];

    void it("matches 'git commit.--no-verify' (literal dot)", () => {
        const result = checkBashPermissions(
            rules,
            "git commit.--no-verify"
        );
        assert.equal(result?.decision, "ask");
    });

    void it("does not match 'git commit --no-verify' (space, not dot)", () => {
        const result = checkBashPermissions(
            rules,
            "git commit --no-verify"
        );
        assert.equal(result, undefined);
    });

    void it("does not match 'git commit -m \"test\"'", () => {
        const result = checkBashPermissions(rules, 'git commit -m "test"');
        assert.equal(result, undefined);
    });
});

void describe("bash permission pattern matching — git commit *--no-verify*", () => {
    const rules = [
        {
            rule: "Bash(git commit *--no-verify*)",
            behavior: "ask" as const,
            source: "userSettings" as const,
        },
    ];

    void it("matches 'git commit --no-verify -m \"test\"'", () => {
        const result = checkBashPermissions(
            rules,
            'git commit --no-verify -m "test"'
        );
        assert.equal(result?.decision, "ask");
    });

    void it("matches 'git commit --no-verify'", () => {
        const result = checkBashPermissions(
            rules,
            "git commit --no-verify"
        );
        assert.equal(result?.decision, "ask");
    });

    void it("does not match 'git commit -m \"test\"'", () => {
        const result = checkBashPermissions(rules, 'git commit -m "test"');
        assert.equal(result, undefined);
    });
});
