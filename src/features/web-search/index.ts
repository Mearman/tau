/**
 * Web Search feature for tau — web search with automatic provider selection.
 *
 * Providers (tried in priority order):
 *   1. Claude (Anthropic API web_search tool) — if ANTHROPIC_API_KEY is set
 *   2. Brave (Brave Search API) — if BRAVE_SEARCH_API_KEY is set
 *   3. DuckDuckGo (HTML scraping) — zero config, always available
 *
 * Gated behind the "web-search" feature toggle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";
import { selectProvider, selectProviderByName } from "./select-provider.ts";

/** Default maximum number of search results. */
const DEFAULT_MAX_RESULTS = 10;

export function registerWebSearch(pi: ExtensionAPI, state: TauState): void {
    pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description:
            "Search the web and return results with titles, URLs, and snippets. " +
            "Supports three providers: 'claude' (Anthropic API, requires ANTHROPIC_API_KEY), " +
            "'brave' (Brave Search, requires BRAVE_SEARCH_API_KEY), " +
            "'duckduckgo' (HTML scraping, zero config but less reliable). " +
            "Default is 'auto' which picks the highest-priority available provider. " +
            "Use this instead of guessing URLs.",
        promptSnippet: "Search the web for information",
        promptGuidelines: [
            "Use web_search when you need to find information but don't have a specific URL.",
            "Results include title, URL, and a short snippet — use web_browse on a result URL for full content.",
            "Multiple queries can be run in separate calls; each returns independent results.",
        ],
        parameters: Type.Object({
            query: Type.String({
                description: "The search query",
            }),
            maxResults: Type.Optional(
                Type.Number({
                    description: `Maximum number of results (default ${DEFAULT_MAX_RESULTS}, max 20)`,
                    default: DEFAULT_MAX_RESULTS,
                    minimum: 1,
                    maximum: 20,
                })
            ),
            provider: Type.Optional(
                StringEnum(["auto", "claude", "brave", "duckduckgo"] as const, {
                    description:
                        "Search provider: 'auto' (best available, default), " +
                        "'claude' (Anthropic API), 'brave' (Brave Search), " +
                        "'duckduckgo' (HTML scraping, zero config)",
                    default: "auto",
                })
            ),
        }),
        async execute(_toolCallId, params) {
            if (!isFeatureEnabled(state, "web-search")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Web search is disabled — run /tau to enable",
                        },
                    ],
                    details: {
                        query: params.query,
                        provider: "none",
                        resultCount: 0,
                        results: [],
                    },
                };
            }

            const query = params.query;
            const maxResults = Math.min(
                Math.max(params.maxResults ?? DEFAULT_MAX_RESULTS, 1),
                20
            );

            const provider =
                params.provider === "auto" || !params.provider
                    ? selectProvider()
                    : selectProviderByName(params.provider);

            const results = await provider.search(query, maxResults);

            const lines: string[] = [
                `Web search results (via ${provider.name}):\n`,
            ];

            for (const [i, result] of results.entries()) {
                lines.push(`${i + 1}. ${result.title}`);
                lines.push(`   ${result.url}`);
                if (result.snippet) {
                    lines.push(`   ${result.snippet}`);
                }
                lines.push("");
            }

            if (results.length === 0) {
                lines.push("No results found.");
            }

            return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: {
                    query,
                    provider: provider.name,
                    resultCount: results.length,
                    results,
                },
            };
        },
    });
}
