/**
 * DuckDuckGo HTML scraping search provider.
 *
 * Zero-config fallback — scrapes DuckDuckGo's HTML results page.
 * No API key required. Rate-limited under heavy use.
 *
 * DDG's HTML results page (html.duckduckgo.com) uses predictable
 * class names for result links (a.result__a) and snippets
 * (a.result__snippet). We find title links first, then look for
 * the nearest preceding snippet in the HTML.
 */

import type { SearchProvider, SearchResult } from "./types.ts";

/** Default maximum number of results. */
const DEFAULT_MAX_RESULTS = 10;

/**
 * Parse DuckDuckGo HTML results into SearchResult objects.
 *
 * Exported for testing — the public interface is DuckDuckGoSearchProvider.search().
 *
 * @param html - Raw HTML from DuckDuckGo's results page.
 * @param maxResults - Maximum results to return (default 10).
 * @returns Parsed search results.
 */
export function parseDuckDuckGoHtml(
    html: string,
    maxResults: number = DEFAULT_MAX_RESULTS
): SearchResult[] {
    const results: SearchResult[] = [];

    // Find all result title links: <a class="result__a" href="...">
    const titleLinkRegex =
        /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

    let titleMatch: RegExpExecArray | null;
    while ((titleMatch = titleLinkRegex.exec(html)) !== null) {
        if (results.length >= maxResults) break;

        const url = titleMatch[1];
        const title = stripTags(titleMatch[2]).trim();
        if (!url || !title) continue;

        // Look for the snippet after the title link, up to the next result
        const afterTitle = html.slice(titleMatch.index + titleMatch[0].length);
        const nextResult = afterTitle.indexOf("result__a");
        const snippetRegion =
            nextResult >= 0 ? afterTitle.slice(0, nextResult) : afterTitle;

        const snippetMatch =
            /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(
                snippetRegion
            );
        const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";

        results.push({ title, url, snippet });
    }

    return results;
}

/** Strip HTML tags from a string. */
function stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, "");
}

export class DuckDuckGoSearchProvider implements SearchProvider {
    readonly name = "duckduckgo";

    async search(query: string, maxResults: number): Promise<SearchResult[]> {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            },
        });

        if (!response.ok) {
            throw new Error(
                `DuckDuckGo search failed: HTTP ${response.status}`
            );
        }

        const html = await response.text();
        return parseDuckDuckGoHtml(html, maxResults);
    }
}
