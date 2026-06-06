/**
 * Permission system types for tau.
 *
 * Modeled after Claude Code's permission model, using the same rule syntax
 * so that `.claude/settings.json` files are a single source of truth across
 * both harnesses.
 */

// ─── Permission modes ────────────────────────────────────────────────

export type PermissionMode = "ask" | "edit" | "plan" | "allow" | "dontAsk";

// ─── Rule types ───────────────────────────────────────────────────────

export type RuleBehavior = "allow" | "deny" | "ask";

export type RuleSource =
    | "userSettings"
    | "projectSettings"
    | "localSettings"
    | "session";

export interface PermissionRule {
    /** Raw rule string, e.g. "Bash(git commit:*)" */
    rule: string;
    behavior: RuleBehavior;
    source: RuleSource;
}

export interface ParsedRule {
    /** Tool name, e.g. "Bash", "Edit", "Read", "Write" */
    toolName: string;
    /** Content pattern (the part in parens), or null for whole-tool matches */
    pattern: string | null;
}

// ─── Settings file schema ────────────────────────────────────────────

export interface PermissionSettings {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string; // Accepts both tau names and Claude Code names
    additionalDirectories?: string[];
    disableBypassPermissionsMode?: "disable";
}

export interface SettingsFile {
    permissions?: PermissionSettings;
}

// ─── Permission decision ─────────────────────────────────────────────

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionCheckResult {
    decision: PermissionDecision;
    /** The rule that determined the outcome, if any */
    rule?: PermissionRule;
    /** Human-readable reason for the decision */
    reason: string;
}

// ─── Permission updates (allow destinations) ──────────────────────────

export type PermissionUpdateDestination =
    | "session"
    | "localSettings"
    | "projectSettings"
    | "userSettings";

export interface PermissionUpdate {
    /** The rule to persist, e.g. "Bash(git commit:*)" */
    rule: string;
    /** Always "allow" for approval persistence */
    behavior: "allow";
    /** Where to persist the rule */
    destination: PermissionUpdateDestination;
}

// ─── Tool name mapping ───────────────────────────────────────────────

/** Map pi tool names to Claude Code convention for rule matching */
export function toClaudeToolName(toolName: string): string {
    switch (toolName) {
        case "bash":
            return "Bash";
        case "read":
            return "Read";
        case "write":
            return "Write";
        case "edit":
            return "Edit";
        case "grep":
            return "Grep";
        case "glob":
        case "find":
            return "Glob";
        default:
            return toolName;
    }
}

/** Map Claude Code tool names back to pi convention */
export function fromClaudeToolName(name: string): string {
    switch (name) {
        case "Bash":
            return "bash";
        case "Read":
            return "read";
        case "Write":
            return "write";
        case "Edit":
            return "edit";
        case "Grep":
            return "grep";
        case "Glob":
            return "glob";
        default:
            return name;
    }
}
