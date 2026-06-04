/**
 * Tests for DuckDuckGoSearchProvider.search().
 *
 * Mocks global fetch to test the HTTP call and HTML parsing
 * without hitting the network.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DuckDuckGoSearchProvider } from "../features/web-search/duckduckgo.ts";

void describe("DuckDuckGoSearchProvider.search", () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl: string | undefined;

    function mockFetch(html: string) {
        globalThis.fetch = async (input: RequestInfo | URL) => {
            fetchedUrl = input instanceof URL ? input.toString() : String(input);
            return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        };
    }

    beforeEach(() => {
        fetchedUrl = undefined;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    void it("fetches the DDG HTML endpoint with the encoded query", async () => {
        mockFetch("<html><body></body></html>");
        const provider = new DuckDuckGoSearchProvider();
        await provider.search("test query", 5);

        assert.ok(fetchedUrl);
        assert.ok(fetchedUrl.includes("html.duckduckgo.com"), `URL was: ${fetchedUrl}`);
        assert.ok(fetchedUrl.includes("q=test%20query"), `URL was: ${fetchedUrl}`);
    });

    void it("returns parsed results from the fetched HTML", async () => {
        const html = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com">Test Result</a>
    </h2>
    <a class="result__snippet" href="https://example.com">A test snippet.</a>
  </div>
</div>`;
        mockFetch(html);

        const provider = new DuckDuckGoSearchProvider();
        const results = await provider.search("test", 5);

        assert.equal(results.length, 1);
        assert.equal(results[0].title, "Test Result");
        assert.equal(results[0].url, "https://example.com");
        assert.equal(results[0].snippet, "A test snippet.");
    });

    void it("throws on non-200 response", async () => {
        globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
        const provider = new DuckDuckGoSearchProvider();

        await assert.rejects(
            () => provider.search("test", 5),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes("403"), `Message was: ${err.message}`);
                return true;
            }
        );
    });
});
