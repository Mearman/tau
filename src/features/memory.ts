/**
 * Memory feature — discovers and auto-loads `MEMORY.md` from `.agents/memory/`
 * and `.claude/memory/` at all scopes, mirroring Claude Code's memdir
 * pattern.
 *
 * Filesystem is the source of truth. Topic files (each with frontmatter)
 * are not pre-loaded; the model reads them on demand using the index
 * entries as discovery hooks.
 *
 * The four-type taxonomy (user | feedback | project | reference) and the
 * "What NOT to save" guidance are ported from `claude-code/memdir/memdir.ts`
 * with the prompt section condensed for tau's budget.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import { dedupeByCanonicalName } from "./context-files.ts";

// ─── Constants ───────────────────────────────────────────────────────

export const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";
export const MEMORY_MAX_LINES = 200;
// ~125 chars/line at 200 lines. Catches long-line indexes that slip past
// the line cap.
export const MEMORY_MAX_BYTES = 25_000;
const DIR_EXISTS_GUIDANCE =
    "This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).";

// ─── Types ───────────────────────────────────────────────────────────

export interface MemorySource {
    /** Absolute path of the MEMORY.md file. */
    path: string;
    /** Discovery source. */
    source: "agents" | "claude";
    /** The directory the MEMORY.md lives in (topic files are siblings). */
    memoryDir: string;
}

export interface DiscoveredMemory {
    /** The MEMORY.md that wins per the dedupe helper. */
    entrypoint: MemorySource;
    /** Topic file paths the model can `read` on demand. */
    topicFiles: string[];
    /** Canonical-name conflicts at any level. */
    conflicts: { agents: string; claude: string; canonicalName: string }[];
}

export interface MemoryPromptSection {
    /** The full prompt section, ready to be appended. */
    text: string;
    /** The MEMORY.md path — surfaced so the model knows where to read more. */
    entrypointPath: string;
    /** The memory dir — surfaced so the model knows where to write. */
    memoryDir: string;
    /** Whether MEMORY.md was empty. */
    wasEmpty: boolean;
    /** Whether the entrypoint was truncated. */
    truncated: boolean;
    /** Conflicting entries at any level. */
    conflicts: { agents: string; claude: string; canonicalName: string }[];
}

// ─── Truncation (port of memdir.ts:57-103) ──────────────────────────

/**
 * Truncate MEMORY.md content to the line AND byte caps. Line-truncates
 * first, then byte-truncates at the last newline before the cap. Appends
 * a warning naming which cap fired.
 */
export function truncateMemoryEntrypoint(raw: string): {
    content: string;
    lineCount: number;
    byteCount: number;
    wasLineTruncated: boolean;
    wasByteTruncated: boolean;
} {
    const trimmed = raw.trim();
    const contentLines = trimmed.split("\n");
    const lineCount = contentLines.length;
    const byteCount = trimmed.length;

    const wasLineTruncated = lineCount > MEMORY_MAX_LINES;
    // Post-line-truncation size would understate the warning, so we
    // always check the original byte count.
    const wasByteTruncated = byteCount > MEMORY_MAX_BYTES;

    if (!wasLineTruncated && !wasByteTruncated) {
        return {
            content: trimmed,
            lineCount,
            byteCount,
            wasLineTruncated: false,
            wasByteTruncated: false,
        };
    }

    let truncated = wasLineTruncated
        ? contentLines.slice(0, MEMORY_MAX_LINES).join("\n")
        : trimmed;

    if (truncated.length > MEMORY_MAX_BYTES) {
        const cutAt = truncated.lastIndexOf("\n", MEMORY_MAX_BYTES);
        truncated = truncated.slice(0, cutAt > 0 ? cutAt : MEMORY_MAX_BYTES);
    }

    const reason =
        wasByteTruncated && !wasLineTruncated
            ? `${byteCount} bytes (limit: ${MEMORY_MAX_BYTES}) — index entries are too long`
            : wasLineTruncated && !wasByteTruncated
              ? `${lineCount} lines (limit: ${MEMORY_MAX_LINES})`
              : `${lineCount} lines and ${byteCount} bytes`;

    return {
        content:
            truncated +
            `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
        lineCount,
        byteCount,
        wasLineTruncated,
        wasByteTruncated,
    };
}

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * Walk from cwd up to root, scanning `<dir>/.agents/memory/` and
 * `<dir>/.claude/memory/` at each level. The innermost (cwd) wins.
 *
 * Both `.agents/` and `.claude/` are walked; `.agents/` wins on
 * canonical-name conflict (via `dedupeByCanonicalName`).
 *
 * Returns null if no MEMORY.md was found anywhere.
 */
export function discoverMemory(cwd: string): DiscoveredMemory | null {
    let entrypoint: MemorySource | null = null;
    const allTopicFiles = new Map<string, string>(); // canonicalName -> path
    const allConflicts: DiscoveredMemory["conflicts"] = [];

    // Collect directories from cwd up to root.
    const dirs: string[] = [];
    let current = path.resolve(cwd);
    const root = path.parse(current).root;
    while (true) {
        dirs.push(current);
        if (current === root) break;
        const parent = path.resolve(current, "..");
        if (parent === current) break;
        current = parent;
    }

    // Iterate innermost → outermost (the deepest dir wins on conflict).
    for (const dir of dirs) {
        const agentsMemDir = path.join(dir, ".agents", "memory");
        const claudeMemDir = path.join(dir, ".claude", "memory");

        // Entrypoint: prefer .agents/, fall back to .claude/.
        if (!entrypoint) {
            const agentsEntry = path.join(agentsMemDir, MEMORY_ENTRYPOINT_NAME);
            const claudeEntry = path.join(claudeMemDir, MEMORY_ENTRYPOINT_NAME);
            if (fs.existsSync(agentsEntry)) {
                entrypoint = {
                    path: agentsEntry,
                    source: "agents",
                    memoryDir: agentsMemDir,
                };
            } else if (fs.existsSync(claudeEntry)) {
                entrypoint = {
                    path: claudeEntry,
                    source: "claude",
                    memoryDir: claudeMemDir,
                };
            }
        }

        // Topic files: dedupe by canonical name, .agents/ wins.
        const { rules: deduped, conflicts } = dedupeByCanonicalName(
            agentsMemDir,
            claudeMemDir
        );
        for (const rule of deduped) {
            // path.basename(p, ".md") strips the extension, so the entrypoint
            // "MEMORY.md" becomes "MEMORY". Skip it.
            if (path.basename(rule.path) === MEMORY_ENTRYPOINT_NAME) continue;
            const base = path.basename(rule.path, ".md");
            if (!allTopicFiles.has(base)) {
                allTopicFiles.set(base, rule.path);
            }
        }
        for (const c of conflicts) {
            if (path.basename(c.claude) === MEMORY_ENTRYPOINT_NAME) continue;
            allConflicts.push(c);
        }
    }

    if (!entrypoint) return null;

    return {
        entrypoint,
        topicFiles: Array.from(allTopicFiles.values()),
        conflicts: allConflicts,
    };
}

// ─── Prompt section (port of memdir.ts:199-313, condensed) ──────────

const TYPES_SECTION = `There are several discrete types of memory you can store:

- **user** — facts about the user: their role, expertise, goals, environment. Apply across all conversations.
- **feedback** — corrections and preferences the user has expressed. Lead with the rule, then a **Why:** line and a **How to apply:** line. The model should follow these going forward.
- **project** — project-specific context that isn't derivable from reading the project (deadlines, decisions and their rationale, incidents). Distinguish from anything already in AGENTS.md/CLAUDE.md.
- **reference** — pointers to where information lives in external systems (dashboards, Linear projects, Slack channels, design docs).`;

const WHAT_NOT_TO_SAVE_SECTION = `Do NOT save in memory:

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in AGENTS.md / CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.`;

const HOW_TO_SAVE_SECTION = `Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`
---
name: <memory name, verb-led where possible>
description: <one-line — used to decide relevance in future conversations, so be specific>
type: <user|feedback|project|reference>
---

<body — for feedback/project types, lead with the rule, then **Why:** and **How to apply:** lines>
\`\`\`

**Step 2** — add a pointer to that file in \`${MEMORY_ENTRYPOINT_NAME}\`. \`${MEMORY_ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${MEMORY_ENTRYPOINT_NAME}\`.

- \`${MEMORY_ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MEMORY_MAX_LINES} will be truncated, so keep the index concise.
- Keep the \`name\`, \`description\`, and \`type\` fields in memory files up to date with the content.
- Organise memory semantically by topic, not chronologically.
- Update or remove memories that turn out to be wrong or outdated.
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.`;

const WHEN_TO_ACCESS_SECTION = `When to access memories:

- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: proceed as if ${MEMORY_ENTRYPOINT_NAME} were empty. Do not apply remembered facts, cite, compare against, or mention memory content.`;

const TRUSTING_RECALL_SECTION = `Before recommending from memory:

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation (not just asking about history), verify first.

"The memory says X exists" is not the same as "X exists now."`;

/**
 * Build the prompt section for a discovered memory. The section includes
 * a header, taxonomy, "what not to save", save workflow, access guidance,
 * staleness caveat, and finally the truncated MEMORY.md content (or the
 * "currently empty" fallback).
 */
export function buildMemoryPrompt(
    discovered: DiscoveredMemory
): MemoryPromptSection {
    let raw = "";
    let wasEmpty = false;
    try {
        raw = fs.readFileSync(discovered.entrypoint.path, {
            encoding: "utf-8",
        });
        if (!raw.trim()) wasEmpty = true;
    } catch {
        wasEmpty = true;
    }

    let entryContent: string;
    let truncated = false;
    if (wasEmpty) {
        entryContent = `Your ${MEMORY_ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`;
    } else {
        const t = truncateMemoryEntrypoint(raw);
        entryContent = t.content;
        truncated = t.wasLineTruncated || t.wasByteTruncated;
    }

    const text = [
        "# auto memory",
        "",
        `You have a persistent, file-based memory system at \`${discovered.entrypoint.memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
        "",
        "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviours to avoid or repeat, and the context behind the work.",
        "",
        "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
        "",
        "## Types of memory",
        "",
        TYPES_SECTION,
        "",
        "## What NOT to save in memory",
        "",
        WHAT_NOT_TO_SAVE_SECTION,
        "",
        "## How to save memories",
        "",
        HOW_TO_SAVE_SECTION,
        "",
        WHEN_TO_ACCESS_SECTION,
        "",
        TRUSTING_RECALL_SECTION,
        "",
        "## Searching past context",
        "",
        `When looking for past context, search the memory directory:`,
        "",
        "```",
        `grep -rn "<search term>" ${discovered.entrypoint.memoryDir} --include="*.md"`,
        "```",
        "",
        `## ${MEMORY_ENTRYPOINT_NAME}`,
        "",
        entryContent,
    ].join("\n");

    return {
        text,
        entrypointPath: discovered.entrypoint.path,
        memoryDir: discovered.entrypoint.memoryDir,
        wasEmpty,
        truncated,
        conflicts: discovered.conflicts,
    };
}

// ─── Registration ─────────────────────────────────────────────────────

/**
 * Per-cwd in-memory cache. Keyed on realpath(cwd) so session tree
 * branches that re-enter the same directory do not re-stat.
 */
const memoryCache = new Map<string, MemoryPromptSection | null>();

/**
 * Wires memory discovery into the session lifecycle. Mirrors
 * `registerContextFiles`: discover on `session_start`, append the cached
 * section on `before_agent_start`.
 */
export function registerMemory(pi: ExtensionAPI, state: TauState): void {
    let cached: MemoryPromptSection | null = null;

    pi.on("session_start", async (_event, ctx) => {
        if (!isFeatureEnabled(state, "memory")) {
            cached = null;
            return;
        }

        const discovered = discoverMemory(ctx.cwd);
        if (!discovered) {
            cached = null;
            return;
        }

        cached = buildMemoryPrompt(discovered);

        if (ctx.hasUI) {
            if (cached.conflicts.length > 0) {
                const summary = cached.conflicts
                    .map(
                        (c) =>
                            `.agents/ shadows .claude/ on memory entry "${path.basename(c.canonicalName, ".md")}"`
                    )
                    .join("; ");
                ctx.ui.notify(
                    `${cached.conflicts.length} memory conflict(s): ${summary}`,
                    "warning"
                );
            }
            if (cached.truncated) {
                ctx.ui.notify(
                    `Memory ${MEMORY_ENTRYPOINT_NAME} truncated — keep index entries concise`,
                    "warning"
                );
            }
        }
    });

    pi.on("before_agent_start", async (event, _ctx) => {
        if (!cached) return undefined;
        return {
            systemPrompt: event.systemPrompt + "\n\n" + cached.text,
        };
    });
}

/** Test-only: clear the module-level memory cache. */
export function clearMemoryCache(): void {
    memoryCache.clear();
}
