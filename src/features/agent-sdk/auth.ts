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
 * `apiKeySource` values reported in the SDK's `init` system message that mean
 * the subprocess authenticated via OAuth — i.e. the subscription pool. The
 * other values (`user`, `project`, `org`, `temporary`) all mean an API key was
 * used.
 *
 * Verified against `ApiKeySource` in
 * `@anthropic-ai/claude-agent-sdk` (`sdk.d.ts`).
 */
const OAUTH_API_KEY_SOURCES: ReadonlySet<string> = new Set(["oauth"]);

/**
 * True when the SDK's reported `apiKeySource` corresponds to OAuth / subscription
 * authentication rather than an API key.
 */
export function isSubscriptionAuthSource(
    apiKeySource: string | undefined
): boolean {
    return (
        apiKeySource !== undefined && OAUTH_API_KEY_SOURCES.has(apiKeySource)
    );
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
 * Thrown when subscription auth was requested but the SDK did not authenticate
 * via OAuth. Carries the detected source so the error is actionable.
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
                }, expected 'oauth'). ` +
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
