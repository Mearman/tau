/**
 * Canonical registry of tau features that can be toggled.
 *
 * Each entry is the metadata the TUI and CLI need to display and validate
 * a feature id. Adding a new feature here is the contract for making it
 * toggleable; the soft-toggle wiring in the feature module is what makes
 * the toggle take effect at call time.
 *
 * The list is ordered by group (quality of life, workflow, integrations,
 * background) and within each group by id. Order is stable so the TUI
 * always renders the same rows in the same order.
 */

export type FeatureGroup =
    | "Quality of life"
    | "Workflow"
    | "Integrations"
    | "Background";

export interface FeatureDef {
    /** Stable identifier, used on disk and in CLI args. Kebab-case. */
    id: string;
    /** Human-readable label, shown in the TUI. */
    label: string;
    /** One-sentence description, shown in the TUI footer. */
    description: string;
    /** Group label, used to cluster rows in the TUI. */
    group: FeatureGroup;
    /** Whether the feature is on by default. Currently always true. */
    defaultOn: boolean;
}

export const FEATURE_REGISTRY: ReadonlyArray<FeatureDef> = [
    // ── Quality of life (5) ───────────────────────────────────────
    {
        id: "bookmark",
        label: "Bookmark",
        description: "Bookmark the last assistant message with a label",
        group: "Quality of life",
        defaultOn: true,
    },
    {
        id: "session-name",
        label: "Session name",
        description: "Name the current session for easier reference",
        group: "Quality of life",
        defaultOn: true,
    },
    {
        id: "custom-footer",
        label: "Custom footer",
        description: "Replace the default pi footer with a custom one",
        group: "Quality of life",
        defaultOn: true,
    },
    {
        id: "goal",
        label: "Goal",
        description: "Keep the agent working until a goal condition is met",
        group: "Quality of life",
        defaultOn: true,
    },
    {
        id: "preset",
        label: "Preset cycling",
        description: "Cycle between named preset configurations",
        group: "Quality of life",
        defaultOn: true,
    },

    // ── Workflow (6) ──────────────────────────────────────────────
    {
        id: "task",
        label: "Task tree",
        description: "Hierarchical task tracking with links and status",
        group: "Workflow",
        defaultOn: true,
    },
    {
        id: "plan-mode",
        label: "Plan mode",
        description: "Read-only exploration mode for structured planning",
        group: "Workflow",
        defaultOn: true,
    },
    {
        id: "workflow",
        label: "Workflow runner",
        description: "Deterministic multi-agent workflow execution",
        group: "Workflow",
        defaultOn: true,
    },
    {
        id: "context",
        label: "Context",
        description: "Inspect and manage session context",
        group: "Workflow",
        defaultOn: true,
    },
    {
        id: "summarize",
        label: "Summarize",
        description: "Generate a structured summary of the session",
        group: "Workflow",
        defaultOn: true,
    },
    {
        id: "loop",
        label: "Loop",
        description: "Run a prompt on a count, duration, or schedule",
        group: "Workflow",
        defaultOn: true,
    },

    // ── Integrations (7) ──────────────────────────────────────────
    {
        id: "agent-sdk",
        label: "Claude Agent SDK provider",
        description:
            "Route Claude model calls through the Agent SDK to draw from the Claude Pro/Max subscription rate-limit pool",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "claude-resume",
        label: "Claude session loader (/claude-resume)",
        description:
            "Load a Claude Code (~/.claude) session into a new pi session via /claude-resume",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "instructions",
        label: "Instructions",
        description:
            "Auto-load project instructions, rules, and memory from .agents/ and .claude/ at all scopes",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "memory",
        label: "Memory",
        description:
            "Auto-load MEMORY.md from .agents/memory/ and .claude/memory/ at all scopes; topic files read on demand",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "web-browse",
        label: "Web browse",
        description: "Browse, fetch, screenshot, and click web pages",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "web-search",
        label: "Web search",
        description: "Search the web via Claude, Brave, or DuckDuckGo",
        group: "Integrations",
        defaultOn: true,
    },
    {
        id: "callbacks",
        label: "Callbacks",
        description: "Reminders and timed callback tools",
        group: "Integrations",
        defaultOn: true,
    },

    // ── Background (3) ────────────────────────────────────────────
    {
        id: "agent-background",
        label: "Agent backgrounding",
        description: "Pause the agent mid-turn with Ctrl+B",
        group: "Background",
        defaultOn: true,
    },
    {
        id: "notifications",
        label: "Notifications",
        description: "Send macOS, Terminal, and Slack notifications",
        group: "Background",
        defaultOn: true,
    },
    {
        id: "reload",
        label: "Reload tool",
        description: "Reload extensions, skills, prompts, and themes",
        group: "Background",
        defaultOn: true,
    },
];

const BY_ID: ReadonlyMap<string, FeatureDef> = new Map(
    FEATURE_REGISTRY.map((f) => [f.id, f])
);

export function getFeatureDef(id: string): FeatureDef | undefined {
    return BY_ID.get(id);
}

export function isKnownFeature(id: string): boolean {
    return BY_ID.has(id);
}
