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
import type { PermissionMode, PermissionRule } from "./types.ts";
import { toClaudeToolName } from "./types.ts";
import {
    loadAllPermissions,
    getToolInput,
    normaliseToolInput,
    writeRuleToSettings,
} from "./config.ts";
import { findMatchingRule } from "./rules.ts";
import {
    checkBashPermissions,
    isSafePlanCommand,
    isAcceptEditsCommand,
} from "./bash.ts";
import {
    checkReadPermission,
    checkWritePermission,
    isDangerousFilePath,
} from "./filesystem.ts";
import { promptPermission } from "./prompt.ts";
import { isPlanFilePath } from "../plan-file.ts";
import { basename, resolve } from "node:path";

// ─── Permission state ────────────────────────────────────────────────

export interface PermissionState {
    mode: PermissionMode;
    rules: PermissionRule[];
    additionalDirectories: Set<string>;
    disableBypass: boolean;
    lastLoadedAt: number;
    sessionRules: string[];
    /** Active plan file slug, if in plan mode. Used to allow writes to plan file. */
    planSlug?: string;
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

/**
 * Build a permission rule string from a tool call event.
 * e.g. toolName="Bash", input="git commit -m \"foo\"" → "Bash(git:*)"
 * e.g. toolName="Edit", path="src/foo.ts" → "Edit(foo.ts)"
 */
function ruleForToolCall(
    toolName: string, // Claude Code convention
    input: Record<string, unknown>
): string {
    switch (toolName) {
        case "Bash": {
            const cmd = typeof input.command === "string" ? input.command : "";
            if (!cmd) return "Bash";
            // Extract base command for prefix rule
            const base = cmd.trim().split(/\s+/)[0] ?? "";
            return base ? `Bash(${base}:*)` : "Bash";
        }
        case "Read":
        case "Edit":
        case "Write": {
            const p = getPath(input);
            if (!p) return toolName;
            return `${toolName}(${basename(resolve(p))})`;
        }
        default:
            return toolName;
    }
}

/**
 * Handle a permission decision's destination — persist the rule if needed.
 */
async function handleDecisionDestination(
    decision: {
        approved: boolean;
        feedback: string;
        destination?: import("./types.ts").PermissionUpdateDestination;
        rule?: string;
    },
    state: PermissionState,
    cwd: string
): Promise<PermissionState> {
    if (!decision.approved || !decision.destination || !decision.rule) {
        return state;
    }

    if (decision.destination === "session") {
        // Add to in-memory session rules
        if (!state.sessionRules.includes(decision.rule)) {
            return {
                ...state,
                sessionRules: [...state.sessionRules, decision.rule],
                rules: [
                    ...state.rules,
                    {
                        rule: decision.rule,
                        behavior: "allow",
                        source: "session",
                    },
                ],
            };
        }
        return state;
    }

    // Write to the appropriate settings file
    const written = writeRuleToSettings(
        decision.rule,
        decision.destination,
        cwd
    );

    if (written) {
        // Reload to pick up the new rule
        return reloadSettingsIfNeeded(state, cwd);
    }

    return state;
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
    // Exception: writes to the plan file are allowed
    if (state.mode === "plan") {
        if (toolName === "Edit" || toolName === "Write") {
            const path = String(getPath(event.input));
            if (state.planSlug && isPlanFilePath(path, cwd, state.planSlug)) {
                // Allow writes to the plan file
                return { block: false };
            }
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
                { rule: `Edit(${basename(resolve(path))})` }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Safety check: editing ${path} was rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            // Persist if user chose a destination
            await handleDecisionDestination(decision, state, cwd);
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
    // but ask rules still require explicit approval even in allow mode.
    if (state.mode === "allow") {
        if (toolName === "Bash") {
            const bashResult = checkBashPermissions(state.rules, input);
            if (bashResult?.decision === "deny") {
                return {
                    block: true,
                    reason: `Permission denied by rule: ${bashResult.rule.rule}`,
                };
            }
            if (bashResult?.decision === "ask") {
                const decision = await promptPermission(
                    ctx,
                    `Allow bash command?\n\n${input}\n\nRule requires approval: ${bashResult.rule.rule}`,
                    { rule: bashResult.rule.rule }
                );
                if (!decision.approved) {
                    return {
                        block: true,
                        reason: `Bash command rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                    };
                }
                await handleDecisionDestination(decision, state, cwd);
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
                    { rule: askRule.rule }
                );
                if (!decision.approved) {
                    return {
                        block: true,
                        reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                    };
                }
                await handleDecisionDestination(decision, state, cwd);
                return { block: false };
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
                { rule: bashResult.rule.rule }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Bash command rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            await handleDecisionDestination(decision, state, cwd);
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
                { rule: askRule.rule }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            await handleDecisionDestination(decision, state, cwd);
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
            { rule: `Read(${basename(resolve(path))})` }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `Read rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        await handleDecisionDestination(decision, state, cwd);
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
            { rule: `${toolName}(${basename(resolve(path))})` }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        await handleDecisionDestination(decision, state, cwd);
        return { block: false };
    }

    // For bash and other tools — prompt by default in default mode
    if (state.mode === "ask") {
        if (toolName === "Bash") {
            const decision = await promptPermission(
                ctx,
                `Allow bash command?\n\n${input}`,
                {
                    rule: ruleForToolCall(toolName, event.input),
                }
            );
            if (!decision.approved) {
                return {
                    block: true,
                    reason: `Bash command rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
                };
            }
            await handleDecisionDestination(decision, state, cwd);
            return { block: false };
        }

        // Other tools — prompt unless explicitly allowed
        const decision = await promptPermission(
            ctx,
            `Allow ${toolName}?${normalised ? ` (${normalised})` : ""}`,
            { rule: toolName }
        );
        if (!decision.approved) {
            return {
                block: true,
                reason: `${toolName} rejected.${decision.feedback ? " Feedback: " + decision.feedback : ""}`,
            };
        }
        await handleDecisionDestination(decision, state, cwd);
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
        sessionRules: state.sessionRules, // preserved across reloads
        planSlug: state.planSlug, // preserved across reloads
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
        mode: loaded.defaultMode ?? "allow",
        rules: loaded.rules,
        additionalDirectories: new Set(loaded.additionalDirectories),
        disableBypass: loaded.disableBypassPermissions,
        lastLoadedAt: Date.now(),
        sessionRules: [],
    };
}

// ─── Re-exports ──────────────────────────────────────────────────────

export { type PermissionMode, type PermissionRule } from "./types.ts";
export { toClaudeToolName, fromClaudeToolName } from "./types.ts";
export {
    nextMode,
    modeStatusText,
    modeColour,
    PERMISSION_MODES,
    MODE_TITLES,
    MODE_SHORT_TITLES,
} from "./modes.ts";
export { splitCommand, stripSafeWrappers, isSafePlanCommand } from "./bash.ts";
export { isDangerousFilePath } from "./filesystem.ts";
export { promptPermission } from "./prompt.ts";
