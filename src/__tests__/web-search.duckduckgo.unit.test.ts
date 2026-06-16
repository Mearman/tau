/**
 * Tests for DuckDuckGo HTML result parsing.
 *
 * parseDuckDuckGoHtml extracts search results from the DDG HTML
 * results page. We test against representative HTML fragments.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGoHtml } from "../features/web-search/duckduckgo.ts";

void describe("parseDuckDuckGoHtml", () => {
    void it("extracts a single result from DDG HTML", () => {
        const html = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/docs">Example Documentation</a>
    </h2>
    <a class="result__snippet" href="https://example.com/docs">
      This is the snippet text for the first result.
    </a>
  </div>
</div>
</body></html>`;

        const results = parseDuckDuckGoHtml(html);
        assert.equal(results.length, 1);
        assert.equal(results[0].title, "Example Documentation");
        assert.equal(results[0].url, "https://example.com/docs");
        assert.equal(
            results[0].snippet,
            "This is the snippet text for the first result."
        );
    });

    void it("extracts multiple results and respects maxResults", () => {
        const html = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://a.com">Result A</a>
    </h2>
    <a class="result__snippet" href="https://a.com">Snippet A</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://b.com">Result B</a>
    </h2>
    <a class="result__snippet" href="https://b.com">Snippet B</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://c.com">Result C</a>
    </h2>
    <a class="result__snippet" href="https://c.com">Snippet C</a>
  </div>
</div>
</body></html>`;

        const results = parseDuckDuckGoHtml(html, 2);
        assert.equal(results.length, 2);
        assert.equal(results[0].title, "Result A");
        assert.equal(results[1].title, "Result B");
    });

    void it("returns empty array for HTML with no results", () => {
        const html = "<html><body><p>No results found</p></body></html>";
        const results = parseDuckDuckGoHtml(html);
        assert.equal(results.length, 0);
    });

    void it("skips results with missing title or URL", () => {
        const html = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://good.com">Good Result</a>
    </h2>
    <a class="result__snippet" href="https://good.com">Good snippet</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <!-- no link here -->
    </h2>
  </div>
</div>
</body></html>`;

        const results = parseDuckDuckGoHtml(html);
        assert.equal(results.length, 1);
        assert.equal(results[0].title, "Good Result");
    });
});
