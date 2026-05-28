/**
 * Permission modes — state management, cycling, and mode-aware behaviour.
 *
 * Modes follow Claude Code's permission model:
 *   default           — prompt for any tool not explicitly allowed
 *   acceptEdits       — auto-approve file edits + filesystem bash commands
 *   plan              — read-only exploration (restricted tool set + bash allowlist)
 *   bypassPermissions — skip default prompts (safety checks still enforced)
 *   dontAsk           — auto-deny anything that would prompt
 */

import type { PermissionMode } from "./types.js";

// ─── Mode definitions ────────────────────────────────────────────────

export const PERMISSION_MODES: PermissionMode[] = [
    "ask",
    "edit",
    "plan",
    "allow",
];

export const MODE_TITLES: Record<PermissionMode, string> = {
    ask: "Ask",
    edit: "Edit",
    plan: "Plan",
    allow: "Allow",
};

export const MODE_SHORT_TITLES: Record<PermissionMode, string> = {
    ask: "Ask",
    edit: "Edit",
    plan: "Plan",
    allow: "Allow",
};

export const MODE_SYMBOLS: Record<PermissionMode, string> = {
    ask: "🔒",
    edit: "✎",
    plan: "⏸",
    allow: "✓",
};

// ─── Mode-specific tool sets ─────────────────────────────────────────

/** Tools available in plan mode */
export const PLAN_MODE_TOOLS = [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
];

/** Tools available in normal/default mode */
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// ─── Mode cycling ────────────────────────────────────────────────────

/**
 * Get the next mode in the cycle.
 * Skips allow unless the user has opted in (stored in state).
 */
export function nextMode(
    current: PermissionMode,
    bypassEnabled: boolean
): PermissionMode {
    const available = bypassEnabled
        ? PERMISSION_MODES
        : PERMISSION_MODES.filter((m) => m !== "allow");

    const idx = available.indexOf(current);
    if (idx === -1) return "allow";
    return available[(idx + 1) % available.length];
}

// ─── Mode status display ───────────────────────────────────────────

/**
 * Get the status bar text for the current permission mode.
 * When showShortcut is true, appends the shortcut key hint.
 */
export function modeStatusText(
    mode: PermissionMode,
    showShortcut = false
): string {
    const symbol = MODE_SYMBOLS[mode];
    const title = MODE_SHORT_TITLES[mode];
    const base = symbol ? `${symbol} ${title}` : title;
    if (showShortcut) {
        return `${base} ^⇧M`;
    }
    return base;
}

/**
 * Get the colour key for the current permission mode.
 */
export function modeColour(mode: PermissionMode): PermModeColour {
    switch (mode) {
        case "ask":
            return "text";
        case "edit":
            return "warning";
        case "plan":
            return "dim";
        case "allow":
            return "error";
    }
}

/**
 * Whether allow mode is currently available
 * (not disabled by settings or policy).
 */
export function isBypassAvailable(disableBySettings: boolean): boolean {
    return !disableBySettings;
}

/**
 * Valid ThemeColor values for status bar display.
 * These are the pi theme colour names that make sense for permission modes.
 */
export type PermModeColour = "text" | "warning" | "error" | "dim";
