/**
 * Compact block-character progress bars for the status line, modelled on
 * claude-hud's context / usage bars. Pure rendering — no I/O — so the bar
 * math is unit-testable.
 */

/** A theme with the coloured-text primitive tau's status bar uses. */
export interface BarTheme {
    fg(colour: string, text: string): string;
}

/** Colour name for a utilisation level (green → amber → red). */
export function levelColour(pct: number): string {
    if (pct >= 85) return "error";
    if (pct >= 60) return "warning";
    return "success";
}

/**
 * Draw a fixed-width block bar (`█` filled, `░` empty), coloured by level,
 * clamped to 0–100.
 */
export function drawBar(pct: number, width: number, theme: BarTheme): string {
    const clamped = Math.min(100, Math.max(0, pct));
    const filled = Math.round((clamped / 100) * width);
    return theme.fg(
        levelColour(clamped),
        "█".repeat(filled) + "░".repeat(width - filled)
    );
}

export interface BarInputs {
    /** Context-window fill, 0–100, or null when unknown. */
    contextPct: number | null;
    /** Cumulative session tokens as a fraction of one context window, 0–100. */
    sessionPct: number | null;
    /** Short session-size label, e.g. "42k". */
    sessionLabel: string | null;
    /** Five-hour subscription window, 0–100, or null. */
    fiveHourPct: number | null;
    /** Seven-day subscription window, 0–100, or null. */
    sevenDayPct: number | null;
}

/**
 * Build a single-line status string of compact bars. Context and session are
 * shown when available; the five-hour and seven-day subscription windows are
 * always shown when present (matching Claude Code's own status line layout).
 * Returns undefined when there's nothing to show.
 */
export function buildStatusBars(
    inputs: BarInputs,
    theme: BarTheme,
    barWidth = 6
): string | undefined {
    const dim = (s: string) => theme.fg("dim", s);
    const sep = dim("  ");
    const parts: string[] = [];

    if (inputs.contextPct !== null) {
        parts.push(
            dim("ctx ") +
                drawBar(inputs.contextPct, barWidth, theme) +
                dim(` ${Math.round(inputs.contextPct)}%`)
        );
    }
    if (inputs.sessionPct !== null) {
        parts.push(
            dim("ses ") +
                drawBar(inputs.sessionPct, barWidth, theme) +
                dim(` ${inputs.sessionLabel ?? ""}`)
        );
    }
    if (inputs.fiveHourPct !== null) {
        parts.push(
            dim("5h ") +
                drawBar(inputs.fiveHourPct, barWidth, theme) +
                dim(` ${Math.round(inputs.fiveHourPct)}%`)
        );
    }
    if (inputs.sevenDayPct !== null) {
        parts.push(
            dim("7d ") +
                drawBar(inputs.sevenDayPct, barWidth, theme) +
                dim(` ${Math.round(inputs.sevenDayPct)}%`)
        );
    }
    return parts.length > 0 ? parts.join(sep) : undefined;
}
