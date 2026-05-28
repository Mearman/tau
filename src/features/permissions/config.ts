/**
 * Permission settings loading from .claude/settings.json files.
 *
 * Reads from the same files Claude Code uses, providing a single source of
 * truth for permission rules across both harnesses.
 *
 * Load order (later files override earlier):
 *   1. ~/.claude/settings.json          — user settings (global)
 *   2. .claude/settings.json            — project settings (committed, shared)
 *   3. .claude/settings.local.json     — local settings (gitignored, personal)
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type {
    PermissionMode,
    PermissionSettings,
    PermissionRule,
    RuleSource,
    SettingsFile,
} from "./types.js";

// ─── Settings file paths ────────────────────────────────────────────

/** Map Claude Code mode names to tau permission mode names */
function mapMode(mode: string): PermissionMode {
    switch (mode) {
        case "default":
            return "ask";
        case "acceptEdits":
            return "edit";
        case "plan":
            return "plan";
        case "bypassPermissions":
            return "allow";
        default:
            // Accept tau names directly too
            if (
                mode === "ask" ||
                mode === "edit" ||
                mode === "plan" ||
                mode === "allow"
            ) {
                return mode;
            }
            return "ask";
    }
}

function userSettingsPath(): string {
    return join(homedir(), ".claude", "settings.json");
}

function projectSettingsPath(cwd: string): string {
    return join(cwd, ".claude", "settings.json");
}

function localSettingsPath(cwd: string): string {
    return join(cwd, ".claude", "settings.local.json");
}

// ─── File parsing ────────────────────────────────────────────────────

function parseSettingsFile(raw: string): PermissionSettings | null {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof json !== "object" || json === null || !("permissions" in json))
        return null;
    const perms = (json as SettingsFile).permissions;
    if (typeof perms !== "object" || perms === null) return null;

    return {
        allow: Array.isArray(perms.allow) ? perms.allow : [],
        deny: Array.isArray(perms.deny) ? perms.deny : [],
        ask: Array.isArray(perms.ask) ? perms.ask : [],
        defaultMode:
            typeof perms.defaultMode === "string"
                ? perms.defaultMode
                : undefined,
        additionalDirectories: Array.isArray(perms.additionalDirectories)
            ? perms.additionalDirectories
            : [],
        disableBypassPermissionsMode: perms.disableBypassPermissionsMode,
    };
}

async function loadFile(path: string): Promise<PermissionSettings | null> {
    try {
        const resolved = resolve(path);
        if (!existsSync(resolved)) return null;
        const raw = await readFile(resolved, "utf8");
        return parseSettingsFile(raw);
    } catch {
        return null;
    }
}

// ─── Public API ──────────────────────────────────────────────────────

export interface LoadedPermissions {
    rules: PermissionRule[];
    defaultMode: PermissionMode | undefined;
    additionalDirectories: string[];
    disableBypassPermissions: boolean;
}

export async function loadAllPermissions(
    cwd: string
): Promise<LoadedPermissions> {
    const rules: PermissionRule[] = [];
    let defaultMode: PermissionMode | undefined = undefined;
    let additionalDirectories: string[] = [];
    let disableBypass = false;

    // Load order: user → project → local (later overrides earlier)
    const sources: { path: string; source: RuleSource }[] = [
        { path: userSettingsPath(), source: "userSettings" },
        { path: projectSettingsPath(cwd), source: "projectSettings" },
        { path: localSettingsPath(cwd), source: "localSettings" },
    ];

    for (const { path, source } of sources) {
        const settings = await loadFile(path);
        if (settings === null) continue;

        for (const rule of settings.allow ?? []) {
            rules.push({ rule, behavior: "allow", source });
        }
        for (const rule of settings.deny ?? []) {
            rules.push({ rule, behavior: "deny", source });
        }
        for (const rule of settings.ask ?? []) {
            rules.push({ rule, behavior: "ask", source });
        }

        // Later files override earlier for mode and directories
        if (settings.defaultMode !== undefined) {
            defaultMode = mapMode(settings.defaultMode);
        }
        if (settings.additionalDirectories) {
            additionalDirectories = [
                ...additionalDirectories,
                ...settings.additionalDirectories,
            ];
        }
        if (settings.disableBypassPermissionsMode === "disable") {
            disableBypass = true;
        }
    }

    return {
        rules,
        defaultMode,
        additionalDirectories,
        disableBypassPermissions: disableBypass,
    };
}

/**
 * Extract the input string from a tool call event for rule matching.
 *
 * For bash: the command string.
 * For file tools (read/write/edit): the file path (basename only,
 * matching Claude Code's convention).
 * For other tools: empty string (only whole-tool matching works).
 */
export function getToolInput(
    toolName: string,
    input: Record<string, unknown>
): string {
    switch (toolName) {
        case "bash":
        case "Bash":
            return (input.command as string) ?? "";
        case "read":
        case "Read":
        case "write":
        case "Write":
        case "edit":
        case "Edit":
            return basename(typeof input.path === "string" ? input.path : "");
        default:
            return "";
    }
}

/**
 * Normalise a file tool input for rule matching.
 *
 * Claude Code's permission rules for file tools match against the filename,
 * not the full path. This means `Edit(eslint.config.ts)` matches any edit
 * to that filename regardless of path.
 *
 * For bash rules, the input is returned as-is.
 */
export function normaliseToolInput(toolName: string, rawInput: string): string {
    if (toolName === "bash" || toolName === "Bash") return rawInput;
    // Strip leading ./ and use basename for file tools
    const stripped = rawInput.replace(/^\.\/+/, "");
    return basename(stripped);
}
