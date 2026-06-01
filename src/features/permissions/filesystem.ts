/**
 * Filesystem permission checks for read/write/edit tools.
 *
 * Provides:
 * - Working directory scope enforcement
 * - Path safety checks (bypass-immune: .git/, .claude/, shell configs)
 * - Glob-based rule matching for file paths
 * - Permission decision logic for file tools
 */

import { resolve, relative, basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { PermissionRule } from "./types.ts";
import { findMatchingRule } from "./rules.ts";

// ─── Dangerous file paths (bypass-immune safety checks) ─────────────

/**
 * Paths that are always protected, even in allow mode.
 * These are bypass-immune — they always prompt.
 */
const DANGEROUS_PATH_PATTERNS = [
    // Git metadata
    /\.git[\\/]/i,
    /^\.git$/i,
    // Claude configuration
    /\.claude[\\/]/i,
    /^\.claude$/i,
    // IDE configs
    /\.vscode[\\/]/i,
    /\.idea[\\/]/i,
    // Shell configuration files (rc, profile, env)
    /[\\/]\.bashrc$/i,
    /[\\/]\.zshrc$/i,
    /[\\/]\.profile$/i,
    /[\\/]\.bash_profile$/i,
    /[\\/]\.zprofile$/i,
    /[\\/]\.zshenv$/i,
    /[\\/]\.bash_logout$/i,
    // SSH
    /[\\/]\.ssh[\\/]/i,
    // GPG
    /[\\/]\.gnupg[\\/]/i,
];

/**
 * Check if a file path is a dangerous/sensitive path that requires
 * explicit approval, even in allow mode.
 *
 * These correspond to Claude Code's safetyCheck bypass-immune paths.
 */
export function isDangerousFilePath(path: string): boolean {
    const normalised = resolve(path).replace(/\\/g, "/");
    return DANGEROUS_PATH_PATTERNS.some((p) => p.test(normalised));
}

// ─── Working directory scope ─────────────────────────────────────────

/**
 * Check if a path is within the working directory or any
 * additional directories.
 */
export function pathInWorkingDir(
    path: string,
    cwd: string,
    additionalDirectories: Set<string>
): boolean {
    const resolvedPath = resolvePath(path);

    for (const dir of [cwd, ...additionalDirectories]) {
        const resolvedDir = resolvePath(dir);
        const rel = relative(resolvedDir, resolvedPath);

        // Same path or inside (relative path that doesn't go up)
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
            return true;
        }
    }

    return false;
}

/**
 * Resolve a path, following symlinks on macOS.
 * Handles /var → /private/var, /tmp → /private/tmp.
 */
function resolvePath(path: string): string {
    try {
        const expanded = expandTilde(path);
        const resolved = resolve(expanded);

        // Follow symlinks where possible
        if (existsSync(resolved)) {
            try {
                return realpathSync(resolved);
            } catch {
                return resolved;
            }
        }

        // macOS symlink handling
        return resolved
            .replace(/^\/private\/var\//, "/var/")
            .replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
    } catch {
        return resolve(path);
    }
}

/**
 * Expand ~ to home directory.
 */
function expandTilde(path: string): string {
    if (path.startsWith("~/") || path === "~") {
        const home = homedir();
        return path.replace("~", home);
    }
    return path;
}

/**
 * Check if a relative path is absolute (cross-platform).
 */
function isAbsolute(path: string): boolean {
    return path.startsWith("/") || /^[A-Za-z]:/.test(path);
}

// ─── File tool permission checking ──────────────────────────────────

/**
 * Check file-read permissions against loaded rules and working directory scope.
 *
 * Decision logic:
 * 1. Deny rules → block
 * 2. Ask rules → prompt
 * 3. Edit/write access implies read access → allow
 * 4. Path inside working directory → allow (default mode)
 * 5. Allow rules → allow
 * 6. Outside working dir → ask
 */
export function checkReadPermission(
    rules: PermissionRule[],
    path: string,
    cwd: string,
    additionalDirectories: Set<string>
): {
    decision: "deny" | "ask" | "allow";
    rule?: PermissionRule;
    reason: string;
} {
    const normalisedPath = basename(resolve(path));

    // 1. Deny rules
    const denyRule = findMatchingRule(rules, "deny", "Read", normalisedPath);
    if (denyRule) {
        return {
            decision: "deny",
            rule: denyRule,
            reason: `Permission to read ${path} has been denied.`,
        };
    }

    // 2. Ask rules
    const askRule = findMatchingRule(rules, "ask", "Read", normalisedPath);
    if (askRule) {
        return {
            decision: "ask",
            rule: askRule,
            reason: `Permission rule requires approval for reading ${path}.`,
        };
    }

    // 3. Edit/write access implies read access
    const editResult = checkWritePermissionInner(
        rules,
        path,
        cwd,
        additionalDirectories,
        /* skipSafetyCheck */ true
    );
    if (editResult.decision === "allow") {
        return {
            decision: "allow",
            reason: "Edit access implies read access.",
        };
    }

    // 4. Path inside working directory — auto-allow in default mode
    if (pathInWorkingDir(path, cwd, additionalDirectories)) {
        return {
            decision: "allow",
            reason: "Path is within the working directory.",
        };
    }

    // 5. Allow rules
    const allowRule = findMatchingRule(rules, "allow", "Read", normalisedPath);
    if (allowRule) {
        return {
            decision: "allow",
            rule: allowRule,
            reason: "Read permission granted by rule.",
        };
    }

    // 6. Outside working dir — ask
    return {
        decision: "ask",
        reason: "Path is outside allowed working directories.",
    };
}

/**
 * Check file-write/edit permissions against loaded rules,
 * working directory scope, and safety checks.
 *
 * Decision logic:
 * 1. Deny rules → block
 * 2. Safety checks (.git/, .claude/, shell configs) → ask (bypass-immune)
 * 3. Ask rules → prompt
 * 4. edit mode + path in working dir → allow
 * 5. Allow rules → allow
 * 6. No match → ask
 */
export function checkWritePermission(
    rules: PermissionRule[],
    path: string,
    cwd: string,
    additionalDirectories: Set<string>,
    mode: string
): {
    decision: "deny" | "ask" | "allow";
    rule?: PermissionRule;
    reason: string;
} {
    return checkWritePermissionInner(
        rules,
        path,
        cwd,
        additionalDirectories,
        false,
        mode
    );
}

function checkWritePermissionInner(
    rules: PermissionRule[],
    path: string,
    cwd: string,
    additionalDirectories: Set<string>,
    skipSafetyCheck: boolean,
    mode?: string
): {
    decision: "deny" | "ask" | "allow";
    rule?: PermissionRule;
    reason: string;
} {
    const normalisedPath = basename(resolve(path));

    // 1. Deny rules
    const denyRule = findMatchingRule(rules, "deny", "Edit", normalisedPath);
    if (denyRule) {
        return {
            decision: "deny",
            rule: denyRule,
            reason: `Permission to edit ${path} has been denied.`,
        };
    }

    // 2. Safety checks (bypass-immune)
    if (!skipSafetyCheck && isDangerousFilePath(path)) {
        return {
            decision: "ask",
            reason: `Claude requested permissions to edit ${path} which is a sensitive file.`,
        };
    }

    // 3. Ask rules
    const askRule = findMatchingRule(rules, "ask", "Edit", normalisedPath);
    if (askRule) {
        return {
            decision: "ask",
            rule: askRule,
            reason: `Permission rule requires approval for editing ${path}.`,
        };
    }

    // 4. edit mode + path in working dir
    if (mode === "edit" && pathInWorkingDir(path, cwd, additionalDirectories)) {
        return {
            decision: "allow",
            reason: "edit mode: write allowed within working directory.",
        };
    }

    // 5. Allow rules
    const allowRule = findMatchingRule(rules, "allow", "Edit", normalisedPath);
    if (allowRule) {
        return {
            decision: "allow",
            rule: allowRule,
            reason: "Edit permission granted by rule.",
        };
    }

    // 6. No match → ask
    const isInWorkingDir = pathInWorkingDir(path, cwd, additionalDirectories);
    return {
        decision: "ask",
        reason: isInWorkingDir
            ? undefined
            : "Path is outside allowed working directories.",
    } as { decision: "deny" | "ask" | "allow"; reason: string };
}
