/**
 * Bash-specific permission logic: subcommand splitting, wrapper stripping,
 * and mode-specific command validation.
 *
 * Ported from Claude Code's tools/BashTool/bashPermissions.ts and
 * utils/bash/commands.ts, simplified for tau's needs.
 *
 * Key differences from Claude Code's implementation:
 * - No tree-sitter AST parsing (too heavy a dependency)
 * - Simpler heredoc handling
 * - No env-var expansion in patterns
 * - Uses shell-quote-compatible splitting for compound commands
 */

import type { PermissionRule } from "./types.ts";
import { parseRule } from "./rules.ts";

// ─── Subcommand splitting ───────────────────────────────────────────

/**
 * Split a compound bash command into individual subcommands.
 *
 * Handles: &&, ||, ;, |, & as command separators, respecting quoting
 * (single, double, backslash) and nested structures.
 *
 * Returns an array of individual command strings, stripped of their
 * connecting operators.
 *
 * This is a simplified version of Claude Code's splitCommand_DEPRECATED
 * that handles the common cases without the full shell-quote dependency.
 */
export function splitCommand(command: string): string[] {
    const result: string[] = [];
    let current = "";
    let i = 0;
    const len = command.length;

    while (i < len) {
        const char = command[i];

        // Single-quoted string — consume until closing quote
        if (char === "'") {
            const start = i;
            i++; // skip opening quote
            while (i < len && command[i] !== "'") {
                i++;
            }
            if (i < len) i++; // skip closing quote
            current += command.slice(start, i);
            continue;
        }

        // Double-quoted string — consume until closing quote, respecting escapes
        if (char === '"') {
            const start = i;
            i++; // skip opening quote
            while (i < len && command[i] !== '"') {
                if (command[i] === "\\" && i + 1 < len) {
                    i += 2; // skip escaped character
                } else {
                    i++;
                }
            }
            if (i < len) i++; // skip closing quote
            current += command.slice(start, i);
            continue;
        }

        // Backslash escape
        if (char === "\\") {
            if (i + 1 < len) {
                // Check for line continuation (backslash-newline)
                if (command[i + 1] === "\n") {
                    // Skip both backslash and newline
                    i += 2;
                    continue;
                }
                current += command.slice(i, i + 2);
                i += 2;
            } else {
                current += char;
                i++;
            }
            continue;
        }

        // Command substitution $() — track nesting depth
        if (char === "$" && i + 1 < len && command[i + 1] === "(") {
            let depth = 1;
            const start = i;
            i += 2; // skip $(
            while (i < len && depth > 0) {
                if (command[i] === "(") depth++;
                else if (command[i] === ")") depth--;
                else if (command[i] === "'") {
                    i++;
                    while (i < len && command[i] !== "'") i++;
                } else if (command[i] === '"') {
                    i++;
                    while (i < len && command[i] !== '"') {
                        if (command[i] === "\\" && i + 1 < len) i++;
                        i++;
                    }
                }
                i++;
            }
            current += command.slice(start, i);
            continue;
        }

        // Subshell ( ) — track nesting depth
        if (char === "(") {
            let depth = 1;
            const start = i;
            i++; // skip opening paren
            while (i < len && depth > 0) {
                if (command[i] === "(") depth++;
                else if (command[i] === ")") depth--;
                else if (command[i] === "'") {
                    i++;
                    while (i < len && command[i] !== "'") i++;
                } else if (command[i] === '"') {
                    i++;
                    while (i < len && command[i] !== '"') {
                        if (command[i] === "\\" && i + 1 < len) i++;
                        i++;
                    }
                }
                i++;
            }
            current += command.slice(start, i);
            continue;
        }

        // Heredoc — skip past the body
        if (char === "<" && i + 1 < len && command[i + 1] === "<") {
            const start = i;
            i += 2; // skip <<

            // Skip optional - (strip tabs) or <<-
            if (command[i] === "-") i++;

            // Skip leading whitespace before the delimiter
            while (i < len && (command[i] === " " || command[i] === "\t")) i++;

            // Read the delimiter word
            let delimiter = "";
            // Handle quoted delimiters
            if (command[i] === "'" || command[i] === '"') {
                const quoteChar = command[i];
                i++;
                while (i < len && command[i] !== quoteChar) {
                    delimiter += command[i];
                    i++;
                }
                if (i < len) i++; // skip closing quote
            } else {
                while (i < len && /[a-zA-Z0-9_]/.test(command[i])) {
                    delimiter += command[i];
                    i++;
                }
            }

            // Skip trailing whitespace on the same line
            while (i < len && command[i] !== "\n") i++;
            if (i < len) i++; // skip the newline

            // Find the end of the heredoc body (line containing just the delimiter)
            if (delimiter) {
                while (i < len) {
                    const lineStart = i;
                    // Skip to end of line
                    while (i < len && command[i] !== "\n") i++;
                    const line = command.slice(lineStart, i).trim();
                    if (line === delimiter) {
                        if (i < len) i++; // skip newline after delimiter
                        break;
                    }
                    if (i < len) i++; // skip newline
                }
            }

            current += command.slice(start, i);
            continue;
        }

        // Command separators
        if (char === "&" && i + 1 < len && command[i + 1] === "&") {
            if (current.trim()) result.push(current.trim());
            current = "";
            i += 2;
            continue;
        }
        if (char === "|" && i + 1 < len && command[i + 1] === "|") {
            if (current.trim()) result.push(current.trim());
            current = "";
            i += 2;
            continue;
        }
        if (char === ";") {
            if (current.trim()) result.push(current.trim());
            current = "";
            i++;
            continue;
        }
        if (char === "|") {
            if (current.trim()) result.push(current.trim());
            current = "";
            i++;
            continue;
        }
        if (char === "&") {
            // Single & (background operator)
            if (current.trim()) result.push(current.trim());
            current = "";
            i++;
            continue;
        }
        if (char === "\n") {
            // Newlines are command separators (unless line-continuation,
            // which is handled above)
            if (current.trim()) result.push(current.trim());
            current = "";
            i++;
            continue;
        }

        // Regular character
        current += char;
        i++;
    }

    if (current.trim()) result.push(current.trim());
    return result;
}

// ─── Wrapper stripping ───────────────────────────────────────────────

/**
 * Safe wrapper commands that prefix the real command.
 * These are stripped before permission matching so that
 * `Bash(pnpm install:*)` matches `timeout 10 pnpm install foo`.
 *
 * SECURITY: Use [ \t]+ not \s+ — \s matches \n/\r which are command
 * separators in bash. Matching across a newline would strip the wrapper
 * from one line and leave a different command on the next.
 */
const SAFE_WRAPPER_PATTERNS = [
    // timeout [--flags] <duration> <command>
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    // time [--] <command>
    /^time[ \t]+(?:--[ \t]+)?/,
    // nice [-n N] <command>
    /^nice(?:[ \t]+-n[ \t]+-?\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf -o0 -eL <command>
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    // nohup [--] <command>
    /^nohup[ \t]+(?:--[ \t]+)?/,
] as const;

/**
 * Environment variables that are safe to strip from commands before
 * permission matching. These CANNOT execute code or load libraries.
 *
 * SECURITY: PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, PYTHONPATH,
 * NODE_PATH, NODE_OPTIONS, HOME, SHELL, BASH_ENV must NEVER be added
 * here — they can change which binary runs or load arbitrary code.
 */
const SAFE_ENV_VARS = new Set([
    // Go
    "GOEXPERIMENT",
    "GOOS",
    "GOARCH",
    "CGO_ENABLED",
    "GO111MODULE",
    // Rust
    "RUST_BACKTRACE",
    "RUST_LOG",
    // Node
    "NODE_ENV",
    // Python
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    // Pytest
    "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
    "PYTEST_DEBUG",
    // API keys
    "ANTHROPIC_API_KEY",
    // Locale
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    // Terminal
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    // CI
    "CI",
]);

/**
 * Pattern for safe env var assignments at the start of a command.
 * VAR=value <command> — the assignment is genuine shell-level.
 *
 * SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
 */
const ENV_VAR_PATTERN = /^([A-Za-z_]\w*)=([A-Za-z0-9_./:-]+)[ \t]+/;

/**
 * Strip safe wrapper commands and env var prefixes from a command
 * before permission matching.
 *
 * This allows rules like `Bash(pnpm install:*)` to match
 * `NODE_ENV=prod timeout 10 pnpm install foo`.
 *
 * Deny rules need more aggressive stripping — see stripAllEnvVars.
 */
export function stripSafeWrappers(command: string): string {
    let stripped = command;
    let prev = "";

    // Phase 1: Strip safe env vars
    while (stripped !== prev) {
        prev = stripped;
        const m = stripped.match(ENV_VAR_PATTERN);
        if (m && SAFE_ENV_VARS.has(m[1])) {
            stripped = stripped.replace(ENV_VAR_PATTERN, "");
        }
    }

    // Phase 2: Strip wrapper commands
    prev = "";
    while (stripped !== prev) {
        prev = stripped;
        for (const pattern of SAFE_WRAPPER_PATTERNS) {
            stripped = stripped.replace(pattern, "");
        }
    }

    return stripped.trim();
}

/**
 * Broader env var stripping for deny/ask rule matching.
 * Strips ALL leading env var prefixes, regardless of var name,
 * so that `FOO=bar denied_command` still matches a deny rule for
 * `denied_command`. The safe-list restriction is correct for allow
 * rules, but deny rules must be harder to circumvent.
 *
 * SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only).
 */
const ALL_ENV_VAR_PATTERN =
    /^([A-Za-z_]\w*)=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/;

export function stripAllEnvVars(command: string): string {
    let stripped = command;
    let prev = "";

    while (stripped !== prev) {
        prev = stripped;
        // Also strip safe wrappers in each iteration
        stripped = stripSafeWrappers(stripped);
        const m = stripped.match(ALL_ENV_VAR_PATTERN);
        if (m) {
            stripped = stripped.slice(m[0].length);
        }
    }

    return stripped.trim();
}

// ─── Bash permission checking ───────────────────────────────────────

/**
 * Extract the base command (first word) from a command string.
 */
function getBaseCommand(command: string): string {
    const stripped = stripSafeWrappers(command);
    const tokens = stripped.trim().split(/\s+/);
    return tokens[0] ?? "";
}

/**
 * Check bash command permissions against loaded rules.
 *
 * Returns:
 * - "deny" if any deny rule matches (checked first)
 * - "ask" if any ask rule matches (checked second)
 * - "allow" if any allow rule matches (checked third)
 * - undefined if no rule matches (passthrough to default behaviour)
 *
 * @param rules All loaded permission rules
 * @param command The bash command string
 * @param cwd Current working directory
 */
export function checkBashPermissions(
    rules: PermissionRule[],
    command: string
): { decision: "deny" | "ask" | "allow"; rule: PermissionRule } | undefined {
    // Split compound commands into subcommands
    const subcommands = splitCommand(command);

    // Check each subcommand against deny rules
    // Deny rules use aggressive env var stripping
    for (const sub of subcommands) {
        const strippedForDeny = stripAllEnvVars(sub);
        const strippedForAllow = stripSafeWrappers(sub);

        // 1. Deny rules (checked first, against all subcommands)
        for (const rule of rules) {
            if (rule.behavior !== "deny") continue;
            const parsed = parseRule(rule.rule);
            if (parsed.toolName !== "Bash") continue;
            if (parsed.pattern === null) {
                // Whole-tool deny — matches any bash call
                return { decision: "deny", rule };
            }
            // Check both the stripped-for-deny version (catches env var bypass)
            // and the stripped-for-allow version (catches wrapper bypass)
            if (ruleMatchesPattern(parsed.pattern, strippedForDeny)) {
                return { decision: "deny", rule };
            }
            if (ruleMatchesPattern(parsed.pattern, strippedForAllow)) {
                return { decision: "deny", rule };
            }
        }

        // 2. Ask rules (checked second)
        for (const rule of rules) {
            if (rule.behavior !== "ask") continue;
            const parsed = parseRule(rule.rule);
            if (parsed.toolName !== "Bash") continue;
            if (parsed.pattern === null) {
                return { decision: "ask", rule };
            }
            if (ruleMatchesPattern(parsed.pattern, strippedForDeny)) {
                return { decision: "ask", rule };
            }
            if (ruleMatchesPattern(parsed.pattern, strippedForAllow)) {
                return { decision: "ask", rule };
            }
        }
    }

    // 3. Allow rules (checked third, against the full command and subcommands)
    const fullStripped = stripSafeWrappers(command);
    for (const rule of rules) {
        if (rule.behavior !== "allow") continue;
        const parsed = parseRule(rule.rule);
        if (parsed.toolName !== "Bash") continue;
        if (parsed.pattern === null) {
            return { decision: "allow", rule };
        }
        // For allow rules, only use safe stripping (not aggressive)
        if (ruleMatchesPattern(parsed.pattern, fullStripped)) {
            return { decision: "allow", rule };
        }
        // Check subcommands individually for prefix patterns
        for (const sub of subcommands) {
            const subStripped = stripSafeWrappers(sub);
            if (ruleMatchesPattern(parsed.pattern, subStripped)) {
                return { decision: "allow", rule };
            }
        }
    }

    // No rule matched
    return undefined;
}

/**
 * Match a pattern against a command string.
 * Handles prefix (:*), wildcard (*), and exact matching.
 */
function ruleMatchesPattern(pattern: string, input: string): boolean {
    // Prefix pattern (ends with :*)
    if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -2);
        if (prefix === input) return true;
        if (input.startsWith(prefix + " ")) return true;
        return false;
    }

    // Wildcard pattern — * matches any characters.
    // Treats the pattern as a partial regex where * → .* and
    // other regex metacharacters are escaped. No end anchor so
    // "git commit.*--no-verify" matches
    // "git commit --no-verify -m \"test\"".
    if (pattern.includes("*")) {
        const regexStr = pattern
            .replace(/[+^${}()|[\]\\]/g, (c) => "\\" + c)
            .replace(/\*/g, ".*");
        return new RegExp("^" + regexStr).test(input);
    }

    // Exact match
    return pattern === input;
}

// ─── Plan mode safe commands ─────────────────────────────────────────

/**
 * Destructive command patterns blocked in plan mode.
 * Matches are done against the full command string.
 */
const DESTRUCTIVE_PATTERNS = [
    /\brm\b/i,
    /\brmdir\b/i,
    /\bmv\b/i,
    /\bcp\b/i,
    /\bmkdir\b/i,
    /\btouch\b/i,
    /\bchmod\b/i,
    /\bchown\b/i,
    /\bln\b/i,
    /\btee\b/i,
    /\btruncate\b/i,
    /\bdd\b/i,
    /\bshred\b/i,
    /(^|[^<])>(?!>)/,
    />>/,
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bpip\s+(install|uninstall)/i,
    /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /\bbrew\s+(install|uninstall|upgrade)/i,
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
    /\bsudo\b/i,
    /\bsu\b/i,
    /\bkill\b/i,
    /\bpkill\b/i,
    /\bkillall\b/i,
    /\breboot\b/i,
    /\bshutdown\b/i,
    /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
    /\bservice\s+\S+\s+(start|stop|restart)/i,
    /\b(vim?|nano|emacs|code|subl)\b/i,
];

/**
 * Safe read-only commands allowed in plan mode.
 * Only these are permitted when plan mode is active.
 */
const SAFE_PATTERNS = [
    /^\s*cat\b/,
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*less\b/,
    /^\s*more\b/,
    /^\s*grep\b/,
    /^\s*find\b/,
    /^\s*ls\b/,
    /^\s*pwd\b/,
    /^\s*echo\b/,
    /^\s*printf\b/,
    /^\s*wc\b/,
    /^\s*sort\b/,
    /^\s*uniq\b/,
    /^\s*diff\b/,
    /^\s*file\b/,
    /^\s*stat\b/,
    /^\s*du\b/,
    /^\s*df\b/,
    /^\s*tree\b/,
    /^\s*which\b/,
    /^\s*whereis\b/,
    /^\s*type\b/,
    /^\s*env\b/,
    /^\s*printenv\b/,
    /^\s*uname\b/,
    /^\s*whoami\b/,
    /^\s*id\b/,
    /^\s*date\b/,
    /^\s*cal\b/,
    /^\s*uptime\b/,
    /^\s*ps\b/,
    /^\s*top\b/,
    /^\s*htop\b/,
    /^\s*free\b/,
    /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
    /^\s*git\s+ls-/i,
    /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
    /^\s*yarn\s+(list|info|why|audit)/i,
    /^\s*node\s+--version/i,
    /^\s*python\s+--version/i,
    /^\s*curl\s/i,
    /^\s*wget\s+-O\s*-/i,
    /^\s*jq\b/,
    /^\s*sed\s+-n/i,
    /^\s*awk\b/,
    /^\s*rg\b/,
    /^\s*fd\b/,
    /^\s*bat\b/,
    /^\s*eza\b/,
];

/**
 * Check whether a bash command is safe for plan mode (read-only).
 * Returns true if the command is allowed, false if it should be blocked.
 */
export function isSafePlanCommand(command: string): boolean {
    const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
    const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
    return !isDestructive && isSafe;
}

// ─── edit mode allowed commands ─────────────────────────────────────

const ACCEPT_EDITS_COMMANDS = [
    "mkdir",
    "touch",
    "rm",
    "rmdir",
    "mv",
    "cp",
    "sed",
] as const;

/**
 * Check whether a bash command is auto-allowed in edit mode.
 * Only filesystem commands within the working directory are auto-approved.
 */
export function isAcceptEditsCommand(command: string): boolean {
    const baseCmd = getBaseCommand(command);
    return ACCEPT_EDITS_COMMANDS.includes(
        baseCmd as (typeof ACCEPT_EDITS_COMMANDS)[number]
    );
}

// ─── Commands that should not be auto-backgrounded ───────────────────

const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ["sleep"];

/**
 * Check whether a command is allowed to be auto-backgrounded on timeout.
 */
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(base);
}

// ─── Read-only detection ────────────────────────────────────────────

/**
 * Check whether a bash command appears to be read-only.
 * Read-only commands are auto-allowed in default mode.
 */
export function isReadOnlyCommand(command: string): boolean {
    return isSafePlanCommand(command);
}
