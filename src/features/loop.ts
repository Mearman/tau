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

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

// --- Constants ---

const TICK_TAG = "tick";

/** Idle window between proactive ticks so the user can interrupt (Ctrl+C / Escape). */
const TICK_DELAY_MS = 500;

// --- Parsing ---

export type LoopMode =
    | { kind: "count"; count: number }
    | { kind: "interval"; ms: number; human: string }
    | { kind: "infinite" };

export interface ParsedLoop {
    mode: LoopMode;
    prompt: string;
    // Three states: null = no detection, "default" = built-in patterns, string = custom phrase
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    completionPromise: null | "default" | string;
}

export function parseDuration(
    token: string
): { ms: number; human: string } | null {
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

export function parseCron(expr: string): { ms: number; human: string } | null {
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
export function extractCompletionPromise(input: string): {
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

export function parseLoopArgs(input: string): ParsedLoop {
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

export function formatDuration(ms: number): string {
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

// --- Context-based inference ---

/** Patterns that suggest a monitoring/watching task and a good interval. */
const INTERVAL_HINTS: Array<{
    pattern: RegExp;
    ms: number;
    human: string;
    label: string;
}> = [
    {
        pattern: /\b(?:watch|monitor|tail|follow)\b/i,
        ms: 5_000,
        human: "5s",
        label: "watch/monitor",
    },
    {
        pattern:
            /\b(?:wait(?:ing)?\s+for|poll(?:ing)?|check(?:ing)?\s+(?:every|in))\b/i,
        ms: 10_000,
        human: "10s",
        label: "polling",
    },
    {
        pattern: /\b(?:deploy|build|compile|ci\b|pipeline)\b/i,
        ms: 60_000,
        human: "1m",
        label: "deploy/build",
    },
    {
        pattern: /\b(?:test|spec|e2e|integration)\b/i,
        ms: 30_000,
        human: "30s",
        label: "test runner",
    },
    {
        pattern: /\b(?:status|health|heartbeat|check)\b/i,
        ms: 60_000,
        human: "1m",
        label: "status check",
    },
];

/** Default interval when no hint matches. */
const DEFAULT_INTERVAL = { ms: 300_000, human: "5m", label: "default" };

/**
 * Extract text from a message content field.
 * Handles string content and array-of-blocks content.
 */
function extractTextFromMessage(message: ContentMessage): string {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(
                (b: unknown): b is { type: string; text: string } =>
                    typeof b === "object" &&
                    b !== null &&
                    "type" in b &&
                    (b as { type: string }).type === "text" &&
                    "text" in b
            )
            .map((b) => b.text)
            .join(" ");
    }
    return "";
}

interface ContentMessage {
    role: string;
    content: unknown;
}

/** Check if a session entry is a message with a content field. */
function isMessageEntry(
    entry: SessionEntry
): entry is SessionEntry & { message: ContentMessage } {
    if (entry.type !== "message" || !("message" in entry)) return false;
    const msg = (entry as { message?: unknown }).message;
    if (typeof msg !== "object" || msg === null) return false;
    return "content" in msg;
}

/**
 * Infer the loop interval from conversation context.
 *
 * Scans the last few messages for keywords that suggest a polling frequency.
 * Returns the first matching hint, or the default (5m).
 */
export function inferInterval(entries: SessionEntry[]): {
    ms: number;
    human: string;
    label: string;
} {
    // Look at the last 6 messages for interval hints
    const recent = entries.filter(isMessageEntry).slice(-6);
    const text = recent.map((e) => extractTextFromMessage(e.message)).join(" ");

    for (const hint of INTERVAL_HINTS) {
        if (hint.pattern.test(text)) return hint;
    }
    return DEFAULT_INTERVAL;
}

/**
 * Infer the loop prompt from conversation context.
 *
 * Strategy:
 * 1. If the last user message contains a task-like instruction, use that.
 * 2. Otherwise, if the last assistant message describes ongoing work, derive a prompt.
 * 3. Fall back to "Continue working".
 */
export function inferPrompt(entries: SessionEntry[]): string {
    const messageEntries = entries.filter(isMessageEntry);

    // Walk backwards for the last user message
    for (let i = messageEntries.length - 1; i >= 0; i--) {
        const entry = messageEntries[i];
        if (entry.message.role === "user") {
            const text = extractTextFromMessage(entry.message).trim();
            // Skip tick messages and empty messages
            if (text && !text.startsWith("<" + TICK_TAG + ">")) {
                return truncatePrompt(text);
            }
        }
    }

    // Walk backwards for the last assistant message
    for (let i = messageEntries.length - 1; i >= 0; i--) {
        const entry = messageEntries[i];
        if (entry.message.role === "assistant") {
            const text = extractTextFromMessage(entry.message).trim();
            if (text) {
                return truncatePrompt(text);
            }
        }
    }

    return "Continue working";
}

/** Truncate a prompt to a reasonable length for loop repetition. */
export function truncatePrompt(text: string): string {
    const MAX_PROMPT_LENGTH = 200;
    if (text.length <= MAX_PROMPT_LENGTH) return text;
    // Try to cut at the last sentence boundary before the limit
    const truncated = text.slice(0, MAX_PROMPT_LENGTH);
    const lastSentence = Math.max(
        truncated.lastIndexOf("."),
        truncated.lastIndexOf("!"),
        truncated.lastIndexOf("?")
    );
    if (lastSentence > MAX_PROMPT_LENGTH * 0.5) {
        return truncated.slice(0, lastSentence + 1).trim();
    }
    return truncated.trim() + "…";
}

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

    // --- Interactive loop manager TUI ---

    /**
     * Open the interactive loop manager overlay.
     *
     * Shows all running loops with selectable actions per loop.
     * Keyboard: Up/Down navigate, Enter to act on a loop, Escape to close.
     */
    async function showLoopManager(
        ctx: ExtensionCommandContext
    ): Promise<void> {
        if (loops.length === 0) {
            ctx.ui.notify("No active loops.", "info");
            return;
        }

        await ctx.ui.custom((_tui, theme, _kb, done) => {
            const container = new Container();

            // Header
            container.addChild(
                new Text(
                    theme.fg(
                        "accent",
                        theme.bold(`Active Loops (${loops.length})`)
                    ),
                    0,
                    0
                )
            );
            container.addChild(new Spacer(1));

            // Build select items — one per loop, plus a "Stop All" option
            const loopItems = loops.map((loop) => {
                const elapsed = loop.lastTickAt
                    ? formatDuration(Date.now() - loop.lastTickAt.getTime())
                    : "never";
                const modeLabel =
                    loop.mode.kind === "count"
                        ? `${loop.remaining}/${loop.mode.kind === "count" ? loop.mode.count : 0}`
                        : loop.humanDescription;
                const completionLabel =
                    loop.completionPromise !== null ? " · auto-stop" : "";
                const tickLabel = `${loop.ticksFired} ticks · last ${elapsed}${completionLabel}`;

                return {
                    value: String(loop.id),
                    label: loop.prompt || "(no prompt)",
                    description: `${modeLabel} · ${tickLabel}`,
                };
            });

            loopItems.push({
                value: "stop-all",
                label: "Stop all loops",
                description: `${loops.length} active loop(s)`,
            });

            loopItems.push({
                value: "done",
                label: "Close",
                description: "Escape",
            });

            const selectList = new SelectList(
                loopItems,
                Math.min(loopItems.length + 2, 15),
                {
                    selectedPrefix: (text: string) => theme.fg("accent", text),
                    selectedText: (text: string) => theme.bold(text),
                    description: (text: string) => theme.fg("dim", text),
                    scrollInfo: (text: string) => theme.fg("muted", text),
                    noMatch: (text: string) => theme.fg("muted", text),
                }
            );

            selectList.onSelect = (item) => {
                if (item.value === "done") {
                    done(undefined);
                    return;
                }
                if (item.value === "stop-all") {
                    const count = stopAll();
                    done(undefined);
                    ctx.ui.notify(`Stopped ${count} loop(s).`, "info");
                    return;
                }
                // Stop a specific loop
                const id = parseInt(item.value, 10);
                if (removeLoop(id)) {
                    // Re-render the list
                    if (loops.length === 0) {
                        done(undefined);
                        ctx.ui.notify("All loops stopped.", "info");
                        return;
                    }
                    // Remove the stopped item from the list
                    const idx = loopItems.findIndex(
                        (li) => li.value === item.value
                    );
                    if (idx !== -1) loopItems.splice(idx, 1);
                    selectList.setFilter("");
                    container.invalidate();
                    ctx.ui.notify(`Loop #${id} stopped.`, "info");
                }
            };

            selectList.onCancel = () => {
                done(undefined);
            };

            container.addChild(selectList);

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    selectList.handleInput(data);
                },
            };
        });
    }

    // --- Keyboard shortcut ---

    pi.registerShortcut("ctrl+l", {
        description: "Open loop manager",
        handler: async (_ctx) => {
            // Shortcuts receive ExtensionContext, not ExtensionCommandContext.
            // We can't open the full TUI from here without a command context.
            // Instead, show a notification summary.
            if (loops.length === 0) {
                _ctx.ui.notify(
                    "No active loops. Use /loop to start one.",
                    "info"
                );
                return;
            }
            const lines = loops.map(
                (l) =>
                    `  #${l.id}: "${l.prompt || "(no prompt)"}" — ${l.humanDescription} (${l.ticksFired} ticks)`
            );
            _ctx.ui.notify(
                `Active loops:\n${lines.join("\n")}\nUse /loop list to manage.`,
                "info"
            );
        },
    });

    // --- Command registration ---

    pi.registerCommand("loop", {
        description:
            'Loop a prompt: count (5), duration (5m), cron (*/5 * * * *), or infinite (no prefix). Flags: --completion-promise[="text"]',
        handler: async (args, ctx: ExtensionCommandContext) => {
            const trimmed = args.trim().toLowerCase();

            if (trimmed === "list") {
                await showLoopManager(ctx);
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

            let parsed = parseLoopArgs(args.trim());

            // --- Context inference for missing prompt and/or interval ---
            const needsPrompt = !parsed.prompt.trim();
            const needsInterval = parsed.mode.kind === "infinite" && !trimmed;
            const needsBoth = needsPrompt && needsInterval;

            if (needsPrompt || needsInterval) {
                const entries = ctx.sessionManager.getEntries();
                const inferredInterval = inferInterval(entries);
                const inferredPrompt = inferPrompt(entries);

                if (needsBoth) {
                    // Neither prompt nor mode provided — infer both
                    const options = [
                        `${inferredInterval.human} — "${inferredPrompt}" (${inferredInterval.label})`,
                        `5m — "${inferredPrompt}" (default)`,
                        "proactive (infinite, tick on agent_end)",
                    ];
                    const choice = await ctx.ui.select(
                        "No prompt or interval given. Infer from context?",
                        options
                    );
                    if (choice === undefined) return;

                    if (choice === options[0]) {
                        parsed = {
                            mode: {
                                kind: "interval",
                                ms: inferredInterval.ms,
                                human: inferredInterval.human,
                            },
                            prompt: inferredPrompt,
                            completionPromise: parsed.completionPromise,
                        };
                    } else if (choice === options[1]) {
                        parsed = {
                            mode: {
                                kind: "interval",
                                ms: 300_000,
                                human: "5m",
                            },
                            prompt: inferredPrompt,
                            completionPromise: parsed.completionPromise,
                        };
                    } else {
                        parsed = {
                            mode: { kind: "infinite" },
                            prompt: inferredPrompt,
                            completionPromise: parsed.completionPromise,
                        };
                    }
                } else if (needsInterval) {
                    // Prompt given but no interval (e.g. "/loop check the build")
                    const options = [
                        `${inferredInterval.human} (${inferredInterval.label})`,
                        "5m (default)",
                        "proactive (infinite, tick on agent_end)",
                    ];
                    const choice = await ctx.ui.select(
                        `No interval given for "${parsed.prompt}". How often?`,
                        options
                    );
                    if (choice === undefined) return;

                    if (choice === options[0]) {
                        parsed = {
                            ...parsed,
                            mode: {
                                kind: "interval",
                                ms: inferredInterval.ms,
                                human: inferredInterval.human,
                            },
                        };
                    } else if (choice === options[1]) {
                        parsed = {
                            ...parsed,
                            mode: {
                                kind: "interval",
                                ms: 300_000,
                                human: "5m",
                            },
                        };
                    }
                    // else: keep infinite (proactive)
                } else {
                    // Interval given but no prompt (e.g. "/loop 5m")
                    const choice = await ctx.ui.select(
                        `No prompt given. Use inferred prompt?`,
                        [
                            `Yes: "${inferredPrompt}"`,
                            "No: use empty prompt (timestamp only)",
                        ]
                    );
                    if (choice === undefined) return;

                    if (choice?.startsWith("Yes")) {
                        parsed = { ...parsed, prompt: inferredPrompt };
                    }
                }
            }

            const entry = startLoop(parsed);

            ctx.ui.notify(
                `Loop #${entry.id} started: "${entry.prompt || "(no prompt)"}" ${entry.humanDescription}. Use /loop stop ${entry.id} to cancel.`,
                "info"
            );
        },
    });
}
