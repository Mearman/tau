import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermissions } from "../features/permissions/bash.ts";

void describe("bash permission pattern matching — git commit.*--no-verify", () => {
    const rules = [
        {
            rule: "Bash(git commit.*--no-verify)",
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

    void it("does not match 'git commit -m \"test\"'", () => {
        const result = checkBashPermissions(rules, 'git commit -m "test"');
        assert.equal(result, undefined);
    });
});
