/**
 * Tests for BraveSearchProvider.search().
 *
 * Mocks global fetch to test the API call and response parsing
 * without hitting the network.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BraveSearchProvider } from "../features/web-search/brave.ts";

void describe("BraveSearchProvider.search", () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
    let fetchedUrl: string | undefined;
    let fetchedHeaders: Record<string, string> | undefined;

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
            return new Response(JSON.stringify(responseBody), {
                status,
                headers: { "content-type": "application/json" },
            });
        };
    }

    beforeEach(() => {
        fetchedUrl = undefined;
        fetchedHeaders = undefined;
        process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalApiKey === undefined) {
            delete process.env.BRAVE_SEARCH_API_KEY;
        } else {
            process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
        }
    });

    void it("calls the Brave Search API with correct URL and headers", async () => {
        mockFetch({ web: { results: [] } });
        const provider = new BraveSearchProvider();
        await provider.search("test query", 5);

        assert.ok(fetchedUrl);
        assert.ok(
            fetchedUrl.includes("api.search.brave.com"),
            `URL was: ${fetchedUrl}`
        );
        assert.ok(
            fetchedUrl.includes("q=test%20query"),
            `URL was: ${fetchedUrl}`
        );
        assert.ok(fetchedUrl.includes("count=5"), `URL was: ${fetchedUrl}`);
        assert.equal(
            fetchedHeaders?.["X-Subscription-Token"],
            "test-brave-key"
        );
    });

    void it("parses web results from the Brave API response", async () => {
        mockFetch({
            web: {
                results: [
                    {
                        title: "Brave Result One",
                        url: "https://brave.example.com/one",
                        description: "First brave result description",
                    },
                    {
                        title: "Brave Result Two",
                        url: "https://brave.example.com/two",
                        description: "Second brave result description",
                    },
                ],
            },
        });

        const provider = new BraveSearchProvider();
        const results = await provider.search("test", 5);

        assert.equal(results.length, 2);
        assert.equal(results[0].title, "Brave Result One");
        assert.equal(results[0].url, "https://brave.example.com/one");
        assert.equal(results[0].snippet, "First brave result description");
        assert.equal(results[1].title, "Brave Result Two");
    });

    void it("returns empty array when web results are missing", async () => {
        mockFetch({});
        const provider = new BraveSearchProvider();
        const results = await provider.search("test", 5);
        assert.equal(results.length, 0);
    });

    void it("throws on non-200 response", async () => {
        globalThis.fetch = async () =>
            new Response("Unauthorized", { status: 401 });
        const provider = new BraveSearchProvider();

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
