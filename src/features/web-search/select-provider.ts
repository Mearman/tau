/**
 * Provider selection for the web-search feature.
 *
 * Picks the highest-priority provider whose required environment
 * variable is set. Priority order:
 *   1. claude     (ANTHROPIC_API_KEY)
 *   2. brave      (BRAVE_SEARCH_API_KEY)
 *   3. duckduckgo (always available, zero config)
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
