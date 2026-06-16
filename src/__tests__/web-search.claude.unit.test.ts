/**
 * Tests for ClaudeSearchProvider.search().
 *
 * Mocks global fetch to test the Anthropic API call with the
 * built-in web_search tool and response parsing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ClaudeSearchProvider } from "../features/web-search/claude.ts";

void describe("ClaudeSearchProvider.search", () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    let fetchedUrl: string | undefined;
    let fetchedHeaders: Record<string, string> | undefined;
    let fetchedBody: unknown;

    function mockFetch(responseBody: unknown, status = 200) {
        globalThis.fetch = async (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => {
            fetchedUrl =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url;
            fetchedHeaders = init?.headers as
                | Record<string, string>
                | undefined;
            fetchedBody =
                typeof init?.body === "string"
                    ? JSON.parse(init.body)
                    : undefined;
            return new Response(JSON.stringify(responseBody), {
                status,
                headers: { "content-type": "application/json" },
            });
        };
    }

    beforeEach(() => {
        fetchedUrl = undefined;
        fetchedHeaders = undefined;
        fetchedBody = undefined;
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
        } else {
            process.env.ANTHROPIC_API_KEY = originalApiKey;
        }
    });

    void it("calls the Anthropic messages API with web_search tool", async () => {
        mockFetch({
            content: [{ type: "text", text: "No results" }],
            stop_reason: "end_turn",
        });
        const provider = new ClaudeSearchProvider();
        await provider.search("test query", 5);

        assert.ok(fetchedUrl);
        assert.ok(
            fetchedUrl.includes("api.anthropic.com"),
            `URL was: ${fetchedUrl}`
        );
        assert.equal(fetchedHeaders?.["x-api-key"], "test-anthropic-key");
        assert.equal(fetchedHeaders?.["anthropic-version"], "2023-06-01");

        // Verify the request includes the web_search tool
        const body = fetchedBody as {
            tools?: Array<{ type: string; name: string }>;
        };
        assert.ok(body.tools);
        const webSearchTool = body.tools.find((t) => t.name === "web_search");
        assert.ok(webSearchTool, `Tools were: ${JSON.stringify(body.tools)}`);
    });

    void it("extracts search results from web_search tool output", async () => {
        mockFetch({
            content: [
                {
                    type: "web_search_tool_result",
                    content: [
                        {
                            type: "web_search_result",
                            title: "Claude Result One",
                            url: "https://claude.example.com/one",
                            page_age: "2024-01-01",
                        },
                        {
                            type: "web_search_result",
                            title: "Claude Result Two",
                            url: "https://claude.example.com/two",
                        },
                    ],
                },
                {
                    type: "text",
                    text: "Here are the results for your query.",
                },
            ],
            stop_reason: "end_turn",
        });

        const provider = new ClaudeSearchProvider();
        const results = await provider.search("test", 5);

        assert.equal(results.length, 2);
        assert.equal(results[0].title, "Claude Result One");
        assert.equal(results[0].url, "https://claude.example.com/one");
        assert.equal(results[1].title, "Claude Result Two");
    });

    void it("respects maxResults by limiting returned results", async () => {
        const manyResults = Array.from({ length: 10 }, (_, i) => ({
            type: "web_search_result" as const,
            title: `Result ${i}`,
            url: `https://example.com/${i}`,
        }));

        mockFetch({
            content: [
                {
                    type: "web_search_tool_result",
                    content: manyResults,
                },
                { type: "text", text: "Results" },
            ],
            stop_reason: "end_turn",
        });

        const provider = new ClaudeSearchProvider();
        const results = await provider.search("test", 3);
        assert.equal(results.length, 3);
    });

    void it("returns empty array when no web_search_tool_result in response", async () => {
        mockFetch({
            content: [{ type: "text", text: "I couldn't find any results." }],
            stop_reason: "end_turn",
        });

        const provider = new ClaudeSearchProvider();
        const results = await provider.search("test", 5);
        assert.equal(results.length, 0);
    });

    void it("throws on non-200 response", async () => {
        globalThis.fetch = async () =>
            new Response("Unauthorized", { status: 401 });
        const provider = new ClaudeSearchProvider();

        await assert.rejects(
            () => provider.search("test", 5),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.ok(
                    err.message.includes("401"),
                    `Message was: ${err.message}`
                );
                return true;
            }
        );
    });
});
