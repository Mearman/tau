/**
 * Titlebar spinner and elapsed timer feature.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.js";
import { formatDuration } from "../utils.js";
import path from "node:path";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getTitleBase(pi: ExtensionAPI): string {
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
    stopAgentTimer(state, ctx);
    state.agentTimer = setInterval(() => {
        if (state.agentStartTime === undefined) return;
        const elapsed = formatDuration(Date.now() - state.agentStartTime);
        const spinner = ctx.ui.theme.fg("accent", "●");
        ctx.ui.setStatus(
            "tau-turn",
            spinner + ctx.ui.theme.fg("dim", ` ${elapsed}`)
        );
    }, 1_000);
}

export function stopAgentTimer(
    state: TauState,
    ctx: {
        ui: {
            setStatus(name: string, content: unknown): void;
            theme: { fg(colour: string, text: string): string };
        };
    }
): void {
    if (state.agentTimer) {
        clearInterval(state.agentTimer);
        state.agentTimer = null;
    }
    if (state.agentStartTime !== undefined) {
        const elapsed = formatDuration(Date.now() - state.agentStartTime);
        const check = ctx.ui.theme.fg("success", "✓");
        ctx.ui.setStatus(
            "tau-turn",
            check + ctx.ui.theme.fg("dim", ` ${elapsed}`)
        );
    }
}
