/**
 * Permissions feature — main registration and tool_call handler.
 *
 * Wires together:
 * - Config loading (settings.json files)
 * - Rule matching (allow/deny/ask)
 * - Bash subcommand splitting + wrapper stripping
 * - File path safety checks + working directory scope
 * - Permission modes (default, acceptEdits, plan, bypassPermissions, dontAsk)
 * - Custom permission prompt
 *
 * This is the single entry point for the permissions feature.
 * Other tau modules import from here for permission decisions.
 */

import type {
    ExtensionContext,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode, PermissionRule } from "./types.js";
import { toClaudeToolName } from "./types.js";
import {
    loadAllPermissions,
    getToolInput,
    normaliseToolInput,
} from "./config.js";
import { findMatchingRule } from "./rules.js";
import {
    checkBashPermissions,
    isSafePlanCommand,
    isAcceptEditsCommand,
} from "./bash.js";
import {
    checkReadPermission,
    checkWritePermission,
    isDangerousFilePath,
} from "./filesystem.js";
import { promptPermission } from "./prompt.js";

// ─── Permission state ────────────────────────────────────────────────

export interface PermissionState {
    mode: PermissionMode;
    rules: PermissionRule[];
    additionalDirectories: Set<string>;
    disableBypass: boolean;
    lastLoadedAt: number;
}

// Re-check settings every 60 seconds
const SETTINGS_RELOAD_INTERVAL_MS = 60_000;

// ─── Permission decision pipeline ────────────────────────────────────

/**
 * Run the full permission pipeline for a tool call.
 *
 * Order mirrors Claude Code's pipeline:
 * 1. Deny rules → block immediately
 * 2. Mode-specific restrictions (plan mode, dontAsk)
 * 3. Safety checks (bypass-immune: .git/, .claude/, shell configs)
 * 4. Mode bypass (acceptEdits, bypassPermissions skip default prompts)
 * 5. Allow rules → auto-approve
 * 6. Ask rules → prompt
 * 7. Default → ask (in default mode)
 */

/** Safely extract a string-typed path from tool call input */
function getPath(input: Record<string, unknown>): string {
    const p = input.path;
    return typeof p === "string" ? p : "";
}

export async function checkToolPermission(
    event: ToolCallEvent,
    state: PermissionState,
    cwd: string,
    ctx: ExtensionContext
): Promise<ToolCallEventResult> {
    const toolName = toClaudeToolName(event.toolName);
    const input = getToolInput(event.toolName, event.input);
    const normalised = normaliseToolInput(event.toolName, input);

    // ── 1. Deny rules (always checked first) ──────────────────────
    if (toolName === "Bash") {
        const bashResult = checkBashPermissions(state.rules, input);
        if (bashResult?.decision === "deny") {
            return {
                block: true,
                reason: `Permission denied by rule: ${bashResult.rule.rule}`,
            };
        }
        if (bashResult?.decision === "ask") {
            // Fall through to ask handling below
        }
        if (bashResult?.decision === "allow") {
            // Explicit allow rule — skip prompting
            return { block: false };
        }
    } else {
        // Non-bash deny check
        const denyRule = findMatchingRule(
            state.rules,
            "deny",
            toolName,
            normalised
        );
        if (denyRule) {
            return {
                block: true,
                reason: `Permission denied by rule: ${denyRule.rule}`,
            };
        }
    }

    // ── 2. Mode-specific restrictions ─────────────────────────────

    // Plan mode: restrict tool set and bash commands
    if (state.mode === "plan") {
        if (toolName === "Edit" || toolName === "Write") {
            return {
                block: true,
                reason: "Plan mode: write operations are disabled. Use read-only tools.",
            };
        }
        if (toolName === "Bash" && !isSafePlanCommand(input)) {
            return {
                block: true,
                reason: "Plan mode: only read-only bash commands are allowed.",
            };
        }
    }

    // ── 3. Safety checks (bypass-immune) ─────────────────────────

    if (toolName === "Edit" || toolName === "Write") {
        const path = String(getPath(event.input));
        if (isDangerousFilePath(path)) {
            // Safety checks are bypass-immune — always prompt even in bypassPermissions mode
            const decision = await promptPermission(
                ctx,
                `Allow editing sensitive file: ${path}?\n\nThis file is protected for safety and always requires approval.`,
                { showYes: true, showNo: true }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Safety check: editing ${path} was rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            return { block: false };
        }
    }

    // ── 4. Mode bypass ───────────────────────────────────────────

    // acceptEdits: auto-approve file edits and filesystem bash commands in working dir
    if (state.mode === "edit") {
        if (toolName === "Edit" || toolName === "Write") {
            // Already passed safety check above; edit mode allows within working dir
            return { block: false };
        }
        if (toolName === "Bash" && isAcceptEditsCommand(input)) {
            return { block: false };
        }
    }

    // bypassPermissions: skip default prompts (safety checks already handled above)
    if (state.mode === "allow") {
        // If we got here, no deny rule matched and safety checks passed
        // Auto-approve everything else
        if (toolName === "Bash") {
            const bashResult = checkBashPermissions(state.rules, input);
            if (bashResult?.decision === "deny") {
                // Already handled above, but defensive check
                return {
                    block: true,
                    reason: `Permission denied by rule: ${bashResult.rule.rule}`,
                };
            }
        }
        return { block: false };
    }

    // ── 5. Allow rules → auto-approve ────────────────────────────

    if (toolName === "Bash") {
        // Already checked in step 1
    } else {
        const allowRule = findMatchingRule(
            state.rules,
            "allow",
            toolName,
            normalised
        );
        if (allowRule) {
            return { block: false };
        }
    }

    // ── 6. Ask rules → prompt ────────────────────────────────────

    if (toolName === "Bash") {
        const bashResult = checkBashPermissions(state.rules, input);
        if (bashResult?.decision === "ask") {
            const decision = await promptPermission(
                ctx,
                `Allow bash command?\n\n${input}\n\nRule requires approval: ${bashResult.rule.rule}`,
                { showYes: true, showNo: true }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Bash command rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            return { block: false };
        }
    } else {
        const askRule = findMatchingRule(
            state.rules,
            "ask",
            toolName,
            normalised
        );
        if (askRule) {
            const decision = await promptPermission(
                ctx,
                `Allow ${toolName} for ${normalised || "(any)"}?\n\nRule requires approval: ${askRule.rule}`,
                { showYes: true, showNo: true }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            return { block: false };
        }
    }

    // ── 7. Default → context-dependent behaviour ─────────────────

    // For file tools, check working directory scope
    if (toolName === "Read") {
        const path = String(getPath(event.input));
        const result = checkReadPermission(
            state.rules,
            path,
            cwd,
            state.additionalDirectories
        );
        if (result.decision === "allow") return { block: false };
        if (result.decision === "deny") {
            return { block: true, reason: result.reason };
        }
        // "ask" — prompt
        const decision = await promptPermission(
            ctx,
            `Allow reading ${path}?\n\n${result.reason}`,
            { showYes: true, showNo: true }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `Read rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        return { block: false };
    }

    if (toolName === "Edit" || toolName === "Write") {
        const path = String(getPath(event.input));
        const result = checkWritePermission(
            state.rules,
            path,
            cwd,
            state.additionalDirectories,
            state.mode
        );
        if (result.decision === "allow") return { block: false };
        if (result.decision === "deny") {
            return { block: true, reason: result.reason };
        }
        // "ask" — prompt
        const decision = await promptPermission(
            ctx,
            `Allow ${toolName.toLowerCase()} for ${path}?\n\n${result.reason}`,
            { showYes: true, showNo: true }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        return { block: false };
    }

    // For bash and other tools — prompt by default in default mode
    if (state.mode === "ask") {
        if (toolName === "Bash") {
            const decision = await promptPermission(
                ctx,
                `Allow bash command?\n\n${input}`,
                { showYes: true, showNo: true }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Bash command rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            return { block: false };
        }

        // Other tools — prompt unless explicitly allowed
        const decision = await promptPermission(
            ctx,
            `Allow ${toolName}?${normalised ? ` (${normalised})` : ""}`,
            { showYes: true, showNo: true }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        return { block: false };
    }

    // Should not reach here, but default to allow for non-default modes
    return { block: false };
}

// ─── Settings reload ─────────────────────────────────────────────────

/**
 * Reload permission settings from disk if stale.
 */
export async function reloadSettingsIfNeeded(
    state: PermissionState,
    cwd: string
): Promise<PermissionState> {
    const now = Date.now();
    if (now - state.lastLoadedAt < SETTINGS_RELOAD_INTERVAL_MS) {
        return state;
    }

    const loaded = await loadAllPermissions(cwd);
    return {
        ...state,
        rules: loaded.rules,
        additionalDirectories: new Set(loaded.additionalDirectories),
        disableBypass: loaded.disableBypassPermissions,
        lastLoadedAt: now,
    };
}

/**
 * Initial load of permission settings.
 */
export async function initPermissionState(
    cwd: string
): Promise<PermissionState> {
    const loaded = await loadAllPermissions(cwd);
    return {
        mode: loaded.defaultMode ?? "ask",
        rules: loaded.rules,
        additionalDirectories: new Set(loaded.additionalDirectories),
        disableBypass: loaded.disableBypassPermissions,
        lastLoadedAt: Date.now(),
    };
}

// ─── Re-exports ──────────────────────────────────────────────────────

export { type PermissionMode, type PermissionRule } from "./types.js";
export { toClaudeToolName, fromClaudeToolName } from "./types.js";
export {
    nextMode,
    modeStatusText,
    modeColour,
    PERMISSION_MODES,
    MODE_TITLES,
    MODE_SHORT_TITLES,
} from "./modes.js";
export { splitCommand, stripSafeWrappers, isSafePlanCommand } from "./bash.js";
export { isDangerousFilePath } from "./filesystem.js";
export { promptPermission } from "./prompt.js";
