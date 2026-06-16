/**
 * Typed provider configuration read from `tau.claudeAgentSdk` in pi's
 * settings.json files.
 *
 * Lives under the established `tau.*` namespace (alongside `tau.features`).
 * Project settings (`<cwd>/.pi/settings.json`) override global settings
 * (`~/.pi/agent/settings.json`).
 *
 * Deliberately free of any `@anthropic-ai/claude-agent-sdk` import — even a
 * type-only one — so this module and its tests compile and run when the
 * optional dependency is absent. `SettingSource` is re-declared locally to
 * match the SDK's literal union without coupling to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which filesystem configuration sources the SDK loads Claude Code settings
 * from (maps to Claude Code's `--setting-sources`). Matches the SDK's
 * `SettingSource` union.
 */
export type SettingSource = "user" | "project" | "local";

/**
 * How the provider authenticates the SDK subprocess.
 *
 * - `"subscription"`: use the Claude Pro/Max login in `~/.claude` and scrub
 *   `ANTHROPIC_API_KEY` from the subprocess env so it draws from the
 *   subscription rate-limit pool. This is the default and the whole point of
 *   the provider.
 * - `"apiKey"`: opt in to the Console / extra-usage pool. Useful for testing
 *   the provider without touching subscription quota.
 */
export type AuthMode = "subscription" | "apiKey";

/**
 * How conversation history is fed to the SDK.
 *
 * - `"flatten"` (default): each turn sends the whole transcript flattened into
 *   one user message. Robust to pi's session tree and compaction; tool
 *   execution stays native to pi (tau's bash override, permissions).
 * - `"session"`: the SDK keeps the real alternating transcript (thinking
 *   signatures, tool_use/tool_result pairs) and each turn we send only the new
 *   user/tool-result messages since the last turn. Avoids flattening assistant
 *   turns. Best for a single linear conversation; a fork or compact resets to a
 *   fresh SDK session (falling back to a flattened seed) because the SDK session
 *   is linear and can't follow pi's tree/compaction.
 */
export type HistoryMode = "flatten" | "session";

export interface AgentSdkSettings {
    authMode: AuthMode;
    mode: HistoryMode;
    /** When set, overrides the default setting-sources passed to the SDK. */
    settingSources?: SettingSource[];
    /** Pass `--strict-mcp-config` so the SDK ignores auto-loaded MCP configs. */
    strictMcpConfig?: boolean;
    /** Append pi's system prompt to Claude Code's preset prompt. */
    appendSystemPrompt?: boolean;
}

const DEFAULT_SETTINGS: AgentSdkSettings = {
    authMode: "subscription",
    mode: "flatten",
};

const NAMESPACE = "claudeAgentSdk";

function isAuthMode(value: unknown): value is AuthMode {
    return value === "subscription" || value === "apiKey";
}

function isHistoryMode(value: unknown): value is HistoryMode {
    return value === "flatten" || value === "session";
}

function isSettingSource(value: unknown): value is SettingSource {
    return value === "user" || value === "project" || value === "local";
}

/** Narrow an unknown to a plain string-keyed object, without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw `tau.claudeAgentSdk` object into typed settings.
 * Returns `undefined` if the block is absent or not an object.
 */
export function parseAgentSdkSettings(
    raw: unknown
): AgentSdkSettings | undefined {
    if (!isRecord(raw)) return undefined;
    const block = raw;

    const out: AgentSdkSettings = { ...DEFAULT_SETTINGS };

    if (isAuthMode(block["authMode"])) {
        out.authMode = block["authMode"];
    }

    if (isHistoryMode(block["mode"])) {
        out.mode = block["mode"];
    }

    const sources = block["settingSources"];
    if (Array.isArray(sources) && sources.every(isSettingSource)) {
        out.settingSources = sources;
    }

    if (typeof block["strictMcpConfig"] === "boolean") {
        out.strictMcpConfig = block["strictMcpConfig"];
    }

    if (typeof block["appendSystemPrompt"] === "boolean") {
        out.appendSystemPrompt = block["appendSystemPrompt"];
    }

    return out;
}

/** Read the `tau.claudeAgentSdk` block from a single settings.json file. */
export function readAgentSdkSettingsFromFile(
    filePath: string
): AgentSdkSettings | undefined {
    if (!existsSync(filePath)) return undefined;
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const tau = parsed["tau"];
    if (!isRecord(tau)) return undefined;
    return parseAgentSdkSettings(tau[NAMESPACE]);
}

/**
 * Merge global then project settings (project wins). Always returns a complete
 * settings object because `authMode` has a default.
 *
 * `paths` overrides the default global/project file locations and exists for
 * tests; callers omit it to use the real `~/.pi/agent/settings.json` and
 * `<cwd>/.pi/settings.json`.
 */
export function loadAgentSdkSettings(
    cwd: string,
    paths?: { global?: string; project?: string }
): AgentSdkSettings {
    const globalPath =
        paths?.global ?? join(homedir(), ".pi", "agent", "settings.json");
    const projectPath = paths?.project ?? join(cwd, ".pi", "settings.json");

    const global = readAgentSdkSettingsFromFile(globalPath);
    const project = readAgentSdkSettingsFromFile(projectPath);

    return {
        ...DEFAULT_SETTINGS,
        ...global,
        ...project,
    };
}
