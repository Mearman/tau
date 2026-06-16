/**
 * Named constants for the Claude Agent SDK provider.
 *
 * Every literal here is derived from a real constraint (an SDK contract, an
 * Anthropic API limit, or a Claude Code tool name) or carries a comment
 * explaining why it has that value. No magic numbers.
 */

import type { Api } from "@earendil-works/pi-ai";

/**
 * Provider id registered with pi. Used as the namespace under /model
 * (e.g. `claude-agent-sdk/claude-opus-4-7`) and as Model.provider on the
 * AssistantMessages this provider emits.
 */
export const PROVIDER_ID = "claude-agent-sdk";

/**
 * pi-ai API type advertised for the provider.
 *
 * Deliberately the recognised `"anthropic-messages"` rather than an invented
 * `"claude-agent-sdk"`: pi-ai's feature detection (e.g. `supportsXhigh()`)
 * keys off this value, so an unrecognised api would silently strip features
 * like xhigh thinking from the TUI. The SDK's transport is irrelevant to
 * pi-ai; only the event shapes matter, and they are raw Anthropic SSE.
 */
export const PROVIDER_API: Api = "anthropic-messages";

/** Human-readable name shown for the provider in pi's model picker. */
export const PROVIDER_DISPLAY_NAME = "Claude (Agent SDK)";

/**
 * Mapping from pi built-in tool names to the Claude Code tool names the SDK
 * exposes them as. The model is trained on Claude Code's tool names and
 * schemas, so routing the six shared primitives through the built-ins lets it
 * reuse that knowledge instead of re-learning custom MCP stubs.
 *
 * Source for the Claude Code names: the canonical tool list in pi-ai's own
 * anthropic provider (stealth mode mirrors Claude Code exactly).
 */
export const PI_TO_SDK_TOOL_NAME: Readonly<Record<string, string>> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Bash",
    grep: "Grep",
    find: "Glob",
    glob: "Glob",
};

/** Inverse of {@link PI_TO_SDK_TOOL_NAME}: Claude Code name -> pi name. */
export const SDK_TO_PI_TOOL_NAME: Readonly<Record<string, string>> = {
    read: "read",
    write: "write",
    edit: "edit",
    bash: "bash",
    grep: "grep",
    glob: "find",
};

/** pi tool names that have a Claude Code built-in equivalent. */
export const BUILTIN_PI_TOOL_NAMES: ReadonlySet<string> = new Set(
    Object.keys(PI_TO_SDK_TOOL_NAME)
);

/**
 * Claude Code built-in tools to keep in `Options.tools` even when pi's active
 * tool set is empty, so the model can always name the core primitives.
 */
export const DEFAULT_SDK_TOOLS: readonly string[] = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
];

/**
 * Message returned to the SDK when it tries to execute a tool itself. The SDK
 * is run in `permissionMode: "dontAsk"` with a `canUseTool` that always denies,
 * so tool_use blocks stream out for pi to execute natively; this string is
 * only the denial reason the SDK records.
 */
export const TOOL_EXECUTION_DENIED_MESSAGE =
    "Tool execution is delegated to the host agent; the SDK must not run tools.";

/** Name of the in-process MCP server that surfaces pi's non-builtin tools. */
export const MCP_SERVER_NAME = "custom-tools";

/** Prefix the SDK gives tools exposed by {@link MCP_SERVER_NAME}. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// ── Thinking budgets (legacy, budget-based models only) ────────────────
//
// Adaptive-thinking models (Opus 4.6+, Sonnet 4.6, Opus 4.7/4.8, Fable 5) are
// driven by `effort`, not a token budget, so these only apply to the older
// reasoning models (3.7 Sonnet, Haiku 4.5, Opus 4.0/4.1/4.5, Sonnet 4.0/4.5).

/**
 * Anthropic's minimum `budget_tokens` for budget-based extended thinking.
 * Values below this are rejected by the API.
 */
export const MIN_THINKING_BUDGET = 1024;

/**
 * Anthropic's historical per-request thinking-budget envelope for budget-based
 * models: `budget_tokens` must be strictly less than 32000. We use one under
 * the cap as the ceiling for the deepest legacy level.
 *
 * See https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
export const MAX_LEGACY_THINKING_BUDGET = 31999;

/**
 * Token budgets per pi thinking level for legacy (budget-based) models.
 * `high`/`xhigh` are clamped to the {@link MAX_LEGACY_THINKING_BUDGET} ceiling;
 * the lower levels use rounded step values. `xhigh` has no distinct budget on
 * legacy models (it is an adaptive-only tier) so it maps to the same ceiling.
 */
export const LEGACY_THINKING_BUDGETS: Readonly<Record<string, number>> = {
    minimal: 2048,
    low: 8192,
    medium: 16384,
    high: MAX_LEGACY_THINKING_BUDGET,
    xhigh: MAX_LEGACY_THINKING_BUDGET,
};

// ── Effort fallback for adaptive-thinking models ───────────────────────

/**
 * Default mapping from a pi `ThinkingLevel` to a Claude Code `EffortLevel`
 * when the model's `thinkingLevelMap` does not specify one. Used only for
 * adaptive-thinking models (Opus 4.6+/4.7/4.8, Sonnet 4.6, Fable 5).
 */
export const DEFAULT_THINKING_LEVEL_TO_EFFORT: Readonly<
    Record<string, "low" | "medium" | "high" | "xhigh" | "max">
> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
};

/**
 * `session_id` stamped on replayed {@link SDKUserMessage}s. The SDK treats
 * session_id as opaque correlation metadata; a stable label keeps replay
 * traffic distinguishable from live SDK sessions in logs.
 */
export const REPLAY_SESSION_ID = "pi-replay";

/**
 * Model-id fragments that identify adaptive-thinking models (driven by
 * `effort`, not a token budget). Mirrors pi-ai's own detection in its
 * anthropic provider so the two agree on which path a model takes.
 */
export const ADAPTIVE_THINKING_MODEL_FRAGMENTS: readonly string[] = [
    "opus-4-6",
    "opus-4.6",
    "opus-4-7",
    "opus-4.7",
    "opus-4-8",
    "opus-4.8",
    "sonnet-4-6",
    "sonnet-4.6",
    "fable-5",
];
