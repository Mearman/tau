/**
 * The /tau command — CLI surface for feature toggles.
 *
 * Parses arguments, provides inline autocomplete, and delegates to the
 * appropriate handler (set, get, unset, or TUI for bare invocation).
 */

import { FEATURE_REGISTRY, isKnownFeature } from "./features-registry.ts";

// ─── Types ──────────────────────────────────────────────────────────

export type ScopeName =
    | "temporary"
    | "thread"
    | "session"
    | "cwd"
    | "project"
    | "global";

const SCOPE_NAMES: ScopeName[] = [
    "temporary",
    "thread",
    "session",
    "cwd",
    "project",
    "global",
];

export type ParsedArgs =
    | { kind: "list" }
    | { kind: "get"; id: string }
    | { kind: "set"; id: string; value: boolean; scope: ScopeName }
    | { kind: "unset"; id: string; scope: ScopeName }
    | { kind: "error"; message: string };

// ─── Arg parser ─────────────────────────────────────────────────────

/**
 * Parse the raw argument string from `/tau <args>` into a structured
 * object. Pure function — no side effects.
 */
export function parseTauArgs(raw: string): ParsedArgs {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);

    if (tokens.length === 0) return { kind: "list" };

    // First token must be "features"
    if (tokens[0] !== "features") {
        // Bare invocation like `/tau` or `/tau something-unknown`
        if (tokens.length === 1 && tokens[0] !== "features") {
            // Not a features subcommand — could be a future tau
            // subcommand. For now, treat as list (opens TUI).
            return { kind: "list" };
        }
    }

    // /tau features (no further args) → TUI
    if (tokens.length === 1) return { kind: "list" };

    const verb = tokens[1];

    if (verb === "set") {
        return parseSet(tokens.slice(2));
    }
    if (verb === "get") {
        return parseGet(tokens.slice(2));
    }
    if (verb === "unset") {
        return parseUnset(tokens.slice(2));
    }

    return { kind: "error", message: `unknown verb '${verb}'` };
}

function parseSet(tokens: string[]): ParsedArgs {
    const id = tokens[0];
    if (!id) return { kind: "error", message: "missing feature id" };
    if (!isKnownFeature(id)) {
        return { kind: "error", message: `unknown feature '${id}'` };
    }

    const valueStr = tokens[1];
    if (!valueStr) {
        return { kind: "error", message: "missing value (on or off)" };
    }
    if (valueStr !== "on" && valueStr !== "off") {
        return {
            kind: "error",
            message: `invalid value '${valueStr}' — expected on or off`,
        };
    }
    const value = valueStr === "on";

    // Parse optional --scope
    try {
        const scope = parseScope(tokens.slice(2)) ?? "temporary";
        return { kind: "set", id, value, scope };
    } catch (e) {
        return { kind: "error", message: (e as Error).message };
    }
}

function parseGet(tokens: string[]): ParsedArgs {
    const id = tokens[0];
    if (!id) return { kind: "error", message: "missing feature id" };
    if (!isKnownFeature(id)) {
        return { kind: "error", message: `unknown feature '${id}'` };
    }
    return { kind: "get", id };
}

function parseUnset(tokens: string[]): ParsedArgs {
    const id = tokens[0];
    if (!id) return { kind: "error", message: "missing feature id" };
    if (!isKnownFeature(id)) {
        return { kind: "error", message: `unknown feature '${id}'` };
    }

    try {
        const scope = parseScope(tokens.slice(1)) ?? "temporary";
        return { kind: "unset", id, scope };
    } catch (e) {
        return { kind: "error", message: (e as Error).message };
    }
}

function parseScope(tokens: string[]): ScopeName | undefined {
    if (tokens.length === 0) return undefined;
    if (tokens[0] !== "--scope") {
        throw new Error(`unexpected token '${tokens[0]}'`);
    }
    const scopeStr = tokens[1];
    if (!scopeStr) {
        throw new Error("missing scope after --scope");
    }
    if (!SCOPE_NAMES.includes(scopeStr as ScopeName)) {
        throw new Error(
            `unknown scope '${scopeStr}' — expected ${SCOPE_NAMES.join(", ")}`
        );
    }
    return scopeStr as ScopeName;
}

// ─── Autocomplete ───────────────────────────────────────────────────

export interface AutocompleteItem {
    value: string;
    label: string;
}

/**
 * Return inline autocomplete suggestions for the current arg string.
 * Returns null when there are no completions to offer (command is
 * complete or unrecognised).
 */
export function getTauCompletions(prefix: string): AutocompleteItem[] | null {
    const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
    const endsWithSpace = prefix.endsWith(" ");

    // Position 0: suggest "features"
    if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
        const partial = tokens[0] ?? "";
        if (partial === "" || "features".startsWith(partial)) {
            return [{ value: "features", label: "features" }];
        }
        return null;
    }

    // tokens[0] must be "features" from here on
    if (tokens[0] !== "features") return null;

    // Position 1: suggest verbs
    if (tokens.length === 1 && endsWithSpace) {
        return [
            { value: "set", label: "set <id> on|off [--scope <s>]" },
            { value: "get", label: "get <id>" },
            { value: "unset", label: "unset <id> [--scope <s>]" },
        ];
    }

    const verb = tokens[1];

    // Partial verb
    if (tokens.length === 2 && !endsWithSpace) {
        const partial = verb;
        const verbs = ["set", "get", "unset"];
        const matches = verbs.filter((v) => v.startsWith(partial));
        if (matches.length === 0) return null;
        return matches.map((v) => ({ value: v, label: v }));
    }

    // Verb-specific completions
    if (verb === "set") {
        return completionsForSet(tokens, endsWithSpace);
    }
    if (verb === "get" || verb === "unset") {
        return completionsForFeatureId(tokens, endsWithSpace, 2);
    }

    return null;
}

function completionsForSet(
    tokens: string[],
    endsWithSpace: boolean
): AutocompleteItem[] | null {
    // tokens: [features, set, ...]
    const rest = tokens.slice(2);

    // Need feature id
    if (rest.length === 0 || (rest.length === 1 && !endsWithSpace)) {
        const partial = rest[0] ?? "";
        return featureIdCompletions(partial);
    }

    // Need value (on/off)
    if (rest.length === 1 && endsWithSpace) {
        return [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
        ];
    }
    if (rest.length === 2 && !endsWithSpace) {
        const partial = rest[1];
        const values = ["on", "off"].filter((v) => v.startsWith(partial));
        if (values.length === 0) return null;
        return values.map((v) => ({ value: v, label: v }));
    }

    // After value, suggest --scope
    if (
        (rest.length === 2 && endsWithSpace) ||
        (rest.length === 3 && rest[2] === "--scope" && endsWithSpace)
    ) {
        // Check if --scope is already typed
        if (rest.length === 2 && endsWithSpace) {
            return [{ value: "--scope", label: "--scope <scope>" }];
        }
        // After "--scope "
        return SCOPE_NAMES.map((s) => ({ value: s, label: s }));
    }

    // Partial scope name
    if (rest.length === 4 && !endsWithSpace) {
        const partial = rest[3];
        const matches = SCOPE_NAMES.filter((s) => s.startsWith(partial));
        if (matches.length === 0) return null;
        return matches.map((s) => ({ value: s, label: s }));
    }

    // Complete — no more completions
    return null;
}

function completionsForFeatureId(
    tokens: string[],
    endsWithSpace: boolean,
    idIndex: number
): AutocompleteItem[] | null {
    const rest = tokens.slice(idIndex);

    if (rest.length === 0 || (rest.length === 1 && !endsWithSpace)) {
        const partial = rest[0] ?? "";
        return featureIdCompletions(partial);
    }

    // After id, if unset, suggest --scope
    if (tokens[1] === "unset" && rest.length === 1 && endsWithSpace) {
        return [{ value: "--scope", label: "--scope <scope>" }];
    }

    // After --scope for unset
    if (
        tokens[1] === "unset" &&
        rest.length === 2 &&
        rest[1] === "--scope" &&
        endsWithSpace
    ) {
        return SCOPE_NAMES.map((s) => ({ value: s, label: s }));
    }

    // Partial scope name for unset
    if (tokens[1] === "unset" && rest.length === 3 && !endsWithSpace) {
        const partial = rest[2];
        const matches = SCOPE_NAMES.filter((s) => s.startsWith(partial));
        if (matches.length === 0) return null;
        return matches.map((s) => ({ value: s, label: s }));
    }

    return null;
}

function featureIdCompletions(partial: string): AutocompleteItem[] | null {
    const matches = FEATURE_REGISTRY.filter((f) => f.id.startsWith(partial));
    if (matches.length === 0) return null;
    return matches.map((f) => ({ value: f.id, label: f.label }));
}
