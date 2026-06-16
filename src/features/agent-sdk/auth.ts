/**
 * Auth determinism for the Agent SDK provider.
 *
 * This is the change that protects the actual goal: without it, a stray
 * `ANTHROPIC_API_KEY` in the environment makes the SDK subprocess authenticate
 * with an API key and bill to the per-token "extra usage" pool — the opposite
 * of drawing from the Claude Pro/Max subscription rate-limit pool.
 *
 * The provider calls these helpers around the SDK call:
 *
 *  1. {@link buildSdkEnv} scrubs `ANTHROPIC_API_KEY` from the subprocess env in
 *     subscription mode.
 *  2. After the stream opens, the provider reads `apiKeySource` from the SDK's
 *     `init` system message and calls {@link assertSubscriptionAuth}, which
 *     fails loudly if subscription was requested but an API key was detected.
 *
 * Kept SDK-free (accepts plain strings) so it is fully unit-testable.
 */

import type { AuthMode } from "./settings.ts";

/**
 * `apiKeySource` values reported in the SDK's `init` system message that mean an
 * API key was used — i.e. the subprocess bills to the Console / extra-usage
 * pool rather than the Claude Pro/Max subscription pool. The spec's whole point
 * is to avoid exactly this in subscription mode.
 *
 * Everything else is the subscription path: with `ANTHROPIC_API_KEY` scrubbed
 * (see {@link buildSdkEnv}), the SDK finds no API key and the init message
 * reports `apiKeySource: "none"`; it then falls back to the Claude Code OAuth
 * login in `~/.claude`. So `"none"` (no API key) — not `"oauth"` — is the normal
 * subscription-mode value in practice. `"oauth"` and `undefined` are likewise
 * API-key-free. Only the four values below indicate an API key.
 *
 * (The SDK's `ApiKeySource` type lists `'oauth'` but not `'none'`; the runtime
 * emits `'none'`, so this check keys off the API-key set rather than an
 * allowlist, which is also what the spec's "verify, don't block" note intended.)
 */
const API_KEY_SOURCES: ReadonlySet<string> = new Set([
    "user",
    "project",
    "org",
    "temporary",
]);

/**
 * True when the SDK is NOT using an API key — i.e. subscription/OAuth is in
 * effect. `"none"` (no API key found), `"oauth"`, and `undefined` all qualify;
 * only the {@link API_KEY_SOURCES} values indicate the Console pool.
 */
export function isSubscriptionAuthSource(
    apiKeySource: string | undefined
): boolean {
    if (apiKeySource === undefined) return true;
    return !API_KEY_SOURCES.has(apiKeySource);
}

/**
 * Build the environment for the SDK subprocess.
 *
 * In subscription mode, `ANTHROPIC_API_KEY` is explicitly set to `undefined`,
 * which deletes it from the spawned process's env so the SDK falls back to the
 * OAuth login in `~/.claude`. In API-key mode, the environment is inherited
 * verbatim so a set `ANTHROPIC_API_KEY` is honoured (Console / extra-usage pool).
 */
export function buildSdkEnv(
    authMode: AuthMode
): Record<string, string | undefined> {
    if (authMode === "subscription") {
        return { ...process.env, ANTHROPIC_API_KEY: undefined };
    }
    return { ...process.env };
}

/**
 * Thrown when subscription auth was requested but the SDK picked up an API key.
 * Carries the detected source so the error is actionable.
 */
export class SubscriptionAuthError extends Error {
    readonly detectedSource: string | undefined;
    constructor(detectedSource: string | undefined) {
        super(
            `Claude Agent SDK provider is configured for subscription auth, but ` +
                `the SDK authenticated with an API key ` +
                `(apiKeySource=${
                    detectedSource === undefined
                        ? "unknown"
                        : `'${detectedSource}'`
                }). ` +
                `Unset ANTHROPIC_API_KEY and ensure you are logged in via Claude Code ` +
                `(npx @anthropic-ai/claude-code), or set tau.claudeAgentSdk.authMode ` +
                `to "apiKey" to opt into the extra-usage pool.`
        );
        this.name = "SubscriptionAuthError";
        this.detectedSource = detectedSource;
    }
}

/**
 * Fail loudly if subscription auth was requested but an API key was detected.
 * No-op for API-key mode and when the source has not yet been observed.
 */
export function assertSubscriptionAuth(
    apiKeySource: string | undefined,
    authMode: AuthMode
): void {
    if (authMode !== "subscription") return;
    if (!isSubscriptionAuthSource(apiKeySource)) {
        throw new SubscriptionAuthError(apiKeySource);
    }
}
