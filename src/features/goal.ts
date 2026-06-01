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
 * On each turn_end the agent evaluates whether the goal condition is met
 * via a system directive injected by before_agent_start.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { GoalState } from "../types.ts";

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

// ─── Feature registration ───────────────────────────────────────────

export function registerGoal(pi: ExtensionAPI, state: TauState): void {
    // Restore goal from session on startup
    pi.on("session_start", async (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries();
        for (const entry of entries) {
            if (
                entry.type === "custom" &&
                entry.customType === "tau-goal-state"
            ) {
                const data = entry.data as GoalState | undefined;
                if (data?.condition) {
                    state.activeGoal = { ...data };
                    ctx.ui.notify(`Goal restored: ${data.condition}`, "info");
                }
                break;
            }
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
  - If **yes**: state clearly that the goal has been achieved and what was done.
  - If **no**: briefly note progress made and what remains.
  - If **impossible**: explain why the condition cannot be met.

Do not stop working until the condition is satisfied or you have determined
it is genuinely impossible. The goal auto-clears once achieved — do not
tell the user to run /goal clear after success.
`;
        return {
            systemPrompt: event.systemPrompt + goalBlock,
        };
    });

    // Track iterations and persist state on each turn
    pi.on("turn_end", async (_event, _ctx) => {
        if (state.activeGoal) {
            state.activeGoal.iterations += 1;
            // Persist updated iteration count
            pi.appendEntry("tau-goal-state", {
                condition: state.activeGoal.condition,
                setAt: state.activeGoal.setAt,
                iterations: state.activeGoal.iterations,
            });
        }
    });

    // ── /goal command ─────────────────────────────────────────────

    pi.registerCommand("goal", {
        description:
            "Set a goal — keep working until the condition is met. Usage: /goal <condition>, /goal clear",
        handler: async (args, ctx) => {
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
                ctx.ui.notify(`Goal cleared: ${clearedCondition}`, "success");
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
                    "success"
                );
            } else {
                ctx.ui.notify(`Goal set: ${trimmed}`, "success");
            }

            // Trigger a turn so the agent starts working immediately
            if (ctx.isIdle()) {
                pi.sendUserMessage(
                    `Goal: ${trimmed}. Work toward this. Do not stop until it is complete.`
                );
            }
        },
    });
}
