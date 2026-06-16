/**
 * Brave Search API provider.
 *
 * Uses the Brave Search API. Requires BRAVE_SEARCH_API_KEY.
 * Free tier: 2,000 queries/month.
 *
 * API docs: https://api.search.brave.com/app/documentation/web-search
 */

import type { SearchProvider, SearchResult } from "./types.ts";

export class BraveSearchProvider implements SearchProvider {
    readonly name = "brave";

    async search(query: string, maxResults: number): Promise<SearchResult[]> {
        const apiKey = process.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
            throw new Error("BRAVE_SEARCH_API_KEY is not set");
        }

        const url =
            `https://api.search.brave.com/res/v1/web/search?` +
            `q=${encodeURIComponent(query)}&count=${maxResults}`;

        const response = await fetch(url, {
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": apiKey,
            },
        });

        if (!response.ok) {
            throw new Error(`Brave search failed: HTTP ${response.status}`);
        }

        const data = (await response.json()) as {
            web?: {
                results?: Array<{
                    title?: string;
                    url?: string;
                    description?: string;
                }>;
            };
        };

        const webResults = data.web?.results;
        if (!webResults) return [];

        return webResults
            .filter(
                (r): r is typeof r & { title: string; url: string } =>
                    typeof r.title === "string" && typeof r.url === "string"
            )
            .map((r) => ({
                title: r.title,
                url: r.url,
                snippet: typeof r.description === "string" ? r.description : "",
            }))
            .slice(0, maxResults);
    }
}
