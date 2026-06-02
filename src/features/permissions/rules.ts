/**
 * Rule parsing and matching.
 *
 * Supports Claude Code's permission rule syntax:
 *   ToolName                  — match any call to that tool
 *   ToolName(pattern)         — match calls where the input matches the pattern
 *   ToolName(pattern *)        — wildcard at end
 *   ToolName(pattern1 pattern2) — multi-word pattern
 *
 * Matching rules:
 * - Whole-tool rules (no parens) match any call to that tool.
 * - Patterns use * as a wildcard (matches any characters including /).
 * - Prefix patterns (pattern ending with :*) match if the input starts
 *   with the prefix followed by a space or end-of-string. Word boundary
 *   enforcement prevents "ls:*" from matching "lsof".
 */

import type { ParsedRule, PermissionRule } from "./types.ts";

// ─── Rule parsing ─────────────────────────────────────────────────────

export function parseRule(rule: string): ParsedRule {
    const openParen = rule.indexOf("(");
    const closeParen = rule.lastIndexOf(")");

    if (openParen === -1 || closeParen === -1 || closeParen <= openParen) {
        return { toolName: rule, pattern: null };
    }

    return {
        toolName: rule.slice(0, openParen),
        pattern: rule.slice(openParen + 1, closeParen),
    };
}

// ─── Pattern matching ────────────────────────────────────────────────

/**
 * Match a Claude Code glob pattern against an input string.
 *
 * * is a wildcard (matches any characters including /).
 * Other regex metacharacters (including .) are escaped.
 * Anchored at both ends so "*rm* /" matches "rm -rf /"
 * but not "biome format --write /tmp/file".
 */
function matchGlob(pattern: string, input: string): boolean {
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, (char) => "\\" + char)
        .replace(/\*/g, ".*");

    const regex = new RegExp("^" + regexStr + "$");
    return regex.test(input);
}

/**
 * Match a prefix pattern (pattern ending with :*) against an input string.
 *
 * Prefix patterns match if the input starts with the prefix followed by
 * a space or is exactly the prefix. This prevents "ls:*" from matching
 * "lsof" or "lsattr".
 */
function matchPrefix(pattern: string, input: string): boolean {
    // Strip the trailing :*
    const prefix = pattern.slice(0, -2);
    if (prefix === input) return true;
    if (input.startsWith(prefix + " ")) return true;
    return false;
}

/**
 * Check if a rule matches a given tool call.
 *
 * @param rule The permission rule to check
 * @param toolName Claude Code tool name (e.g. "Bash", "Edit")
 * @param input Normalised tool input (command string or filename)
 * @param subcommands For bash: array of individual subcommands to check
 *   against prefix/wildcard patterns. If empty, only the full command
 *   is checked.
 */
export function ruleMatches(
    rule: PermissionRule,
    toolName: string,
    input: string,
    subcommands: string[] = []
): boolean {
    const parsed = parseRule(rule.rule);

    // Tool name must match
    if (parsed.toolName !== toolName) return false;

    // Whole-tool match (no pattern)
    if (parsed.pattern === null) return true;

    const pattern = parsed.pattern;

    // Prefix pattern (ends with :*)
    if (pattern.endsWith(":*")) {
        // Check against each subcommand individually, and also the full input
        for (const sub of subcommands) {
            if (matchPrefix(pattern, sub)) return true;
        }
        // Also check the full input for compound commands that weren't split
        if (matchPrefix(pattern, input)) return true;
        return false;
    }

    // Glob/wildcard pattern — check against subcommands to prevent
    // compound command bypass (e.g. "cd /path && evil" matching "cd *")
    if (subcommands.length > 0) {
        for (const sub of subcommands) {
            if (matchGlob(pattern, sub)) return true;
        }
        return false;
    }

    // Exact or glob match against full input
    return matchGlob(pattern, input);
}

/**
 * Find the first matching rule of a given behavior.
 *
 * @param rules All loaded permission rules
 * @param behavior Which behavior to look for ("allow", "deny", "ask")
 * @param toolName Claude Code tool name
 * @param input Normalised tool input
 * @param subcommands For bash: individual subcommands
 */
export function findMatchingRule(
    rules: PermissionRule[],
    behavior: "allow" | "deny" | "ask",
    toolName: string,
    input: string,
    subcommands: string[] = []
): PermissionRule | undefined {
    return rules.find(
        (r) =>
            r.behavior === behavior &&
            ruleMatches(r, toolName, input, subcommands)
    );
}
