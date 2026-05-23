/**
 * Context visualisation feature — /context command.
 *
 * Ported from Claude Code's /context command (src/commands/context/,
 * src/utils/analyzeContext.ts, src/utils/contextSuggestions.ts,
 * src/components/ContextVisualization.tsx).
 *
 * Renders a Unicode block grid showing estimated token usage by category,
 * a per-category legend, a tool breakdown, and actionable suggestions.
 *
 * Data sources:
 *   - `ctx.getContextUsage()` — authoritative total + context window
 *   - `ctx.getSystemPrompt()` — system prompt text
 *   - `pi.getAllTools()` — tool definitions (name, description, schema)
 *   - `ctx.sessionManager.getBranch()` — session entries for message breakdown
 *   - `estimateTokens()` — chars/4 heuristic per message
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    SessionEntry,
    ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_COMPACTION_SETTINGS,
    estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, matchesKey } from "@earendil-works/pi-tui";

// ─── Token formatting (mirrors CC formatTokens) ─────────────────────

export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
}

// ─── Rough token estimation for arbitrary strings ────────────────────
// Same heuristic as CC's roughTokenCountEstimation

export function roughTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── Types ───────────────────────────────────────────────────────────

interface ContextCategory {
    name: string;
    tokens: number;
    colour: string;
    /** These tokens are not counted toward context usage */
    isDeferred?: boolean;
}

interface ToolBreakdown {
    name: string;
    callTokens: number;
    resultTokens: number;
}

export interface ContextData {
    categories: ContextCategory[];
    totalTokens: number;
    contextWindow: number;
    percent: number | null;
    model: string;
    toolDefinitions: { name: string; tokens: number }[];
    messageBreakdown: {
        toolCallTokens: number;
        toolResultTokens: number;
        assistantTextTokens: number;
        userTextTokens: number;
        toolCallsByType: ToolBreakdown[];
    };
    autoCompactEnabled: boolean;
    autoCompactThreshold: number | undefined;
}

export interface ContextSuggestion {
    severity: "info" | "warning";
    title: string;
    detail: string;
    savingsTokens?: number;
}

// ─── Tool definition token estimation ────────────────────────────────
// Mirrors CC's countToolDefinitionTokens — estimates from the JSON
// serialisation of name + description + schema.

function estimateToolTokens(tool: ToolInfo): number {
    const parts: string[] = [];
    parts.push(tool.name);
    if (tool.description) parts.push(tool.description);
    if (tool.parameters) {
        try {
            parts.push(JSON.stringify(tool.parameters));
        } catch {
            // schema may not be serialisable
        }
    }
    return roughTokens(parts.join(" "));
}

// ─── Content block helpers ──────────────────────────────────────────

type ContentBlock = {
    type?: string;
    text?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    thinking?: string;
};

function getBlocks(message: AgentMessage): ContentBlock[] {
    const content =
        message && typeof message === "object" && "content" in message
            ? (message as { content?: unknown }).content
            : undefined;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content as ContentBlock[];
    return [];
}

function blockText(block: ContentBlock): string {
    if (typeof block.text === "string") return block.text;
    if (typeof block.thinking === "string") return block.thinking;
    // For toolCall/toolResult blocks, serialise the full payload so the
    // estimation includes arguments and content, not just the name.
    return JSON.stringify(block);
}

// ─── Core analysis (mirrors CC analyzeContextUsage) ──────────────────

export function analyseContext(
    entries: SessionEntry[],
    systemPrompt: string,
    tools: ToolInfo[],
    totalTokens: number | null,
    contextWindow: number,
    modelName: string
): ContextData {
    const categories: ContextCategory[] = [];
    const toolCallMap = new Map<
        string,
        { callTokens: number; resultTokens: number }
    >();

    // ── 1. System prompt ────────────────────────────────────────────
    const systemTokens = roughTokens(systemPrompt);
    if (systemTokens > 0) {
        categories.push({
            name: "System prompt",
            tokens: systemTokens,
            colour: "dim",
        });
    }

    // ── 2. Tool definitions ─────────────────────────────────────────
    let toolDefTotal = 0;
    const toolDefinitions: { name: string; tokens: number }[] = [];
    for (const tool of tools) {
        const tokens = estimateToolTokens(tool);
        toolDefTotal += tokens;
        toolDefinitions.push({ name: tool.name, tokens });
    }
    // Sort by tokens descending
    toolDefinitions.sort((a, b) => b.tokens - a.tokens);
    if (toolDefTotal > 0) {
        categories.push({
            name: "Tools",
            tokens: toolDefTotal,
            colour: "warning",
        });
    }

    // ── 3. Message breakdown (mirrors CC approximateMessageTokens) ──
    let toolCallTokens = 0;
    let toolResultTokens = 0;
    let assistantTextTokens = 0;
    let userTextTokens = 0;

    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (!message || typeof message !== "object") continue;

        const role = (message as { role?: string }).role;
        if (role !== "user" && role !== "assistant") continue;

        // Use estimateTokens for the whole message for accuracy
        const msgTokens = estimateTokens(message);

        // Also do a block-level breakdown for per-tool stats
        const blocks = getBlocks(message);

        if (role === "assistant") {
            let msgToolCallTokens = 0;
            let msgTextTokens = 0;

            for (const block of blocks) {
                const text = blockText(block);
                const tokens = roughTokens(text);
                if (block.type === "toolCall") {
                    msgToolCallTokens += tokens;
                    const toolName =
                        typeof block.name === "string" ? block.name : "unknown";
                    const existing = toolCallMap.get(toolName) ?? {
                        callTokens: 0,
                        resultTokens: 0,
                    };
                    existing.callTokens += tokens;
                    toolCallMap.set(toolName, existing);
                } else {
                    msgTextTokens += tokens;
                }
            }

            // Distribute the more accurate estimateTokens proportionally
            if (msgTokens > 0 && msgToolCallTokens + msgTextTokens > 0) {
                const ratio = msgTokens / (msgToolCallTokens + msgTextTokens);
                toolCallTokens += Math.round(msgToolCallTokens * ratio);
                assistantTextTokens += Math.round(msgTextTokens * ratio);
            }
        }

        if (role === "user") {
            let msgToolResultTokens = 0;
            let msgTextTokens = 0;

            for (const block of blocks) {
                const text = blockText(block);
                const tokens = roughTokens(text);
                if (block.type === "toolResult") {
                    msgToolResultTokens += tokens;
                    const toolName =
                        typeof block.name === "string" ? block.name : "unknown";
                    const existing = toolCallMap.get(toolName) ?? {
                        callTokens: 0,
                        resultTokens: 0,
                    };
                    existing.resultTokens += tokens;
                    toolCallMap.set(toolName, existing);
                } else {
                    msgTextTokens += tokens;
                }
            }

            if (msgTokens > 0 && msgToolResultTokens + msgTextTokens > 0) {
                const ratio = msgTokens / (msgToolResultTokens + msgTextTokens);
                toolResultTokens += Math.round(msgToolResultTokens * ratio);
                userTextTokens += Math.round(msgTextTokens * ratio);
            }
        }
    }

    const messageTokens =
        toolCallTokens +
        toolResultTokens +
        assistantTextTokens +
        userTextTokens;
    if (messageTokens > 0) {
        categories.push({
            name: "Messages",
            tokens: messageTokens,
            colour: "accent",
        });
    }

    // ── Tool breakdown (sorted by total, mirrors CC) ────────────────
    const toolCallsByType = Array.from(toolCallMap.entries())
        .map(([name, { callTokens, resultTokens }]) => ({
            name,
            callTokens,
            resultTokens,
        }))
        .sort(
            (a, b) =>
                b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens)
        );

    // ── Autocompact buffer (mirrors CC) ─────────────────────────────
    const autoCompactEnabled = DEFAULT_COMPACTION_SETTINGS.enabled;
    let autoCompactThreshold: number | undefined;
    if (autoCompactEnabled) {
        autoCompactThreshold =
            contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
        const bufferTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
        categories.push({
            name: "Autocompact buffer",
            tokens: bufferTokens,
            colour: "dim",
        });
    } else {
        // Manual compact buffer (mirrors CC MANUAL_COMPACT_BUFFER_TOKENS = 3000)
        categories.push({
            name: "Compact buffer",
            tokens: 3000,
            colour: "dim",
        });
    }

    // ── Free space ──────────────────────────────────────────────────
    const actualUsage = categories.reduce(
        (sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens),
        0
    );
    const freeTokens = Math.max(0, contextWindow - actualUsage);
    categories.push({
        name: "Free space",
        tokens: freeTokens,
        colour: "dim",
    });

    // Use authoritative total when available
    const finalTotal = totalTokens ?? actualUsage;

    return {
        categories,
        totalTokens: finalTotal,
        contextWindow,
        percent:
            totalTokens !== null
                ? Math.round((totalTokens / contextWindow) * 100)
                : null,
        model: modelName,
        toolDefinitions,
        messageBreakdown: {
            toolCallTokens,
            toolResultTokens,
            assistantTextTokens,
            userTextTokens,
            toolCallsByType,
        },
        autoCompactEnabled,
        autoCompactThreshold,
    };
}

// ─── Context suggestions (mirrors CC contextSuggestions.ts) ──────────

const NEAR_CAPACITY_PERCENT = 80;
const LARGE_TOOL_RESULT_PERCENT = 15;
const LARGE_TOOL_RESULT_TOKENS = 10_000;

export function generateSuggestions(data: ContextData): ContextSuggestion[] {
    const suggestions: ContextSuggestion[] = [];

    // Near capacity
    if ((data.percent ?? 0) >= NEAR_CAPACITY_PERCENT) {
        suggestions.push({
            severity: "warning",
            title: `Context is ${data.percent}% full`,
            detail: data.autoCompactEnabled
                ? "Autocompact will trigger soon, which discards older messages. Use /compact now to control what gets kept."
                : "Autocompact is disabled. Use /compact to free space.",
        });
    }

    // Large tool results
    for (const tool of data.messageBreakdown.toolCallsByType) {
        const total = tool.callTokens + tool.resultTokens;
        const pct = (total / data.contextWindow) * 100;
        if (pct < LARGE_TOOL_RESULT_PERCENT || total < LARGE_TOOL_RESULT_TOKENS)
            continue;

        suggestions.push({
            severity: total > data.contextWindow * 0.2 ? "warning" : "info",
            title: `${tool.name} using ${formatTokens(total)} tokens (${pct.toFixed(0)}%)`,
            detail: getToolSpecificAdvice(tool.name),
            savingsTokens: Math.floor(total * 0.3),
        });
    }

    // Autocompact disabled at 50%+
    if (
        !data.autoCompactEnabled &&
        (data.percent ?? 0) >= 50 &&
        (data.percent ?? 0) < NEAR_CAPACITY_PERCENT
    ) {
        suggestions.push({
            severity: "info",
            title: "Autocompact is disabled",
            detail: "Without autocompact, you may hit context limits and lose the conversation. Use /compact manually.",
        });
    }

    return suggestions.sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "warning" ? -1 : 1;
        return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0);
    });
}

function getToolSpecificAdvice(toolName: string): string {
    switch (toolName) {
        case "bash":
            return "Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files — use read with offset/limit instead.";
        case "read":
            return "Use offset and limit parameters to read only the sections you need. Avoid re-reading entire files.";
        case "grep":
            return "Add more specific patterns or use glob to narrow results. Consider find for file discovery instead.";
        case "web_browse":
            return "Web page content can be very large. Consider extracting only the specific information needed.";
        default:
            return "This tool is consuming a significant portion of context. Consider reducing its output.";
    }
}

// ─── Grid rendering (mirrors CC ContextVisualization) ────────────────

const FILLED = "\u2588"; // █
const LOWER_SEVEN = "\u2589"; // ▉
const LOWER_THREE = "\u258B"; // ▋
const LOWER_ONE = "\u258D"; // ▍
const EMPTY = "\u2591"; // ░

// Adaptive grid: 10×10 for 200k, 20×10 for 1M+
function gridDimensions(contextWindow: number): {
    cols: number;
    rows: number;
} {
    if (contextWindow >= 1_000_000) return { cols: 20, rows: 10 };
    return { cols: 10, rows: 10 };
}

interface GridSquare {
    colour: string;
    symbol: string;
    categoryName: string;
}

export function buildGrid(
    data: ContextData,
    theme: { fg(colour: string, text: string): string }
): { grid: GridSquare[][]; legend: string[] } {
    const { cols, rows } = gridDimensions(data.contextWindow);
    const totalSquares = cols * rows;

    const nonFreeNonReserved = data.categories.filter(
        (c) =>
            c.name !== "Free space" &&
            c.name !== "Autocompact buffer" &&
            c.name !== "Compact buffer" &&
            !c.isDeferred
    );

    const reservedCategory = data.categories.find(
        (c) => c.name === "Autocompact buffer" || c.name === "Compact buffer"
    );

    const squares: GridSquare[] = [];
    let used = 0;

    for (const cat of nonFreeNonReserved) {
        const fraction = cat.tokens / data.contextWindow;
        const count = Math.max(
            1,
            Math.min(Math.round(fraction * totalSquares), totalSquares - used)
        );

        for (let i = 0; i < count; i++) {
            const isLast = i === count - 1;
            const exact = fraction * totalSquares;
            const remainder = exact - Math.floor(exact);

            let symbol = FILLED;
            if (isLast && count > 1) {
                if (remainder < 0.3) symbol = LOWER_ONE;
                else if (remainder < 0.5) symbol = LOWER_THREE;
                else if (remainder < 0.7) symbol = LOWER_SEVEN;
            }

            squares.push({
                colour: cat.colour,
                symbol,
                categoryName: cat.name,
            });
        }
        used += count;
    }

    // Leave room for reserved at the end
    const reservedCount = reservedCategory
        ? Math.max(
              1,
              Math.round(
                  (reservedCategory.tokens / data.contextWindow) * totalSquares
              )
          )
        : 0;
    const freeTarget = totalSquares - reservedCount;

    while (squares.length < freeTarget) {
        squares.push({
            colour: "dim",
            symbol: EMPTY,
            categoryName: "Free space",
        });
    }

    if (reservedCategory) {
        const reservedFraction = reservedCategory.tokens / data.contextWindow;
        const rCount = Math.max(
            1,
            Math.min(
                Math.round(reservedFraction * totalSquares),
                totalSquares - squares.length
            )
        );
        for (let i = 0; i < rCount; i++) {
            squares.push({
                colour: "dim",
                symbol: "\u2593", // ▓
                categoryName: reservedCategory.name,
            });
        }
    }

    // Pad if rounding left gaps
    while (squares.length < totalSquares) {
        squares.push({
            colour: "dim",
            symbol: EMPTY,
            categoryName: "Free space",
        });
    }

    // Trim overflow
    squares.length = totalSquares;

    // Convert to rows
    const grid: GridSquare[][] = [];
    for (let r = 0; r < rows; r++) {
        grid.push(squares.slice(r * cols, (r + 1) * cols));
    }

    // Build legend
    const legend: string[] = [];
    const visibleCats = data.categories.filter(
        (c) => c.tokens > 0 && c.name !== "Free space" && !c.isDeferred
    );
    const maxName = Math.max(
        ...visibleCats.map((c) => c.name.length),
        ...visibleCats.map((c) => c.name.length),
        "Free space".length
    );

    for (const cat of visibleCats) {
        const pct = ((cat.tokens / data.contextWindow) * 100).toFixed(1);
        const sym = theme.fg(cat.colour, FILLED);
        const pad = " ".repeat(maxName - cat.name.length + 1);
        legend.push(
            `${sym} ${cat.name}:${pad}${formatTokens(cat.tokens)} tokens (${pct}%)`
        );
    }

    // Free space
    const freeCat = data.categories.find((c) => c.name === "Free space");
    if (freeCat && freeCat.tokens > 0) {
        const pct = ((freeCat.tokens / data.contextWindow) * 100).toFixed(1);
        const sym = theme.fg("dim", EMPTY);
        const pad = " ".repeat(maxName - "Free space".length + 1);
        legend.push(
            `${sym} Free space:${pad}${formatTokens(freeCat.tokens)} tokens (${pct}%)`
        );
    }

    // Reserved
    if (reservedCategory && reservedCategory.tokens > 0) {
        const pct = (
            (reservedCategory.tokens / data.contextWindow) *
            100
        ).toFixed(1);
        const sym = theme.fg("dim", "\u2593");
        const pad = " ".repeat(maxName - reservedCategory.name.length + 1);
        legend.push(
            `${sym} ${reservedCategory.name}:${pad}${formatTokens(reservedCategory.tokens)} tokens (${pct}%)`
        );
    }

    return { grid, legend };
}

// ─── UI component (mirrors CC ContextVisualization) ──────────────────

class ContextViewComponent implements Component {
    private data: ContextData;
    private suggestions: ContextSuggestion[];
    private theme: { fg(colour: string, text: string): string };
    private cachedLines: string[] | null = null;
    private cachedWidth = 0;

    constructor(
        data: ContextData,
        suggestions: ContextSuggestion[],
        theme: { fg(colour: string, text: string): string }
    ) {
        this.data = data;
        this.suggestions = suggestions;
        this.theme = theme;
    }

    invalidate(): void {
        this.cachedLines = null;
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) {
            return this.cachedLines;
        }

        const lines: string[] = [];
        const { data, theme, suggestions } = this;

        // ── Header ──────────────────────────────────────────────────
        const tokenStr = formatTokens(data.totalTokens);
        const windowStr = formatTokens(data.contextWindow);
        const pctStr = data.percent !== null ? `${data.percent}%` : "estimated";
        lines.push(theme.fg("accent", "Context Usage"));
        lines.push(
            theme.fg(
                "dim",
                `${data.model} · ${tokenStr}/${windowStr} tokens (${pctStr})`
            )
        );
        lines.push("");

        // ── Grid ────────────────────────────────────────────────────
        const { grid, legend } = buildGrid(data, theme);
        for (const row of grid) {
            let line = " ";
            for (const sq of row) {
                line += theme.fg(sq.colour, sq.symbol);
            }
            lines.push(line);
        }
        lines.push("");

        // ── Legend ──────────────────────────────────────────────────
        lines.push(theme.fg("dim", "Estimated usage by category"));
        for (const leg of legend) {
            lines.push(leg);
        }

        // ── Tool definitions detail ─────────────────────────────────
        if (data.toolDefinitions.length > 0) {
            lines.push("");
            lines.push(theme.fg("dim", "Tool definitions:"));
            const topTools = data.toolDefinitions.slice(0, 8);
            for (const tool of topTools) {
                lines.push(
                    theme.fg(
                        "dim",
                        `  └ ${tool.name}: ${formatTokens(tool.tokens)} tokens`
                    )
                );
            }
            if (data.toolDefinitions.length > 8) {
                lines.push(
                    theme.fg(
                        "dim",
                        `  … and ${data.toolDefinitions.length - 8} more`
                    )
                );
            }
        }

        // ── Message breakdown ───────────────────────────────────────
        const mb = data.messageBreakdown;
        lines.push("");
        lines.push(theme.fg("dim", "Message breakdown:"));
        lines.push(
            theme.fg(
                "dim",
                `  Tool calls: ${formatTokens(mb.toolCallTokens)} tokens`
            )
        );
        lines.push(
            theme.fg(
                "dim",
                `  Tool results: ${formatTokens(mb.toolResultTokens)} tokens`
            )
        );
        lines.push(
            theme.fg(
                "dim",
                `  Assistant text: ${formatTokens(mb.assistantTextTokens)} tokens`
            )
        );
        lines.push(
            theme.fg(
                "dim",
                `  User text: ${formatTokens(mb.userTextTokens)} tokens`
            )
        );

        // ── Top tools by usage ──────────────────────────────────────
        const topUsed = mb.toolCallsByType.slice(0, 5);
        if (topUsed.length > 0) {
            lines.push("");
            lines.push(theme.fg("dim", "Top tools by usage:"));
            for (const tool of topUsed) {
                const total = tool.callTokens + tool.resultTokens;
                lines.push(
                    theme.fg(
                        "dim",
                        `  └ ${tool.name}: ${formatTokens(total)} (calls ${formatTokens(tool.callTokens)}, results ${formatTokens(tool.resultTokens)})`
                    )
                );
            }
        }

        // ── Suggestions ─────────────────────────────────────────────
        if (suggestions.length > 0) {
            lines.push("");
            for (const s of suggestions) {
                const icon =
                    s.severity === "warning"
                        ? theme.fg("warning", "⚠")
                        : theme.fg("dim", "💡");
                lines.push(`${icon} ${s.title}`);
                lines.push(theme.fg("dim", `  ${s.detail}`));
            }
        }

        lines.push("");
        lines.push(theme.fg("dim", "Press Enter or Esc to close"));

        this.cachedLines = lines;
        this.cachedWidth = width;
        return lines;
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerContext(pi: ExtensionAPI): void {
    pi.registerCommand("context", {
        description: "Visualise current context usage as a coloured grid",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            const usage = ctx.getContextUsage();
            const systemPrompt = ctx.getSystemPrompt();
            const entries = ctx.sessionManager.getBranch();
            const tools = pi.getAllTools();
            const modelName = ctx.model?.name ?? ctx.model?.id ?? "unknown";
            const contextWindow =
                usage?.contextWindow ??
                (ctx.model as { contextWindow?: number } | undefined)
                    ?.contextWindow ??
                200_000;

            if (!ctx.hasUI) {
                // Non-interactive fallback (mirrors CC contextNonInteractive)
                if (!usage) {
                    ctx.ui.notify(
                        "Context usage not available yet (send a message first)",
                        "warning"
                    );
                    return;
                }
                const tokenStr = usage.tokens ?? "unknown";
                const windowStr = formatTokens(usage.contextWindow);
                const pctStr =
                    usage.percent !== null ? `${usage.percent}%` : "unknown";
                ctx.ui.notify(
                    `Context: ${tokenStr}/${windowStr} tokens (${pctStr})`,
                    "info"
                );
                return;
            }

            const data = analyseContext(
                entries,
                systemPrompt,
                tools,
                usage?.tokens ?? null,
                contextWindow,
                modelName
            );

            const suggestions = generateSuggestions(data);

            await ctx.ui.custom((_tui, theme, _kb, done) => {
                const container = new Container();
                const view = new ContextViewComponent(data, suggestions, theme);
                container.addChild(view);

                return {
                    render(w: number) {
                        return container.render(w);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        if (
                            matchesKey(data, "enter") ||
                            matchesKey(data, "escape")
                        ) {
                            done(undefined);
                        }
                    },
                };
            });
        },
    });
}
