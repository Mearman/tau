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

export interface AgentSdkSettings {
    authMode: AuthMode;
    /** When set, overrides the default setting-sources passed to the SDK. */
    settingSources?: SettingSource[];
    /** Pass `--strict-mcp-config` so the SDK ignores auto-loaded MCP configs. */
    strictMcpConfig?: boolean;
    /** Append pi's system prompt to Claude Code's preset prompt. */
    appendSystemPrompt?: boolean;
}

const DEFAULT_SETTINGS: AgentSdkSettings = {
    authMode: "subscription",
};

const NAMESPACE = "claudeAgentSdk";

function isAuthMode(value: unknown): value is AuthMode {
    return value === "subscription" || value === "apiKey";
}

function isSettingSource(value: unknown): value is SettingSource {
    return value === "user" || value === "project" || value === "local";
}

/**
 * Validate a raw `tau.claudeAgentSdk` object into typed settings.
 * Returns `undefined` if the block is absent or not an object.
 */
export function parseAgentSdkSettings(
    raw: unknown
): AgentSdkSettings | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return undefined;
    }
    const block = raw as Record<string, unknown>;

    const out: AgentSdkSettings = { ...DEFAULT_SETTINGS };

    if (isAuthMode(block["authMode"])) {
        out.authMode = block["authMode"];
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
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        return undefined;
    }
    const tau = (parsed as Record<string, unknown>)["tau"];
    if (typeof tau !== "object" || tau === null || Array.isArray(tau)) {
        return undefined;
    }
    return parseAgentSdkSettings((tau as Record<string, unknown>)[NAMESPACE]);
}

/**
 * Merge global then project settings (project wins). Always returns a complete
 * settings object because `authMode` has a default.
 */
export function loadAgentSdkSettings(cwd: string): AgentSdkSettings {
    const globalPath = join(homedir(), ".pi", "agent", "settings.json");
    const projectPath = join(cwd, ".pi", "settings.json");

    const global = readAgentSdkSettingsFromFile(globalPath);
    const project = readAgentSdkSettingsFromFile(projectPath);

    return {
        ...DEFAULT_SETTINGS,
        ...global,
        ...project,
    };
}
