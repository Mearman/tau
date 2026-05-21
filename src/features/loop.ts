/**
 * /loop — unified looping command (replaces /proactive).
 *
 * Parses the first token to determine loop mode:
 *
 *   /loop 5 do something         — run 5 times, then stop
 *   /loop 5m do something        — run every 5 minutes
 *   /loop 2h check the deploy    — run every 2 hours
 *   /loop do something           — infinite loop (proactive mode)
 *
 * The remaining tokens after the count/interval are the tick prompt,
 * sent as a user message along with an ISO timestamp on each tick.
 * If no prompt is given, only the timestamp is sent.
 *
 * Flags:
 *   --completion-promise[="text"]  stop the loop when the phrase is detected.
 *                                  Bare flag uses default patterns.
 *                                  Without the flag, the loop never auto-stops.
 *
 * Subcommands:
 *   /loop list   — show running loops
 *   /loop stop   — stop all loops
 *   /loop stop 1 — stop loop #N
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Constants ---

const TICK_TAG = "tick";

/** Idle window between proactive ticks so the user can interrupt (Ctrl+C / Escape). */
const TICK_DELAY_MS = 500;

// --- Parsing ---

type LoopMode =
    | { kind: "count"; count: number }
    | { kind: "interval"; ms: number; human: string }
    | { kind: "infinite" };

interface ParsedLoop {
    mode: LoopMode;
    prompt: string;
    // Three states: null = no detection, "default" = built-in patterns, string = custom phrase
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    completionPromise: null | "default" | string;
}

function parseDuration(token: string): { ms: number; human: string } | null {
    const match = token.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const units: Record<string, [number, string]> = {
        s: [1000, "s"],
        m: [60_000, "m"],
        h: [3_600_000, "h"],
        d: [86_400_000, "d"],
    };
    const [multiplier, suffix] = units[unit];
    return { ms: value * multiplier, human: `${value}${suffix}` };
}

const CRON_FIELD_RE = /^([*]\/\d+|\d+|\*(?:\/\d+)?)$/;

function parseCron(expr: string): { ms: number; human: string } | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    if (!fields.every((f) => CRON_FIELD_RE.test(f))) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

    // Only support simple periodic patterns: */N on one field, * on the rest
    // minute granularity
    if (
        minute.startsWith("*/") &&
        hour === "*" &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = parseInt(minute.slice(2), 10);
        if (n > 0 && n <= 59) return { ms: n * 60_000, human: `every ${n}m` };
    }

    // hour granularity
    if (
        minute === "0" &&
        hour.startsWith("*/") &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = parseInt(hour.slice(2), 10);
        if (n > 0 && n <= 23)
            return { ms: n * 3_600_000, human: `every ${n}h` };
    }

    // day granularity
    if (
        minute === "0" &&
        hour === "0" &&
        dayOfMonth.startsWith("*/") &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = parseInt(dayOfMonth.slice(2), 10);
        if (n > 0) return { ms: n * 86_400_000, human: `every ${n}d` };
    }

    return null;
}

/**
 * Extract `--completion-promise[="text"]` from raw input.
 *
 * - Not present                → null       (no completion detection)
 * - `--completion-promise`      → "default"  (built-in done patterns)
 * - `--completion-promise="x"` → "x"        (case-insensitive substring match)
 */
function extractCompletionPromise(input: string): {
    remaining: string;
    // Three states: null = no detection, "default" = built-in patterns, string = custom phrase
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    completionPromise: null | "default" | string;
} {
    const FLAG = "--completion-promise";
    const idx = input.indexOf(FLAG);
    if (idx === -1) return { remaining: input, completionPromise: null };

    const before = input.slice(0, idx);
    const after = input.slice(idx + FLAG.length);

    // --completion-promise="quoted text"
    const quotedEq = after.match(/^="([^"]*)"/);
    if (quotedEq) {
        return {
            remaining: (before + after.slice(quotedEq[0].length)).replace(
                /\s+/g,
                " "
            ),
            completionPromise: quotedEq[1] || "default",
        };
    }

    // --completion-promise=unquoted
    const unquotedEq = after.match(/^=(\S+)/);
    if (unquotedEq) {
        return {
            remaining: (before + after.slice(unquotedEq[0].length)).replace(
                /\s+/g,
                " "
            ),
            completionPromise: unquotedEq[1],
        };
    }

    // --completion-promise "quoted text"
    const quotedSp = after.match(/^\s+"([^"]*)"/);
    if (quotedSp) {
        return {
            remaining: (before + after.slice(quotedSp[0].length)).replace(
                /\s+/g,
                " "
            ),
            completionPromise: quotedSp[1] || "default",
        };
    }

    // Bare flag, no value → default
    return {
        remaining: (before + after).replace(/\s+/g, " "),
        completionPromise: "default",
    };
}

function parseLoopArgs(input: string): ParsedLoop {
    const { remaining, completionPromise } = extractCompletionPromise(input);
    const trimmed = remaining.trim();
    if (!trimmed)
        return {
            mode: { kind: "infinite" },
            prompt: "",
            completionPromise,
        };

    const tokens = trimmed.split(/\s+/);

    // Check if first 5 tokens form a cron expression (5-field pattern)
    if (tokens.length >= 6) {
        const cronExpr = tokens.slice(0, 5).join(" ");
        const cron = parseCron(cronExpr);
        if (cron) {
            return {
                mode: { kind: "interval", ms: cron.ms, human: cron.human },
                prompt: tokens.slice(5).join(" "),
                completionPromise,
            };
        }
    }

    // Check if first token is a duration (5m, 2h, etc.)
    const duration = parseDuration(tokens[0]);
    if (duration) {
        return {
            mode: { kind: "interval", ms: duration.ms, human: duration.human },
            prompt: tokens.slice(1).join(" "),
            completionPromise,
        };
    }

    // Check if first token is a plain integer (count)
    const countMatch = tokens[0].match(/^(\d+)$/);
    if (countMatch && tokens.length > 1) {
        return {
            mode: { kind: "count", count: parseInt(countMatch[1], 10) },
            prompt: tokens.slice(1).join(" "),
            completionPromise,
        };
    }

    // No count or duration — infinite loop, entire input is the prompt
    return { mode: { kind: "infinite" }, prompt: trimmed, completionPromise };
}

// --- Tick message construction ---

function formatDuration(ms: number): string {
    const abs = Math.abs(ms);
    if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
    return `${Math.round(abs / 86_400_000)}d`;
}

function buildTickMessage(prompt: string, lastTickAt: Date | null): string {
    const now = new Date();
    const parts = [`<${TICK_TAG}>${now.toISOString()}</${TICK_TAG}>`];
    if (lastTickAt) {
        const elapsed = now.getTime() - lastTickAt.getTime();
        parts.push(`<elapsed>${formatDuration(elapsed)}</elapsed>`);
    }
    if (prompt) parts.push(prompt);
    return parts.join("\n");
}

// --- Loop runner ---

interface LoopEntry {
    id: number;
    prompt: string;
    mode: LoopMode;
    ticksFired: number;
    lastTickAt: Date | null;
    timer: ReturnType<typeof setInterval> | null;
    pendingTick: ReturnType<typeof setTimeout> | null;
    remaining: number; // for count mode
    humanDescription: string;
    // Three states: null = no detection, "default" = built-in patterns, string = custom phrase
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    completionPromise: null | "default" | string;
}

const DEFAULT_DONE_PATTERNS = [
    /\b(?:all (?:steps|tasks|work) (?:are )?(?:complete|done|finished))\b/i,
    /\b(?:nothing (?:more|else) (?:to do|left))\b/i,
    /\b(?:fully (?:implemented|complete))\b/i,
];

// --- Feature registration ---

export function registerLoop(pi: ExtensionAPI): void {
    const loops: LoopEntry[] = [];
    let nextId = 1;

    function emitTick(entry: LoopEntry): void {
        entry.lastTickAt = new Date();
        pi.sendUserMessage(buildTickMessage(entry.prompt, entry.lastTickAt));
    }

    function startLoop(parsed: ParsedLoop): LoopEntry {
        const id = nextId++;
        const entry: LoopEntry = {
            id,
            prompt: parsed.prompt,
            mode: parsed.mode,
            ticksFired: 0,
            lastTickAt: null,
            timer: null,
            pendingTick: null,
            remaining: 0,
            humanDescription: "",
            completionPromise: parsed.completionPromise,
        };

        switch (parsed.mode.kind) {
            case "count": {
                entry.remaining = parsed.mode.count;
                entry.humanDescription = `${parsed.mode.count} times`;
                // Fire first tick after event queue settles
                entry.remaining--;
                entry.ticksFired++;
                setTimeout(() => emitTick(entry), 0);

                if (entry.remaining > 0) {
                    // Rapid-fire count loops with a small delay so the agent can
                    // process each tick before the next arrives
                    entry.timer = setInterval(() => {
                        entry.remaining--;
                        entry.ticksFired++;
                        emitTick(entry);
                        if (entry.remaining <= 0) {
                            removeLoop(id);
                        }
                    }, 2000);
                } else {
                    // Single-shot, remove after fire
                    setTimeout(() => removeLoop(id), 100);
                }
                break;
            }

            case "interval": {
                entry.humanDescription = `every ${parsed.mode.human}`;
                // Fire first tick immediately
                entry.ticksFired++;
                setTimeout(() => emitTick(entry), 0);

                entry.timer = setInterval(() => {
                    entry.ticksFired++;
                    emitTick(entry);
                }, parsed.mode.ms);
                break;
            }

            case "infinite": {
                entry.humanDescription = "proactive (infinite)";
                // Infinite loops fire on agent_end — registered separately via
                // the agent_end handler below. Just store the entry.
                break;
            }
        }

        loops.push(entry);
        return entry;
    }

    function removeLoop(id: number): boolean {
        const idx = loops.findIndex((l) => l.id === id);
        if (idx === -1) return false;
        const loop = loops[idx];
        if (loop.timer) clearInterval(loop.timer);
        if (loop.pendingTick) clearTimeout(loop.pendingTick);
        loops.splice(idx, 1);
        return true;
    }

    function stopAll(): number {
        const count = loops.length;
        for (const loop of loops) {
            if (loop.timer) clearInterval(loop.timer);
            if (loop.pendingTick) clearTimeout(loop.pendingTick);
        }
        loops.length = 0;
        return count;
    }

    // --- Event handlers ---

    pi.on("session_start", async () => {
        stopAll();
        nextId = 1;
    });

    // Inject proactive system prompt when any infinite loop is active
    pi.on("before_agent_start", async (event) => {
        const hasInfinite = loops.some((l) => l.mode.kind === "infinite");
        if (!hasInfinite) return;

        const loopWithPromise = loops.find(
            (l) => l.mode.kind === "infinite" && l.completionPromise !== null
        );

        let completionInstruction = "";
        if (loopWithPromise) {
            const phrase =
                loopWithPromise.completionPromise === "default"
                    ? "All tasks complete"
                    : loopWithPromise.completionPromise;
            completionInstruction = `\n\nWhen there is genuinely nothing left to do, say "${phrase}" and stop. This signals the loop to end.`;
        }

        const systemPrompt =
            event.systemPrompt +
            `
# Proactive Mode

You are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.

You will receive periodic <${TICK_TAG}> prompts. These are check-ins: continue whatever you were doing, or pick up the next logical task. Do not summarise progress or ask what to work on — just call tools and keep working.${completionInstruction}`;
        return { systemPrompt };
    });

    // Fire infinite loop ticks after agent ends a turn cleanly
    pi.on("agent_end", async (event, ctx) => {
        const infiniteLoops = loops.filter((l) => l.mode.kind === "infinite");
        if (infiniteLoops.length === 0) return;

        // Don't tick if there are already pending messages
        if (ctx.hasPendingMessages()) return;

        // Find the last assistant message
        const messages = event.messages;
        let lastAssistant:
            | ((typeof messages)[number] & {
                  role: "assistant";
              })
            | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (
                "role" in msg &&
                msg.role === "assistant" &&
                "content" in msg &&
                Array.isArray(msg.content)
            ) {
                lastAssistant = msg as (typeof messages)[number] & {
                    role: "assistant";
                };
                break;
            }
        }
        if (!lastAssistant) return;

        // Only tick on clean stops
        if (
            !("stopReason" in lastAssistant) ||
            lastAssistant.stopReason !== "stop"
        )
            return;

        // If the assistant made tool calls, the normal tool loop handles continuation
        const content = lastAssistant.content as Array<{
            type: string;
            text?: string;
        }>;
        const hasToolCalls = content.some((part) => part.type === "toolCall");
        if (hasToolCalls) return;

        // Collect text for completion-promise matching
        const textParts = content
            .filter(
                (part) => part.type === "text" && typeof part.text === "string"
            )
            .map((part) => part.text);
        const fullText = textParts.join(" ");

        // Fire a tick for each infinite loop (skip if its completion promise is met)
        for (const loop of infiniteLoops) {
            let done = false;

            if (loop.completionPromise === "default") {
                done = DEFAULT_DONE_PATTERNS.some((p) => p.test(fullText));
            } else if (loop.completionPromise !== null) {
                done = fullText
                    .toLowerCase()
                    .includes(loop.completionPromise.toLowerCase());
            }

            if (done) {
                removeLoop(loop.id);
                continue;
            }

            loop.ticksFired++;
            const msg = buildTickMessage(loop.prompt, loop.lastTickAt);
            loop.pendingTick = setTimeout(() => {
                loop.pendingTick = null;
                pi.sendUserMessage(msg);
            }, TICK_DELAY_MS);
        }
    });

    // --- Command registration ---

    pi.registerCommand("loop", {
        description:
            'Loop a prompt: count (5), duration (5m), cron (*/5 * * * *), or infinite (no prefix). Flags: --completion-promise[="text"]',
        handler: async (args, ctx) => {
            const trimmed = args.trim().toLowerCase();

            if (trimmed === "list") {
                if (loops.length === 0) {
                    ctx.ui.notify("No active loops.", "info");
                } else {
                    const lines = loops.map(
                        (l) =>
                            `  #${l.id}: "${l.prompt || "(no prompt)"}" — ${l.humanDescription} (${l.ticksFired} ticks)`
                    );
                    ctx.ui.notify(`Active loops:\n${lines.join("\n")}`, "info");
                }
                return;
            }

            if (
                trimmed === "stop" ||
                trimmed === "off" ||
                trimmed === "cancel"
            ) {
                const count = stopAll();
                ctx.ui.notify(`Stopped ${count} loop(s).`, "info");
                return;
            }

            const stopMatch = trimmed.match(/^stop\s+(\d+)$/);
            if (stopMatch) {
                const id = parseInt(stopMatch[1], 10);
                if (removeLoop(id)) {
                    ctx.ui.notify(`Loop #${id} stopped.`, "info");
                } else {
                    ctx.ui.notify(`Loop #${id} not found.`, "info");
                }
                return;
            }

            const parsed = parseLoopArgs(args.trim());
            const entry = startLoop(parsed);

            ctx.ui.notify(
                `Loop #${entry.id} started: "${entry.prompt || "(no prompt)"}" ${entry.humanDescription}. Use /loop stop ${entry.id} to cancel.`,
                "info"
            );
        },
    });
}
