/**
 * Pure tool-name and tool-argument mapping between pi and the Claude Agent SDK
 * (which uses Claude Code's canonical tool names and argument shapes).
 *
 * No SDK runtime import here — this module is fully unit-testable. The two
 * directions are:
 *
 *  - SDK -> pi: applied to live tool_use blocks streaming out of the SDK, so
 *    pi executes them with pi's own tool names and arguments.
 *  - pi -> SDK: applied when replaying historical assistant turns back into the
 *    SDK transcript, so Claude sees the names/args it was trained on.
 *
 * Argument shapes were verified against pi's actual tool schemas
 * (pi-coding-agent/dist/core/tools/*): pi `edit` takes `edits: [{oldText,
 * newText}]`, pi `grep` takes `{pattern, path, glob, ignoreCase, literal,
 * context, limit}`, pi `find` takes `{pattern, path, limit}`.
 */

import type { Context, Tool } from "@earendil-works/pi-ai";
import {
    BUILTIN_PI_TOOL_NAMES,
    DEFAULT_SDK_TOOLS,
    MCP_TOOL_PREFIX,
    PI_TO_SDK_TOOL_NAME,
    SDK_TO_PI_TOOL_NAME,
} from "./constants.ts";

/**
 * Map a Claude Code tool name to its pi name. Built-ins use the static table;
 * custom MCP tools strip the {@link MCP_TOOL_PREFIX}; anything else is passed
 * through (the custom-tool map is consulted first for non-builtin pi tools).
 */
export function mapSdkToolNameToPi(
    name: string,
    customToolNameToPi?: ReadonlyMap<string, string>
): string {
    const normalised = name.toLowerCase();
    const builtin = SDK_TO_PI_TOOL_NAME[normalised];
    if (builtin) return builtin;
    if (customToolNameToPi) {
        const mapped =
            customToolNameToPi.get(name) ?? customToolNameToPi.get(normalised);
        if (mapped) return mapped;
    }
    if (normalised.startsWith(MCP_TOOL_PREFIX)) {
        return name.slice(MCP_TOOL_PREFIX.length);
    }
    return name;
}

/**
 * Map a pi tool name to its Claude Code name. Built-ins use the static table
 * (case-insensitive); custom pi tools use the supplied map or fall back to a
 * PascalCase MCP-qualified name.
 */
export function mapPiToolNameToSdk(
    name: string,
    customToolNameToSdk?: ReadonlyMap<string, string>
): string {
    const normalised = name.toLowerCase();
    if (customToolNameToSdk) {
        const mapped =
            customToolNameToSdk.get(name) ??
            customToolNameToSdk.get(normalised);
        if (mapped) return mapped;
    }
    const builtin = PI_TO_SDK_TOOL_NAME[normalised];
    if (builtin) return builtin;
    return toPascalCase(name);
}

/** Naive PascalCase conversion for surfacing custom tool names to the SDK. */
function toPascalCase(name: string): string {
    if (!name) return name;
    // Split on non-alphanumeric boundaries and capitalise each part.
    const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (parts.length === 0) return name;
    return parts
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

type Args = Record<string, unknown>;

/** Pick a value from `args` by the first key that is present. */
function pick(args: Args, ...keys: string[]): unknown {
    for (const key of keys) {
        if (args[key] !== undefined) return args[key];
    }
    return undefined;
}

/**
 * Translate Claude Code tool arguments into pi arguments for native execution.
 * `piToolName` is the already-mapped pi tool name.
 */
export function mapSdkArgsToPi(
    piToolName: string,
    args: Args | undefined
): Args {
    const input = args ?? {};
    switch (piToolName) {
        case "read":
            return {
                path: pick(input, "file_path", "path"),
                offset: input.offset,
                limit: input.limit,
            };
        case "write":
            return {
                path: pick(input, "file_path", "path"),
                content: input.content,
            };
        case "edit":
            // Claude Code Edit is a single old/new pair; pi Edit takes an array.
            return {
                path: pick(input, "file_path", "path"),
                edits: [
                    {
                        oldText: pick(input, "old_string", "oldText"),
                        newText: pick(input, "new_string", "newText"),
                    },
                ],
            };
        case "bash":
            return {
                command: input.command,
                timeout: input.timeout,
            };
        case "grep": {
            const out: Args = {
                pattern: input.pattern,
                path: input.path,
            };
            if (input.glob !== undefined) out.glob = input.glob;
            if (input["-i"] !== undefined) out.ignoreCase = input["-i"];
            if (input.case_insensitive !== undefined)
                out.ignoreCase = input.case_insensitive;
            if (input.literal !== undefined) out.literal = input.literal;
            if (input.context !== undefined) out.context = input.context;
            const limit = pick(input, "head_limit", "limit");
            if (limit !== undefined) out.limit = limit;
            return out;
        }
        case "find":
        case "glob":
            return {
                pattern: input.pattern,
                path: input.path,
            };
        default:
            // Custom tool: arguments pass through unchanged.
            return input;
    }
}

/**
 * Translate pi tool arguments back into Claude Code arguments when replaying a
 * historical assistant turn. Only the shared primitives are translated;
 * custom tools pass through. pi `edit` may carry several edits — only the
 * first is representable in Claude Code's single-pair Edit, which is
 * acceptable for replay (historical context, not re-execution).
 */
export function mapPiArgsToSdk(
    piToolName: string,
    args: Args | undefined
): Args {
    const input = args ?? {};
    switch (piToolName) {
        case "read":
            return {
                file_path: pick(input, "path", "file_path"),
                offset: input.offset,
                limit: input.limit,
            };
        case "write":
            return {
                file_path: pick(input, "path", "file_path"),
                content: input.content,
            };
        case "edit": {
            const edits = Array.isArray(input.edits) ? input.edits : [];
            const first =
                edits.length > 0 &&
                typeof edits[0] === "object" &&
                edits[0] !== null
                    ? (edits[0] as Record<string, unknown>)
                    : {};
            return {
                file_path: pick(input, "path", "file_path"),
                old_string: pick(first, "oldText", "old_string"),
                new_string: pick(first, "newText", "new_string"),
            };
        }
        case "bash":
            return {
                command: input.command,
                timeout: input.timeout,
            };
        case "grep": {
            const out: Args = {
                pattern: input.pattern,
                path: input.path,
            };
            if (input.glob !== undefined) out.glob = input.glob;
            if (input.limit !== undefined) out.head_limit = input.limit;
            return out;
        }
        case "find":
        case "glob":
            return {
                pattern: input.pattern,
                path: input.path,
            };
        default:
            return input;
    }
}

/**
 * Result of splitting pi's active tool set into SDK built-ins and custom tools.
 */
export interface ResolvedSdkTools {
    /** Claude Code built-in tool names to keep in `Options.tools`. */
    sdkTools: string[];
    /** Custom pi tools to surface via the in-process MCP server. */
    customTools: Tool[];
    /** pi tool name (and lower-cased) -> Claude Code MCP-qualified name. */
    customToolNameToSdk: Map<string, string>;
    /** Claude Code MCP-qualified name (and lower-cased) -> pi tool name. */
    customToolNameToPi: Map<string, string>;
}

/**
 * Partition `context.tools` into Claude Code built-ins and custom tools.
 *
 * Built-ins (read/write/edit/bash/grep/find) are listed by their Claude Code
 * names so the model names them correctly and the real schemas reach it.
 * Everything else becomes a custom MCP tool, schema-carried but always denied
 * at execution (pi runs them natively).
 */
export function resolveSdkTools(context: Context): ResolvedSdkTools {
    if (!context.tools || context.tools.length === 0) {
        return {
            sdkTools: [...DEFAULT_SDK_TOOLS],
            customTools: [],
            customToolNameToSdk: new Map(),
            customToolNameToPi: new Map(),
        };
    }

    const sdkTools = new Set<string>();
    const customTools: Tool[] = [];
    const customToolNameToSdk = new Map<string, string>();
    const customToolNameToPi = new Map<string, string>();

    for (const tool of context.tools) {
        const normalised = tool.name.toLowerCase();
        if (BUILTIN_PI_TOOL_NAMES.has(normalised)) {
            const sdkName = PI_TO_SDK_TOOL_NAME[normalised];
            if (sdkName) sdkTools.add(sdkName);
            continue;
        }
        const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
        customTools.push(tool);
        customToolNameToSdk.set(tool.name, sdkName);
        customToolNameToSdk.set(normalised, sdkName);
        customToolNameToPi.set(sdkName, tool.name);
        customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
    }

    return {
        sdkTools: [...sdkTools],
        customTools,
        customToolNameToSdk,
        customToolNameToPi,
    };
}
