/**
 * Claude API web search provider.
 *
 * Two auth paths, tried in order:
 *   1. Claude Agent SDK (@anthropic-ai/claude-agent-sdk) — handles OAuth
 *      tokens, refresh, and Claude Code's credential store transparently.
 *   2. Raw API key (ANTHROPIC_API_KEY) — direct messages API call.
 *
 * The SDK path is preferred because it works with OAuth credentials
 * (what Claude Code uses) without needing a separate API key.
 * The raw API path is the fallback when the SDK is not installed.
 *
 * API docs: https://docs.anthropic.com/en/docs/build-with-claude/web-search
 */

import type { SearchProvider, SearchResult } from "./types.ts";

/** Check whether the Claude provider can be used. */
export function isClaudeAvailable(): boolean {
    if (process.env.ANTHROPIC_API_KEY) return true;
    // TODO: once @anthropic-ai/claude-agent-sdk is available (published
    // 2026-06-03, min-release-age blocks until ~June 10), add a dynamic
    // import check here. The SDK handles OAuth auth transparently.
    return false;
}

export class ClaudeSearchProvider implements SearchProvider {
    readonly name = "claude";

    async search(query: string, maxResults: number): Promise<SearchResult[]> {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(
                "Claude search requires either the Claude Agent SDK " +
                    "or ANTHROPIC_API_KEY to be set"
            );
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 4096,
                tools: [
                    {
                        type: "web_search_2025_03_22",
                        name: "web_search",
                        max_uses: 1,
                    },
                ],
                messages: [
                    {
                        role: "user",
                        content:
                            `Search the web for: ${query}\n\n` +
                            "Return only the search results. Do not add commentary.",
                    },
                ],
            }),
        });

        if (!response.ok) {
            throw new Error(`Claude search failed: HTTP ${response.status}`);
        }

        const data = (await response.json()) as {
            content: Array<
                | { type: "web_search_tool_result"; content: unknown }
                | { type: "text"; text: string }
            >;
        };

        // Extract web_search_tool_result blocks
        const searchResults: SearchResult[] = [];

        for (const block of data.content) {
            if (block.type !== "web_search_tool_result") continue;

            const results = block.content as Array<{
                type: string;
                title?: string;
                url?: string;
                snippet?: string;
            }>;

            for (const r of results) {
                if (r.type !== "web_search_result") continue;
                if (typeof r.title !== "string" || typeof r.url !== "string") {
                    continue;
                }
                searchResults.push({
                    title: r.title,
                    url: r.url,
                    snippet: typeof r.snippet === "string" ? r.snippet : "",
                });
                if (searchResults.length >= maxResults) break;
            }

            if (searchResults.length >= maxResults) break;
        }

        return searchResults;
    }
}
