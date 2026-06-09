/**
 * Context Files feature — discovers project instruction files across
 * multiple directories and formats, with @include resolution, frontmatter
 * paths, and HTML comment stripping.
 *
 * Modelled on Claude Code's claudemd.ts but extended for pi's dual
 * AGENTS.md / CLAUDE.md support and .agents/ directory conventions.
 *
 * File types discovered per directory (root → cwd):
 *
 *   AGENTS.md              Project  (checked in)
 *   CLAUDE.md              Project  (checked in)
 *   AGENTS.local.md        Local    (private, not checked in)
 *   CLAUDE.local.md        Local    (private, not checked in)
 *   .agents/AGENTS.md      Project  (checked in)
 *   .agents/rules/*.md     Project  (conditional via paths: frontmatter)
 *   .claude/CLAUDE.md      Project  (checked in, Claude Code compat)
 *   .claude/rules/*.md     Project  (conditional via paths: frontmatter)
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Lexer, type Token } from "marked";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

// ─── Types ───────────────────────────────────────────────────────────

export type ContextFileType = "Project" | "Local";

export interface ContextFile {
    /** Absolute path on disk */
    path: string;
    /** File content (after frontmatter extraction and comment stripping) */
    content: string;
    /** Project or Local */
    type: ContextFileType;
    /** Glob patterns from frontmatter `paths:` field */
    globs?: string[];
    /** Absolute path of the file that @include'd this one */
    parent?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Max recursion depth for @include chains */
const MAX_INCLUDE_DEPTH = 5;

/** Text file extensions allowed for @include directives */
const TEXT_FILE_EXTENSIONS = new Set([
    ".md",
    ".txt",
    ".text",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".py",
    ".pyi",
    ".pyw",
    ".rb",
    ".erb",
    ".rake",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".c",
    ".cpp",
    ".cc",
    ".cxx",
    ".h",
    ".hpp",
    ".hxx",
    ".cs",
    ".swift",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".bat",
    ".cmd",
    ".env",
    ".ini",
    ".cfg",
    ".conf",
    ".config",
    ".properties",
    ".sql",
    ".graphql",
    ".gql",
    ".proto",
    ".vue",
    ".svelte",
    ".astro",
    ".ejs",
    ".hbs",
    ".pug",
    ".jade",
    ".php",
    ".pl",
    ".pm",
    ".lua",
    ".r",
    ".R",
    ".dart",
    ".ex",
    ".exs",
    ".erl",
    ".hrl",
    ".clj",
    ".cljs",
    ".cljc",
    ".edn",
    ".hs",
    ".lhs",
    ".elm",
    ".ml",
    ".mli",
    ".f",
    ".f90",
    ".f95",
    ".for",
    ".cmake",
    ".make",
    ".makefile",
    ".gradle",
    ".sbt",
    ".rst",
    ".adoc",
    ".asciidoc",
    ".org",
    ".tex",
    ".latex",
    ".lock",
    ".log",
    ".diff",
    ".patch",
]);

// ─── Frontmatter ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Parse frontmatter from markdown content, extracting `paths:` globs.
 * Returns the content without frontmatter and optional glob patterns.
 */
export function parseFrontmatter(raw: string): {
    content: string;
    globs?: string[];
} {
    const match = raw.match(FRONTMATTER_RE);
    if (!match) return { content: raw };

    const frontmatterText = match[1] ?? "";
    const body = raw.slice(match[0].length);

    // Extract paths: field — handle both comma-separated string and YAML list
    const pathsMatch = frontmatterText.match(/^paths:\s*(.+)$/m);
    if (!pathsMatch) return { content: body };

    const rawPaths = pathsMatch[1]?.trim();
    if (!rawPaths) return { content: body };

    const globs = splitPaths(rawPaths).filter((p) => p.length > 0);

    // Match-all pattern means no filtering needed
    if (globs.length === 0 || globs.every((p) => p === "**")) {
        return { content: body };
    }

    return { content: body, globs };
}

/**
 * Split a comma-separated paths value, respecting brace groups.
 * Handles: "a, b" and "src/*.{ts,tsx}"
 */
function splitPaths(input: string): string[] {
    const parts: string[] = [];
    let current = "";
    let braceDepth = 0;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "{") {
            braceDepth++;
            current += ch;
        } else if (ch === "}") {
            braceDepth--;
            current += ch;
        } else if (ch === "," && braceDepth === 0) {
            const trimmed = current.trim();
            if (trimmed) parts.push(trimmed);
            current = "";
        } else {
            current += ch;
        }
    }

    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);

    // Expand brace patterns
    return parts.flatMap(expandBraces);
}

function expandBraces(pattern: string): string[] {
    const match = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/);
    if (!match) return [pattern];

    const prefix = match[1] ?? "";
    const alts = match[2] ?? "";
    const suffix = match[3] ?? "";

    return alts
        .split(",")
        .map((a) => a.trim())
        .flatMap((alt) => expandBraces(prefix + alt + suffix));
}

// ─── HTML comment stripping ──────────────────────────────────────────

/**
 * Strip block-level HTML comments from markdown content.
 * Uses the marked lexer to identify html tokens, preserving
 * comments inside code blocks and inline code.
 */
export function stripHtmlComments(content: string): string {
    if (!content.includes("<!--")) return content;

    const tokens = new Lexer({ gfm: false }).lex(content);
    const commentSpan = /<!--[\s\S]*?-->/g;
    let result = "";

    for (const token of tokens) {
        if (token.type === "html") {
            const trimmed = (token.raw ?? "").trimStart();
            if (trimmed.startsWith("<!--") && trimmed.includes("-->")) {
                const residue = (token.raw ?? "").replace(commentSpan, "");
                if (residue.trim().length > 0) {
                    result += residue;
                }
                continue;
            }
        }
        result += token.raw ?? "";
    }

    return result;
}

// ─── @include resolution ─────────────────────────────────────────────

/**
 * Extract @include paths from content using the marked lexer.
 *
 * Walks all token trees (paragraphs, list items, links, etc.) looking
 * for text nodes containing `@path` patterns. This handles:
 *
 *   @./relative.md                          — bare include
 *   [label @./path.md](./path.md)            — markdown link + include
 *   [@./path.md](./path.md)                  — link text is the include
 *
 * Matches Claude Code's extractIncludePathsFromTokens behaviour:
 * recurses into all child token arrays, skips code/codespan tokens,
 * and processes html comment residue.
 */
export function extractIncludePaths(
    content: string,
    basePath: string
): string[] {
    const tokens = new Lexer({ gfm: false }).lex(content);
    const found = new Set<string>();

    const includeRe = /(?:^|\s)@((?:[^\s\\]|\\ )+)/gm;
    const commentSpan = /<!--[\s\S]*?-->/g;

    function extractFromText(text: string): void {
        let m: RegExpExecArray | null;
        while ((m = includeRe.exec(text)) !== null) {
            let p = m[1];
            if (!p) continue;

            // Strip fragment identifiers
            const hashIdx = p.indexOf("#");
            if (hashIdx !== -1) p = p.substring(0, hashIdx);
            if (!p) continue;

            // Unescape spaces
            p = p.replace(/\\ /g, " ");

            // Validate: must look like a path
            const isValid =
                p.startsWith("./") ||
                p.startsWith("~/") ||
                (p.startsWith("/") && p !== "/") ||
                (!p.startsWith("@") &&
                    !/^[#%^&*()]+/.test(p) &&
                    /^[a-zA-Z0-9._-]/.test(p));

            if (!isValid) continue;

            found.add(resolveIncludePath(p, basePath));
        }
    }

    function processElements(elements: Token[]): void {
        for (const el of elements) {
            // Skip code blocks and inline code
            if (el.type === "code" || el.type === "codespan") continue;

            // HTML comment residue may contain @paths
            if (el.type === "html") {
                const raw = el.raw ?? "";
                const trimmed = raw.trimStart();
                if (trimmed.startsWith("<!--") && trimmed.includes("-->")) {
                    const residue = raw.replace(commentSpan, "");
                    if (residue.trim().length > 0) {
                        extractFromText(residue);
                    }
                }
                continue;
            }

            // Process text nodes
            if (el.type === "text" && typeof el.text === "string") {
                extractFromText(el.text);
            }

            // Recurse into child tokens (links, list items, etc.)
            if (
                "tokens" in el &&
                Array.isArray((el as { tokens?: Token[] }).tokens)
            ) {
                processElements((el as { tokens: Token[] }).tokens);
            }

            // List items may be in an `items` array
            if (
                "items" in el &&
                Array.isArray((el as { items?: Token[] }).items)
            ) {
                processElements((el as { items: Token[] }).items);
            }
        }
    }

    processElements(tokens);
    return [...found];
}

function resolveIncludePath(raw: string, basePath: string): string {
    if (raw.startsWith("~/")) {
        return path.resolve(homedir(), raw.slice(2));
    }
    if (raw.startsWith("/")) {
        return path.resolve(raw);
    }
    // ./path or bare path — resolve relative to the including file
    return path.resolve(path.dirname(basePath), raw);
}

/**
 * Recursively process a context file and all its @include references.
 * Returns the main file first, then included files (each with a `parent` field).
 */
function processFile(
    filePath: string,
    type: ContextFileType,
    processed: Set<string>,
    depth: number = 0,
    parent?: string
): ContextFile[] {
    const normalised = path.resolve(filePath);

    if (processed.has(normalised) || depth >= MAX_INCLUDE_DEPTH) return [];

    // Check extension is text
    const ext = path.extname(filePath).toLowerCase();
    if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) return [];

    if (!fs.existsSync(normalised)) return [];

    // Resolve symlinks so the same file reached via different symlink
    // paths is only loaded once. Track both the original and real path.
    let realPath: string;
    try {
        realPath = fs.realpathSync(normalised);
    } catch {
        return [];
    }
    if (processed.has(realPath)) return [];

    processed.add(normalised);
    processed.add(realPath);

    let raw: string;
    try {
        raw = fs.readFileSync(normalised, "utf-8");
    } catch {
        return [];
    }

    if (!raw.trim()) return [];

    // Parse frontmatter
    const { content: withoutFrontmatter, globs } = parseFrontmatter(raw);

    // Strip HTML comments
    const content = stripHtmlComments(withoutFrontmatter);

    if (!content.trim()) return [];

    const result: ContextFile[] = [
        { path: normalised, content, type, globs, parent },
    ];

    // Resolve @includes
    const includePaths = extractIncludePaths(content, normalised);
    for (const incPath of includePaths) {
        const included = processFile(
            incPath,
            type,
            processed,
            depth + 1,
            normalised
        );
        result.push(...included);
    }

    return result;
}

// ─── Directory scanning ──────────────────────────────────────────────

/**
 * Recursively find all .md files in a directory.
 * Returns relative paths from basePath.
 */
export function findMarkdownFiles(
    dir: string,
    basePath: string = ""
): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        const rel = basePath ? `${basePath}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);

        // Resolve symlinks to determine actual type
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
            try {
                const stat = fs.statSync(fullPath);
                isDir = stat.isDirectory();
                isFile = stat.isFile();
            } catch {
                continue;
            }
        }

        if (isDir) {
            results.push(...findMarkdownFiles(fullPath, rel));
        } else if (isFile && entry.name.endsWith(".md")) {
            results.push(rel);
        }
    }

    return results;
}

/**
 * Load all context files from a single directory.
 * Checks top-level files, .agents/ subdirectory, and .claude/ subdirectory.
 */
function loadContextFilesFromDir(dir: string): ContextFile[] {
    const processed = new Set<string>();
    const files: ContextFile[] = [];

    // Top-level project files (first match wins per Claude Code convention)
    const projectCandidates = ["AGENTS.md", "CLAUDE.md"];
    for (const name of projectCandidates) {
        const result = processFile(path.join(dir, name), "Project", processed);
        if (result.length > 0) {
            files.push(...result);
            break; // first match wins
        }
    }

    // Top-level local files (first match wins)
    const localCandidates = ["AGENTS.local.md", "CLAUDE.local.md"];
    for (const name of localCandidates) {
        const result = processFile(path.join(dir, name), "Local", processed);
        if (result.length > 0) {
            files.push(...result);
            break;
        }
    }

    // .agents/AGENTS.md
    const agentsSub = processFile(
        path.join(dir, ".agents", "AGENTS.md"),
        "Project",
        processed
    );
    files.push(...agentsSub);

    // .agents/rules/*.md
    const agentsRulesDir = path.join(dir, ".agents", "rules");
    if (fs.existsSync(agentsRulesDir)) {
        const ruleFiles = findMarkdownFiles(agentsRulesDir);
        for (const rel of ruleFiles) {
            files.push(
                ...processFile(
                    path.join(agentsRulesDir, rel),
                    "Project",
                    processed
                )
            );
        }
    }

    // .claude/CLAUDE.md
    const claudeSub = processFile(
        path.join(dir, ".claude", "CLAUDE.md"),
        "Project",
        processed
    );
    files.push(...claudeSub);

    // .claude/rules/*.md
    const claudeRulesDir = path.join(dir, ".claude", "rules");
    if (fs.existsSync(claudeRulesDir)) {
        const ruleFiles = findMarkdownFiles(claudeRulesDir);
        for (const rel of ruleFiles) {
            files.push(
                ...processFile(
                    path.join(claudeRulesDir, rel),
                    "Project",
                    processed
                )
            );
        }
    }

    return files;
}

// ─── Main discovery ──────────────────────────────────────────────────

/**
 * Walk from cwd upward to root, collecting all context files.
 * Returns files ordered root → cwd (outermost first, innermost last for
 * highest priority).
 */
export function discoverContextFiles(cwd: string): ContextFile[] {
    const allFiles: ContextFile[] = [];
    const seen = new Set<string>();

    // Collect directories from cwd up to root
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

    // Iterate root → cwd (reverse of collection order)
    for (const dir of dirs.reverse()) {
        const dirFiles = loadContextFilesFromDir(dir);

        // Deduplicate by resolved path (realpath for symlink safety)
        for (const file of dirFiles) {
            let realPath: string;
            try {
                realPath = fs.realpathSync(file.path);
            } catch {
                realPath = file.path;
            }
            if (!seen.has(realPath)) {
                seen.add(realPath);
                seen.add(file.path);
                allFiles.push(file);
            }
        }
    }

    return allFiles;
}

// ─── System prompt formatting ────────────────────────────────────────

function formatContextFiles(files: ContextFile[]): string {
    const sections: string[] = [];

    for (const file of files) {
        const description =
            file.type === "Local"
                ? " (private project instructions, not checked in)"
                : file.globs
                  ? ` (applies to: ${file.globs.join(", ")})`
                  : "";

        const parentNote = file.parent ? `\nIncluded by: ${file.parent}` : "";

        sections.push(
            `<project_instructions path="${file.path}"${description}>${parentNote}\n${file.content}\n</project_instructions>`
        );
    }

    return [
        "Codebase and user instructions are shown below. " +
            "Be sure to adhere to these instructions. " +
            "IMPORTANT: These instructions OVERRIDE default behaviour and you MUST follow them exactly as written.",
        "",
        ...sections,
    ].join("\n\n");
}

// ─── Feature registration ────────────────────────────────────────────

export function registerContextFiles(pi: ExtensionAPI, state: TauState): void {
    let contextFiles: ContextFile[] = [];

    pi.on("session_start", async (_event, ctx) => {
        if (!isFeatureEnabled(state, "instructions")) return;

        contextFiles = discoverContextFiles(ctx.cwd);

        if (contextFiles.length > 0) {
            const projectCount = contextFiles.filter(
                (f) => f.type === "Project"
            ).length;
            const localCount = contextFiles.filter(
                (f) => f.type === "Local"
            ).length;
            const parts: string[] = [];
            if (projectCount > 0) parts.push(`${projectCount} project`);
            if (localCount > 0) parts.push(`${localCount} local`);
            ctx.ui.notify(
                `Loaded ${contextFiles.length} context file(s): ${parts.join(", ")}`,
                "info"
            );
        }
    });

    pi.on("before_agent_start", async (event) => {
        if (contextFiles.length === 0) return;

        return {
            systemPrompt:
                event.systemPrompt + "\n\n" + formatContextFiles(contextFiles),
        };
    });
}
