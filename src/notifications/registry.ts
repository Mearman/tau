/**
 * Notification provider registry.
 *
 * Maintains the set of available providers and dispatches notifications
 * to all enabled, configured providers.
 */

import type { NotificationProvider, NotificationRequest } from "./types.ts";
import { terminalProvider } from "./terminal.ts";
import { pushoverProvider } from "./pushover.ts";

/** All available providers, keyed by ID. */
const providers = new Map<string, NotificationProvider>();

// Register built-in providers.
for (const provider of [terminalProvider, pushoverProvider]) {
    providers.set(provider.id, provider);
}

/** Register an additional provider (for third-party extensions). */
export function registerProvider(provider: NotificationProvider): void {
    providers.set(provider.id, provider);
}

/** Remove a provider by ID. */
export function unregisterProvider(id: string): void {
    providers.delete(id);
}

/** Look up a provider by ID. */
export function getProvider(id: string): NotificationProvider | undefined {
    return providers.get(id);
}

/** All registered providers in insertion order. */
export function allProviders(): NotificationProvider[] {
    return [...providers.values()];
}

/**
 * Resolve the effective config for a provider by merging
 * environment variables with stored config.
 */
export function resolveProviderConfig(
    provider: NotificationProvider,
    storedConfig: Record<string, string>
): Record<string, string> {
    return provider.resolveConfig(storedConfig);
}

/**
 * Dispatch a notification to all enabled, configured providers.
 *
 * @param enabledProviderIds  IDs of providers the user has enabled.
 * @param providerConfigs     Per-provider stored credential/settings records.
 * @param request             The notification to send.
 */
export function dispatch(
    enabledProviderIds: Set<string>,
    providerConfigs: Record<string, Record<string, string>>,
    request: NotificationRequest
): void {
    for (const id of enabledProviderIds) {
        const provider = providers.get(id);
        if (provider === undefined) continue;
        const stored = providerConfigs[id] ?? {};
        const resolved = provider.resolveConfig(stored);
        if (!provider.isConfigured(resolved)) continue;
        provider.send(request, resolved);
    }
}
