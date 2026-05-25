/**
 * Titlebar spinner and elapsed timer feature.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { formatDuration } from "../utils.ts";
import path from "node:path";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Global registry of all agent-timer interval IDs. Stored on globalThis so
// it survives across jiti module re-evaluations. Each startAgentTimer call
// kills ALL previously registered intervals before starting a new one.
const REGISTRY_KEY = "__pi_tau_agent_timer_ids__" as const;

function killAllAgentTimers(): void {
    const ids = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
        | ReturnType<typeof setInterval>[]
        | undefined;
    if (ids) {
        for (const id of ids) clearInterval(id);
    }
    (globalThis as Record<string, unknown>)[REGISTRY_KEY] = [];
}

function registerAgentTimer(id: ReturnType<typeof setInterval>): void {
    const ids = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
        | ReturnType<typeof setInterval>[]
        | undefined;
    if (ids) {
        ids.push(id);
    }
}

export function getTitleBase(pi: ExtensionAPI): string {
    const cwd = path.basename(process.cwd());
    const session = pi.getSessionName();
    return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export function startTitlebarSpinner(
    pi: ExtensionAPI,
    state: TauState,
    ctx: { ui: { setTitle(title: string): void } }
): void {
    stopTitlebarSpinner(pi, state, ctx);
    state.titlebarTimer = setInterval(() => {
        const frame =
            BRAILLE_FRAMES[state.titlebarFrameIndex % BRAILLE_FRAMES.length];
        ctx.ui.setTitle(`${frame} ${getTitleBase(pi)}`);
        state.titlebarFrameIndex++;
    }, 80);
}

export function stopTitlebarSpinner(
    pi: ExtensionAPI,
    state: TauState,
    ctx: { ui: { setTitle(title: string): void } }
): void {
    if (state.titlebarTimer) {
        clearInterval(state.titlebarTimer);
        state.titlebarTimer = null;
    }
    state.titlebarFrameIndex = 0;
    ctx.ui.setTitle(getTitleBase(pi));
}

export function startAgentTimer(
    state: TauState,
    ctx: {
        ui: {
            setStatus(name: string, content: unknown): void;
            theme: { fg(colour: string, text: string): string };
        };
    }
): void {
    stopAgentTimer(state);
    // Kill ALL agent-timer intervals from any previous extension instance
    // (including pre-reload zombies that have no self-termination logic).
    killAllAgentTimers();

    state.agentTimer = setInterval(() => {
        if (state.agentStartTime === undefined) {
            clearInterval(state.agentTimer!);
            state.agentTimer = null;
            return;
        }
        const elapsed = formatDuration(Date.now() - state.agentStartTime);
        const spinner = ctx.ui.theme.fg("accent", "●");
        ctx.ui.setStatus(
            "tau-turn",
            spinner + ctx.ui.theme.fg("dim", ` ${elapsed}`)
        );
    }, 1_000);
    registerAgentTimer(state.agentTimer);
}

/**
 * Clear the agent-turn elapsed timer. Pure cleanup — no visual side effect.
 * To display the ✓ completion state, call showAgentTurnComplete() instead.
 */
export function stopAgentTimer(state: TauState): void {
    if (state.agentTimer) {
        clearInterval(state.agentTimer);
        state.agentTimer = null;
    }
}

/**
 * Stop the timer and display the final ✓ <elapsed> status.
 * Call only when the agent finishes entirely (agent_end), not between turns.
 */
export function showAgentTurnComplete(
    state: TauState,
    ctx: {
        ui: {
            setStatus(name: string, content: unknown): void;
            theme: { fg(colour: string, text: string): string };
        };
    }
): void {
    stopAgentTimer(state);
    if (state.agentStartTime !== undefined) {
        const elapsed = formatDuration(Date.now() - state.agentStartTime);
        const check = ctx.ui.theme.fg("success", "✓");
        ctx.ui.setStatus(
            "tau-turn",
            check + ctx.ui.theme.fg("dim", ` ${elapsed}`)
        );
    }
}
