/**
 * Shared types for the web-search feature.
 *
 * SearchResult is the normalised output every provider returns.
 * SearchProvider is the interface each provider implements.
 */

/** A single search result, independent of which provider produced it. */
export interface SearchResult {
    /** Result title. */
    title: string;
    /** URL of the result. */
    url: string;
    /** Short text snippet from the result page. */
    snippet: string;
}

/** A provider that can perform a web search. */
export interface SearchProvider {
    /** Human-readable provider name (e.g. "claude", "brave", "duckduckgo"). */
    readonly name: string;

    /**
     * Run a search query and return results.
     *
     * @param query - The search query string.
     * @param maxResults - Maximum number of results to return.
     * @returns Array of search results, ordered by relevance.
     * @throws If the search fails (network error, rate limit, etc.).
     */
    search(query: string, maxResults: number): Promise<SearchResult[]>;
}
