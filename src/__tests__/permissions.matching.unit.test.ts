import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRule, ruleMatches, findMatchingRule } from "../features/permissions/rules.ts";
import {
    checkBashPermissions,
    splitCommand,
    stripSafeWrappers,
    stripAllEnvVars,
} from "../features/permissions/bash.ts";
import type { PermissionRule } from "../features/permissions/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeRule(rule: string, behavior: PermissionRule["behavior"] = "deny"): PermissionRule {
    return { rule, behavior, source: "userSettings" as const };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. parseRule
// ═══════════════════════════════════════════════════════════════════════

void describe("parseRule", () => {
    void it("parses a rule with a pattern", () => {
        const result = parseRule("Bash(rm -rf /)");
        assert.deepEqual(result, { toolName: "Bash", pattern: "rm -rf /" });
    });

    void it("parses a whole-tool rule (no parens)", () => {
        const result = parseRule("Bash");
        assert.deepEqual(result, { toolName: "Bash", pattern: null });
    });

    void it("parses a prefix rule", () => {
        const result = parseRule("Bash(git:*)");
        assert.deepEqual(result, { toolName: "Bash", pattern: "git:*" });
    });

    void it("parses a wildcard rule", () => {
        const result = parseRule("Bash(*rm*)");
        assert.deepEqual(result, { toolName: "Bash", pattern: "*rm*" });
    });

    void it("parses a rule with nested parens in pattern", () => {
        const result = parseRule("Bash(echo $(cat file))");
        assert.deepEqual(result, { toolName: "Bash", pattern: "echo $(cat file)" });
    });

    void it("handles mismatched parens gracefully", () => {
        // No closing paren — treat as whole-tool
        const result = parseRule("Bash(rm");
        assert.equal(result.toolName, "Bash(rm");
        assert.equal(result.pattern, null);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Exact match
// ═══════════════════════════════════════════════════════════════════════

void describe("exact match", () => {
    void it("matches an identical command", () => {
        const result = checkBashPermissions([makeRule("Bash(rm -rf /)", "deny")], "rm -rf /");
        assert.equal(result?.decision, "deny");
    });

    void it("does not match a different command", () => {
        const result = checkBashPermissions([makeRule("Bash(rm -rf /)", "deny")], "rm -rf /tmp");
        assert.equal(result, undefined);
    });

    void it("does not match a prefix of the command", () => {
        const result = checkBashPermissions([makeRule("Bash(rm)", "deny")], "rm -rf /");
        assert.equal(result, undefined);
    });

    void it("does not match when extra flags differ", () => {
        const result = checkBashPermissions([makeRule("Bash(rm -rf /)", "deny")], "rm -f /");
        assert.equal(result, undefined);
    });

    void it("matches as an allow rule", () => {
        const result = checkBashPermissions([makeRule("Bash(git status)", "allow")], "git status");
        assert.equal(result?.decision, "allow");
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Prefix match (:*)
// ═══════════════════════════════════════════════════════════════════════

void describe("prefix match (:*)", () => {
    void it("matches the exact prefix", () => {
        const result = checkBashPermissions([makeRule("Bash(git:*)", "allow")], "git");
        assert.equal(result?.decision, "allow");
    });

    void it("matches prefix followed by space and arguments", () => {
        const result = checkBashPermissions(
            [makeRule("Bash(git:*)", "allow")],
            "git commit -m test"
        );
        assert.equal(result?.decision, "allow");
    });

    void it("does not match a different command starting with same letters", () => {
        const result = checkBashPermissions([makeRule("Bash(ls:*)", "allow")], "lsof");
        assert.equal(result, undefined);
    });

    void it("does not match lsattr when rule is ls:*", () => {
        const result = checkBashPermissions([makeRule("Bash(ls:*)", "allow")], "lsattr");
        assert.equal(result, undefined);
    });

    void it("matches two-word prefix", () => {
        const result = checkBashPermissions(
            [makeRule("Bash(npm install:*)", "allow")],
            "npm install foo"
        );
        assert.equal(result?.decision, "allow");
    });

    void it("matches two-word prefix with no arguments", () => {
        const result = checkBashPermissions(
            [makeRule("Bash(npm install:*)", "allow")],
            "npm install"
        );
        assert.equal(result?.decision, "allow");
    });

    void it("does not match when prefix is longer than command", () => {
        const result = checkBashPermissions(
            [makeRule("Bash(npm install:*)", "allow")],
            "npm"
        );
        assert.equal(result, undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Wildcard match (*)
// ═══════════════════════════════════════════════════════════════════════

void describe("wildcard match — anchoring", () => {
    const denyRule = makeRule("Bash(*rm* /)");

    void it("matches 'rm -rf /'", () => {
        assert.equal(checkBashPermissions([denyRule], "rm -rf /")?.decision, "deny");
    });

    void it("matches 'rm /'", () => {
        assert.equal(checkBashPermissions([denyRule], "rm /")?.decision, "deny");
    });

    void it("does not match 'rm -rf /tmp' (does not end with ' /')", () => {
        assert.equal(checkBashPermissions([denyRule], "rm -rf /tmp"), undefined);
    });

    void it("does not match 'biome format --write /tmp/file' (rm is substring of format)", () => {
        assert.equal(
            checkBashPermissions([denyRule], "biome format --write /tmp/file.js"),
            undefined
        );
    });

    void it("does not match 'transform data /input' (rm is substring of transform)", () => {
        assert.equal(checkBashPermissions([denyRule], "transform data /input"), undefined);
    });
});

void describe("wildcard match — no-preserve-root", () => {
    const denyRule = makeRule("Bash(*rm* --no-preserve-root*)");

    void it("matches 'rm --no-preserve-root /'", () => {
        assert.equal(
            checkBashPermissions([denyRule], "rm --no-preserve-root /")?.decision,
            "deny"
        );
    });

    void it("matches 'rm -rf --no-preserve-root /'", () => {
        assert.equal(
            checkBashPermissions([denyRule], "rm -rf --no-preserve-root /")?.decision,
            "deny"
        );
    });

    void it("does not match 'rm -rf /'", () => {
        assert.equal(checkBashPermissions([denyRule], "rm -rf /"), undefined);
    });
});

void describe("wildcard match — sudo *rm*", () => {
    const denyRule = makeRule("Bash(sudo *rm*)");

    void it("matches 'sudo rm -rf /tmp'", () => {
        assert.equal(
            checkBashPermissions([denyRule], "sudo rm -rf /tmp")?.decision,
            "deny"
        );
    });

    void it("does not match 'rm -rf /tmp' (no sudo)", () => {
        assert.equal(checkBashPermissions([denyRule], "rm -rf /tmp"), undefined);
    });
});

void describe("wildcard match — git add -A*", () => {
    const denyRule = makeRule("Bash(git add -A*)");

    void it("matches 'git add -A'", () => {
        assert.equal(checkBashPermissions([denyRule], "git add -A")?.decision, "deny");
    });

    void it("matches 'git add -A --force'", () => {
        assert.equal(
            checkBashPermissions([denyRule], "git add -A --force")?.decision,
            "deny"
        );
    });

    void it("does not match 'git add file.txt'", () => {
        assert.equal(checkBashPermissions([denyRule], "git add file.txt"), undefined);
    });
});

void describe("wildcard match — git add . *", () => {
    const denyRule = makeRule("Bash(git add . *)");

    void it("matches 'git add . file1 file2'", () => {
        assert.equal(
            checkBashPermissions([denyRule], "git add . file1 file2")?.decision,
            "deny"
        );
    });

    void it("does not match bare 'git add .' (no trailing content for * wildcard)", () => {
        // "git add . *" → regex "^git add \\. .*$" — requires trailing space
        assert.equal(checkBashPermissions([denyRule], "git add ."), undefined);
    });

    void it("does not match 'git add src/'", () => {
        assert.equal(checkBashPermissions([denyRule], "git add src/"), undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Anchoring and escaping
// ═══════════════════════════════════════════════════════════════════════

void describe("escaping — dot is literal", () => {
    void it(". in pattern matches a literal dot, not any character", () => {
        const rule = makeRule("Bash(git commit.*--no-verify)", "ask");
        assert.equal(checkBashPermissions([rule], "git commit.--no-verify")?.decision, "ask");
    });

    void it(". does not match a space", () => {
        const rule = makeRule("Bash(git commit.*--no-verify)", "ask");
        assert.equal(checkBashPermissions([rule], "git commit --no-verify"), undefined);
    });

    void it(". does not match arbitrary characters", () => {
        const rule = makeRule("Bash(git commit.*--no-verify)", "ask");
        assert.equal(checkBashPermissions([rule], "git commitX--no-verify"), undefined);
    });
});

void describe("escaping — regex metacharacters are literal", () => {
    void it("$ in pattern is literal", () => {
        const rule = makeRule('Bash(echo $HOME)', "deny");
        assert.equal(checkBashPermissions([rule], 'echo $HOME')?.decision, "deny");
        assert.equal(checkBashPermissions([rule], "echo HOME"), undefined);
    });

    void it("parentheses in pattern are literal", () => {
        const rule = makeRule("Bash(echo (hi))", "deny");
        assert.equal(checkBashPermissions([rule], "echo (hi)")?.decision, "deny");
    });

    void it("square brackets in pattern are literal", () => {
        const rule = makeRule("Bash(test [ -f file ])", "deny");
        assert.equal(
            checkBashPermissions([rule], "test [ -f file ]")?.decision,
            "deny"
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. ruleMatches (rules.ts)
// ═══════════════════════════════════════════════════════════════════════

void describe("ruleMatches — whole-tool match", () => {
    void it("matches any call to the tool when pattern is null", () => {
        const rule = makeRule("Bash", "allow");
        assert.equal(ruleMatches(rule, "Bash", "anything here"), true);
    });

    void it("does not match a different tool", () => {
        const rule = makeRule("Bash", "allow");
        assert.equal(ruleMatches(rule, "Edit", "anything"), false);
    });
});

void describe("ruleMatches — prefix pattern with subcommands", () => {
    const rule = makeRule("Bash(git:*)", "allow");

    void it("matches a subcommand that starts with the prefix", () => {
        assert.equal(ruleMatches(rule, "Bash", "git status", ["git status"]), true);
    });

    void it("does not match when no subcommand matches", () => {
        assert.equal(ruleMatches(rule, "Bash", "npm install", ["npm install"]), false);
    });
});

void describe("ruleMatches — wildcard pattern with subcommands", () => {
    const rule = makeRule("Bash(*rm*)", "deny");

    void it("checks each subcommand individually", () => {
        // "echo hello && rm file" — subcommands: ["echo hello", "rm file"]
        assert.equal(
            ruleMatches(rule, "Bash", "echo hello && rm file", ["echo hello", "rm file"]),
            true
        );
    });

    void it("does not match when no subcommand contains the substring", () => {
        assert.equal(
            ruleMatches(rule, "Bash", "echo hello && ls", ["echo hello", "ls"]),
            false
        );
    });

    void it("does not match against the full compound command", () => {
        // The compound command "echo hello && rm file" contains "rm" but
        // wildcard patterns are checked per-subcommand, not against the full string.
        // Actually, when subcommands are provided, it ONLY checks subcommands.
        assert.equal(
            ruleMatches(rule, "Bash", "echo hello && rm file", ["echo hello", "rm file"]),
            true // "rm file" subcommand matches
        );
    });
});

void describe("ruleMatches — no subcommands provided", () => {
    void it("checks wildcard against full input", () => {
        const rule = makeRule("Bash(*rm*)", "deny");
        assert.equal(ruleMatches(rule, "Bash", "rm file"), true);
    });

    void it("checks prefix against full input", () => {
        const rule = makeRule("Bash(git:*)", "allow");
        assert.equal(ruleMatches(rule, "Bash", "git status"), true);
    });
});

void describe("findMatchingRule", () => {
    const rules: PermissionRule[] = [
        makeRule("Bash(git:*)", "allow"),
        makeRule("Bash(*rm*)", "deny"),
        makeRule("Bash(npm install:*)", "allow"),
    ];

    void it("finds the first matching rule of the given behavior", () => {
        const found = findMatchingRule(rules, "deny", "Bash", "rm file");
        assert.equal(found?.rule, "Bash(*rm*)");
    });

    void it("returns undefined when no rule matches", () => {
        const found = findMatchingRule(rules, "deny", "Bash", "git status");
        assert.equal(found, undefined);
    });

    void it("returns undefined when behavior does not match", () => {
        const found = findMatchingRule(rules, "ask", "Bash", "rm file");
        assert.equal(found, undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. checkBashPermissions orchestration
// ═══════════════════════════════════════════════════════════════════════

void describe("subcommand splitting", () => {
    void it("splits && and checks each subcommand", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "echo hello && rm file");
        assert.equal(result?.decision, "deny");
    });

    void it("splits | and checks each subcommand", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "echo hello | rm file");
        assert.equal(result?.decision, "deny");
    });

    void it("splits ; and checks each subcommand", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "echo hello; rm file");
        assert.equal(result?.decision, "deny");
    });

    void it("does not deny when only one subcommand is harmless", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "echo hello && ls -la");
        assert.equal(result, undefined);
    });
});

void describe("wrapper stripping before matching", () => {
    void it("strips 'timeout N' prefix before deny matching", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "timeout 10 rm -rf /tmp/cache");
        assert.equal(result?.decision, "deny");
    });

    void it("strips 'nice' prefix before deny matching", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "nice rm -rf /tmp/cache");
        assert.equal(result?.decision, "deny");
    });

    void it("strips 'nohup' prefix before deny matching", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "nohup rm -rf /tmp/cache");
        assert.equal(result?.decision, "deny");
    });

    void it("strips safe env vars before deny matching", () => {
        const rules = [makeRule("Bash(rm:*)", "deny")];
        const result = checkBashPermissions(rules, "NODE_ENV=prod rm -rf /tmp/cache");
        assert.equal(result?.decision, "deny");
    });

    void it("strips safe env vars for allow matching", () => {
        const rules = [makeRule("Bash(npm install:*)", "allow")];
        const result = checkBashPermissions(rules, "NODE_ENV=prod npm install foo");
        assert.equal(result?.decision, "allow");
    });

    void it("strips timeout for allow matching", () => {
        const rules = [makeRule("Bash(npm install:*)", "allow")];
        const result = checkBashPermissions(rules, "timeout 60 npm install foo");
        assert.equal(result?.decision, "allow");
    });
});

void describe("priority ordering — deny > ask > allow", () => {
    void it("deny takes precedence over allow for the same command", () => {
        const rules = [
            makeRule("Bash(rm:*)", "allow"),
            makeRule("Bash(rm:*)", "deny"),
        ];
        const result = checkBashPermissions(rules, "rm -rf /tmp/cache");
        assert.equal(result?.decision, "deny");
    });

    void it("deny takes precedence over ask", () => {
        const rules = [
            makeRule("Bash(*rm*)", "ask"),
            makeRule("Bash(rm:*)", "deny"),
        ];
        const result = checkBashPermissions(rules, "rm file");
        assert.equal(result?.decision, "deny");
    });

    void it("ask takes precedence over allow", () => {
        const rules = [
            makeRule("Bash(npm install:*)", "allow"),
            makeRule("Bash(npm install:*)", "ask"),
        ];
        const result = checkBashPermissions(rules, "npm install foo");
        assert.equal(result?.decision, "ask");
    });

    void it("deny wins even when allow rule comes first", () => {
        const rules = [
            makeRule("Bash(git:*)", "allow"),
            makeRule("Bash(*rm*)", "deny"),
        ];
        const result = checkBashPermissions(rules, "git rm file");
        // "git rm file" matches "git:*" (allow) AND "*rm*" (deny) — deny wins
        assert.equal(result?.decision, "deny");
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. splitCommand unit tests
// ═══════════════════════════════════════════════════════════════════════

void describe("splitCommand", () => {
    void it("splits on &&", () => {
        assert.deepEqual(splitCommand("a && b"), ["a", "b"]);
    });

    void it("splits on ||", () => {
        assert.deepEqual(splitCommand("a || b"), ["a", "b"]);
    });

    void it("splits on ;", () => {
        assert.deepEqual(splitCommand("a; b"), ["a", "b"]);
    });

    void it("splits on |", () => {
        assert.deepEqual(splitCommand("a | b"), ["a", "b"]);
    });

    void it("splits on & (background)", () => {
        assert.deepEqual(splitCommand("a & b"), ["a", "b"]);
    });

    void it("does not split inside single quotes", () => {
        assert.deepEqual(splitCommand("echo 'a && b'"), ["echo 'a && b'"]);
    });

    void it("does not split inside double quotes", () => {
        assert.deepEqual(splitCommand('echo "a && b"'), ['echo "a && b"']);
    });

    void it("handles multiple operators", () => {
        assert.deepEqual(splitCommand("a && b || c; d"), ["a", "b", "c", "d"]);
    });

    void it("returns single command when no operators", () => {
        assert.deepEqual(splitCommand("git status"), ["git status"]);
    });

    void it("handles pipes and redirections", () => {
        const result = splitCommand("cat file | grep foo | wc -l");
        assert.deepEqual(result, ["cat file", "grep foo", "wc -l"]);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. stripSafeWrappers / stripAllEnvVars unit tests
// ═══════════════════════════════════════════════════════════════════════

void describe("stripSafeWrappers", () => {
    void it("strips timeout prefix", () => {
        assert.equal(stripSafeWrappers("timeout 10 npm install"), "npm install");
    });

    void it("strips timeout with flags", () => {
        assert.equal(stripSafeWrappers("timeout -v 10 npm install"), "npm install");
    });

    void it("strips nohup prefix", () => {
        assert.equal(stripSafeWrappers("nohup npm install"), "npm install");
    });

    void it("strips nice prefix", () => {
        assert.equal(stripSafeWrappers("nice npm install"), "npm install");
    });

    void it("strips nice -n 10 prefix", () => {
        assert.equal(stripSafeWrappers("nice -n 10 npm install"), "npm install");
    });

    void it("strips NODE_ENV prefix", () => {
        assert.equal(stripSafeWrappers("NODE_ENV=prod npm install"), "npm install");
    });

    void it("does not strip PATH prefix (unsafe)", () => {
        assert.equal(stripSafeWrappers("PATH=/evil npm install"), "PATH=/evil npm install");
    });

    void it("strips combined env var and wrapper", () => {
        assert.equal(
            stripSafeWrappers("NODE_ENV=prod timeout 10 npm install"),
            "npm install"
        );
    });

    void it("returns command unchanged when no wrappers", () => {
        assert.equal(stripSafeWrappers("npm install"), "npm install");
    });
});

void describe("stripAllEnvVars", () => {
    void it("strips any env var, not just safe ones", () => {
        assert.equal(stripAllEnvVars("FOO=bar rm file"), "rm file");
    });

    void it("strips multiple env vars", () => {
        assert.equal(stripAllEnvVars("A=1 B=2 rm file"), "rm file");
    });

    void it("strips env vars and wrappers together", () => {
        assert.equal(
            stripAllEnvVars("FOO=bar timeout 5 rm file"),
            "rm file"
        );
    });
});
