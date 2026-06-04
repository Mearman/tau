/**
 * Provider selection for the web-search feature.
 *
 * Auto-selection priority (when provider is "auto"):
 *   1. claude     (ANTHROPIC_API_KEY)
 *   2. brave      (BRAVE_SEARCH_API_KEY)
 *   3. duckduckgo (always available, zero config)
 *
 * A specific provider can be requested by name. If its required
 * credentials are not available, an error is thrown.
 */

import type { SearchProvider } from "./types.ts";
import { ClaudeSearchProvider, isClaudeAvailable } from "./claude.ts";
import { BraveSearchProvider } from "./brave.ts";
import { DuckDuckGoSearchProvider } from "./duckduckgo.ts";

/**
 * Select the best available search provider based on environment.
 *
 * Returns the highest-priority provider whose auth is available,
 * falling back to DuckDuckGo (zero config).
 *
 * Priority: Claude (SDK or API key) > Brave (API key) > DuckDuckGo (always).
 */
export function selectProvider(): SearchProvider {
    if (isClaudeAvailable()) {
        return new ClaudeSearchProvider();
    }
    if (process.env.BRAVE_SEARCH_API_KEY) {
        return new BraveSearchProvider();
    }
    return new DuckDuckGoSearchProvider();
}

/**
 * Select a specific search provider by name.
 *
 * Throws if the requested provider's credentials are not available.
 */
export function selectProviderByName(name: string): SearchProvider {
    switch (name) {
        case "claude":
            if (!isClaudeAvailable()) {
                throw new Error(
                    "Claude search provider not available. Set ANTHROPIC_API_KEY."
                );
            }
            return new ClaudeSearchProvider();
        case "brave":
            if (!process.env.BRAVE_SEARCH_API_KEY) {
                throw new Error(
                    "Brave search provider not available. Set BRAVE_SEARCH_API_KEY."
                );
            }
            return new BraveSearchProvider();
        case "duckduckgo":
            return new DuckDuckGoSearchProvider();
        default:
            throw new Error(
                `Unknown search provider: ${name}. ` +
                    "Use 'auto', 'claude', 'brave', or 'duckduckgo'."
            );
    }
}
