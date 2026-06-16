/**
 * Claude Agent SDK provider — feature registration and wiring.
 *
 * Registers a custom pi provider (`claude-agent-sdk`) whose `streamSimple`
 * routes model calls through the Claude Agent SDK subprocess, so they draw from
 * the Claude Pro/Max subscription rate-limit pool instead of pi's per-token
 * Anthropic-OAuth path. Tool execution stays native to pi (deny-and-reroute).
 *
 * The provider is registered at load (so its models appear in /model), but the
 * optional SDK is only imported when `streamSimple` actually runs — matching
 * tau's patchright / cloakbrowser optional-dependency pattern. The `agent-sdk`
 * feature toggle soft-gates execution: selecting a model while the feature is
 * off returns a clear error stream rather than running.
 */

import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
    createAssistantMessageEventStream,
    getModels,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";
import {
    PROVIDER_API,
    PROVIDER_DISPLAY_NAME,
    PROVIDER_ID,
} from "./constants.ts";
import { loadAgentSdkSettings } from "./settings.ts";
import { streamClaudeAgentSdk } from "./provider.ts";

/**
 * Build the provider's model list from pi-ai's anthropic catalogue, preserving
 * cost (for the usage display) and the thinking-level map. The model `api` is
 * set to the recognised `anthropic-messages` so pi-ai feature detection (e.g.
 * xhigh thinking) keeps working; `provider` is implied by registerProvider.
 */
function buildProviderModels() {
    return getModels("anthropic").map((model) => ({
        id: model.id,
        name: `${model.name} (SDK)`,
        api: PROVIDER_API,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap
            ? { thinkingLevelMap: model.thinkingLevelMap }
            : {}),
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
    }));
}

/**
 * Return a stream that immediately errors, used when the feature toggle is off.
 * Keeping the failure inside the stream protocol lets pi render it like any
 * other provider error instead of an uncaught throw.
 */
function disabledStream(model: Model<Api>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const error: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: "error",
        errorMessage:
            "The Claude Agent SDK provider is disabled. Enable the 'agent-sdk' feature with /tau to use it.",
        timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error });
    stream.end();
    return stream;
}

/**
 * Register the Claude Agent SDK provider. Idempotent under reload (pi replaces
 * the provider's models on re-registration).
 */
export function registerAgentSdkProvider(
    pi: ExtensionAPI,
    state: TauState
): void {
    const streamSimple = (
        model: Model<Api>,
        context: Context,
        options: SimpleStreamOptions | undefined
    ): AssistantMessageEventStream => {
        if (!isFeatureEnabled(state, "agent-sdk")) {
            return disabledStream(model);
        }
        // Settings are read per turn from the cwd's settings.json so changes
        // (e.g. switching authMode) take effect without a reload. The read is
        // two small files; negligible against an SDK subprocess spawn.
        const settings = loadAgentSdkSettings(process.cwd());
        return streamClaudeAgentSdk(model, context, options, {
            settings,
            sdkSessions: state.agentSdkSessions,
        });
    };

    pi.registerProvider(PROVIDER_ID, {
        name: PROVIDER_DISPLAY_NAME,
        api: PROVIDER_API,
        // baseUrl is unused: streamSimple replaces the HTTP transport entirely.
        // A literal placeholder satisfies the "apiKey required when defining
        // models" rule; it is never sent — the SDK authenticates itself.
        baseUrl: PROVIDER_ID,
        apiKey: PROVIDER_ID,
        models: buildProviderModels(),
        streamSimple,
    });
}
