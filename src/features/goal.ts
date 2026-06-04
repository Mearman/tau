/**
 * Goal feature — /goal command to set a persistent goal that keeps the agent
 * working until a condition is met.
 *
 * Inspired by Claude Code's /goal implementation:
 *   /goal <condition>  — Set a goal; agent keeps working until condition is met
 *   /goal clear        — Clear the active goal
 *   /goal              — Show current goal status
 *
 * The goal is persisted in session entries so it survives /reload.
 *
 * Continuation mechanism (Stop hook equivalent):
 *   Claude Code uses a Stop hook with preventContinuation to physically block
 *   the agent from stopping. pi doesn't expose Stop hooks, so we approximate
 *   the same behaviour by listening on agent_end: if the goal is not yet met,
 *   we inject a follow-up user message that forces the agent to keep working.
 *   This creates a hard loop — the agent cannot stop until the goal condition
 *   is satisfied or the user runs /goal clear.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import type { GoalState } from "../types.ts";

/** Type guard: check if a session entry is a custom entry with a specific customType. */
function isCustomEntry(
    entry: { type: string; customType?: string },
    customType: string
): entry is {
    type: "custom";
    customType: string;
    data?: unknown;
} {
    return entry.type === "custom" && entry.customType === customType;
}

/** Type guard: validate GoalState shape from unknown session entry data. */
function isGoalStateData(value: unknown): value is GoalState {
    if (typeof value !== "object" || value === null) return false;
    if (!("condition" in value)) return false;
    return typeof value.condition === "string";
}

/** Type guard: check if a message-like value is an assistant message with array content. */
function isAssistantMessage(
    msg: unknown
): msg is { role: string; content: unknown[]; stopReason?: unknown } {
    if (typeof msg !== "object" || msg === null) return false;
    if (!("role" in msg) || !("content" in msg)) return false;
    return (
        typeof msg.role === "string" &&
        msg.role === "assistant" &&
        Array.isArray(msg.content)
    );
}

/** Narrow unknown content to an array of typed parts. */
function isTypedPart(value: unknown): value is { type: string } {
    if (typeof value !== "object" || value === null) return false;
    if (!("type" in value)) return false;
    return typeof value.type === "string";
}

// ─── Completion detection ───────────────────────────────────────────

/**
 * Patterns the agent uses to signal it believes the goal is met.
 * Scanned case-insensitively against the last assistant message text.
 */
const DONE_PATTERNS = [
    /\bgoal\s+(?:is\s+)?(?:achieved|met|complete|done|satisfied|finished)\b/i,
    /\bcondition\s+(?:is\s+)?(?:now\s+)?(?:met|satisfied|fulfilled|complete)\b/i,
    /\btask\s+(?:is\s+)?(?:complete|done|finished)\b/i,
    /\ball\s+(?:steps?|tasks?|work)\s+(?:are\s+)?(?:complete|done|finished)\b/i,
    /\bworking\s+as\s+(?:expected|intended|designed)\b/i,
    /\bnothing\s+(?:more|else)\s+to\s+do\b/i,
];

/**
 * Patterns that signal the agent believes the goal is impossible.
 */
const IMPOSSIBLE_PATTERNS = [
    /\bgoal\s+(?:is\s+)?(?:impossible|unachievable|cannot\s+be\s+met)\b/i,
    /\bcondition\s+(?:is\s+)?(?:impossible|unachievable|cannot\s+be\s+satisfied)\b/i,
    /\bunable\s+to\s+(?:complete|achieve|satisfy|meet)\s+(?:the\s+)?goal\b/i,
];

export function checkGoalCompletion(text: string): "met" | "impossible" | null {
    for (const pattern of DONE_PATTERNS) {
        if (pattern.test(text)) return "met";
    }
    for (const pattern of IMPOSSIBLE_PATTERNS) {
        if (pattern.test(text)) return "impossible";
    }
    return null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function goalStatusText(state: TauState): string {
    const goal = state.activeGoal;
    if (!goal) return "No goal set";
    const elapsed = Date.now() - goal.setAt;
    const mins = Math.floor(elapsed / 60_000);
    const secs = Math.floor((elapsed % 60_000) / 10_000) * 10;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return `Goal: ${goal.condition} (${goal.iterations} turns, ${timeStr})`;
}

function updateGoalStatus(state: TauState, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (state.activeGoal) {
        ctx.ui.setStatus(
            "tau-goal",
            ctx.ui.theme.fg("accent", `🎯 ${goalStatusText(state)}`)
        );
    } else {
        ctx.ui.setStatus("tau-goal", undefined);
    }
}

/** Extract text from a message's content (string or array of blocks). */
function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b: unknown): b is { type: string; text: string } =>
                typeof b === "object" &&
                b !== null &&
                "type" in b &&
                typeof b.type === "string" &&
                b.type === "text" &&
                "text" in b &&
                typeof b.text === "string"
        )
        .map((b) => b.text)
        .join(" ");
}

// ─── Feature registration ───────────────────────────────────────────

export function registerGoal(pi: ExtensionAPI, state: TauState): void {
    // Restore goal from session on startup — walk the active branch
    // (not all entries) so switching branches picks up the correct goal.
    pi.on("session_start", async (_event, ctx) => {
        for (const entry of ctx.sessionManager.getBranch()) {
            if (isCustomEntry(entry, "tau-goal-state")) {
                const data = entry.data;
                if (data && isGoalStateData(data) && data.condition) {
                    state.activeGoal = { ...data };
                } else {
                    // Cleared goal entry — reset
                    state.activeGoal = undefined;
                }
            }
        }
        if (state.activeGoal) {
            ctx.ui.notify(
                `Goal restored: ${state.activeGoal.condition}`,
                "info"
            );
        }
        updateGoalStatus(state, ctx);
    });

    // Inject goal context into every agent turn
    pi.on("before_agent_start", async (event) => {
        if (!state.activeGoal) return;

        const goalBlock = `
## ACTIVE GOAL

You have an active goal. Keep working toward it every turn.

**Condition:** ${state.activeGoal.condition}
**Started:** ${new Date(state.activeGoal.setAt).toISOString()}
**Turns so far:** ${state.activeGoal.iterations}

On each turn:
- Make concrete progress toward the goal condition.
- After your response, evaluate: is the goal condition now met?
  - If **yes**: state clearly "Goal is achieved" or "Goal condition is met"
    and describe what was done. The loop will auto-clear.
  - If **no**: briefly note progress made and what remains.
  - If **impossible**: state "Goal is impossible" and explain why.

Do not stop working until the condition is satisfied or you have determined
it is genuinely impossible. Keep calling tools each turn — do not idle.
`;
        return {
            systemPrompt: event.systemPrompt + goalBlock,
        };
    });

    // Stop hook equivalent: force continuation when the goal is not yet met.
    // This is the critical mechanism — without it, the agent could stop
    // after any turn even if the goal is incomplete (the system prompt
    // injection alone is advisory).
    pi.on("agent_end", async (event, ctx) => {
        if (!state.activeGoal) return;

        // Don't interfere if there are already pending messages
        if (ctx.hasPendingMessages()) return;

        // Find the last assistant message and check for tool calls
        const messages = event.messages;
        let lastAssistant:
            | {
                  role: string;
                  content: unknown;
                  stopReason?: string;
              }
            | undefined;

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (isAssistantMessage(msg)) {
                lastAssistant = {
                    role: msg.role,
                    content: msg.content,
                    stopReason:
                        typeof msg.stopReason === "string"
                            ? msg.stopReason
                            : undefined,
                };
                break;
            }
        }
        if (!lastAssistant) return;

        // If the assistant made tool calls, the normal tool loop handles
        // continuation — the agent hasn't actually tried to stop yet.
        const content = lastAssistant.content;
        const hasToolCalls =
            Array.isArray(content) &&
            content
                .filter(isTypedPart)
                .some((part) => part.type === "toolCall");
        if (hasToolCalls) return;

        // Only act on clean stops (the agent chose to stop, not aborted)
        if (lastAssistant.stopReason !== "stop") return;

        // Check if the agent signaled completion
        const fullText = extractText(lastAssistant.content);
        const completion = checkGoalCompletion(fullText);

        if (completion === "met") {
            // Goal achieved — clear it
            const condition = state.activeGoal.condition;
            state.activeGoal = undefined;
            pi.appendEntry("tau-goal-state", {});
            updateGoalStatus(state, ctx);
            ctx.ui.notify(`Goal achieved: ${condition}`, "info");
            return;
        }

        if (completion === "impossible") {
            // Goal deemed impossible — clear it but warn
            const condition = state.activeGoal.condition;
            state.activeGoal = undefined;
            pi.appendEntry("tau-goal-state", {});
            updateGoalStatus(state, ctx);
            ctx.ui.notify(`Goal marked impossible: ${condition}`, "warning");
            return;
        }

        // Goal NOT met — force continuation (Stop hook equivalent).
        // This is the key difference from advisory-only approaches:
        // we physically prevent the agent from stopping.
        state.activeGoal.iterations += 1;
        pi.appendEntry("tau-goal-state", {
            condition: state.activeGoal.condition,
            setAt: state.activeGoal.setAt,
            iterations: state.activeGoal.iterations,
        });

        const continuationMsg = `[Goal continuation — turn ${state.activeGoal.iterations}] Goal: ${state.activeGoal.condition}. You have not yet met the goal condition. Call tools and continue working. Do not idle.`;

        pi.sendUserMessage(continuationMsg, { deliverAs: "followUp" });
    });

    // ── /goal command ─────────────────────────────────────────────

    pi.registerCommand("goal", {
        description:
            "Set a goal — keep working until the condition is met. Usage: /goal <condition>, /goal clear",
        handler: async (args, ctx) => {
            if (!isFeatureEnabled(state, "goal")) {
                ctx.ui.notify("Goal is disabled — run /tau to enable", "info");
                return;
            }

            const trimmed = (args ?? "").trim();

            // /goal clear — remove the active goal
            if (trimmed === "clear") {
                if (!state.activeGoal) {
                    ctx.ui.notify("No active goal to clear", "info");
                    return;
                }
                const clearedCondition = state.activeGoal.condition;
                state.activeGoal = undefined;
                pi.appendEntry("tau-goal-state", {});
                updateGoalStatus(state, ctx);
                ctx.ui.notify(`Goal cleared: ${clearedCondition}`, "info");
                return;
            }

            // /goal (no args) — show status
            if (trimmed === "") {
                if (!state.activeGoal) {
                    ctx.ui.notify(
                        "No goal set. Usage: /goal <condition>",
                        "info"
                    );
                } else {
                    ctx.ui.notify(goalStatusText(state), "info");
                }
                return;
            }

            // /goal <condition> — set a new goal
            const previousGoal = state.activeGoal?.condition;
            state.activeGoal = {
                condition: trimmed,
                setAt: Date.now(),
                iterations: 0,
            };
            pi.appendEntry("tau-goal-state", {
                condition: state.activeGoal.condition,
                setAt: state.activeGoal.setAt,
                iterations: state.activeGoal.iterations,
            });
            updateGoalStatus(state, ctx);

            if (previousGoal) {
                ctx.ui.notify(
                    `Goal updated: ${trimmed} (was: ${previousGoal})`,
                    "info"
                );
            } else {
                ctx.ui.notify(`Goal set: ${trimmed}`, "info");
            }

            // Trigger a turn so the agent starts working immediately
            if (ctx.isIdle()) {
                pi.sendUserMessage(
                    `Goal: ${trimmed}. Work toward this. Do not stop until it is complete. Keep calling tools each turn.`
                );
            }
        },
    });
}
