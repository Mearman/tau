/**
 * Lazy loader for the optional `@anthropic-ai/claude-agent-sdk` dependency.
 *
 * The SDK is an optional dependency (it bundles a platform-specific native
 * binary). tau must load and run without it installed; only when the
 * `claude-agent-sdk` provider is actually selected do we import it. This mirrors
 * the existing patchright / cloakbrowser optional-dependency pattern.
 *
 * A cached dynamic import means we pay the resolve cost once per process.
 */

type AgentSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let cached: AgentSdkModule | undefined;

const INSTALL_HINT =
    "@anthropic-ai/claude-agent-sdk is not installed. Install it with:\n" +
    "  cd ~/.pi/agent/extensions/tau && pnpm add -O @anthropic-ai/claude-agent-sdk";

/**
 * Dynamically import (and cache) the Agent SDK. Throws a clear, actionable
 * error if the optional dependency is absent, rather than a bare resolve
 * failure deep in the provider.
 */
export async function loadAgentSdk(): Promise<AgentSdkModule> {
    if (cached) return cached;
    try {
        cached = await import("@anthropic-ai/claude-agent-sdk");
        return cached;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND both indicate a missing dep.
        if (
            message.includes("Cannot find") ||
            message.includes("MODULE_NOT_FOUND") ||
            message.includes("Cannot resolve")
        ) {
            throw new Error(INSTALL_HINT, { cause: error });
        }
        throw error;
    }
}
