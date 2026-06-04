/**
 * Tests for web-search provider selection.
 *
 * The selectProvider function picks the highest-priority provider
 * whose required environment variable is set. Priority order:
 *   1. claude    (ANTHROPIC_API_KEY)
 *   2. brave     (BRAVE_SEARCH_API_KEY)
 *   3. duckduckgo (always available, zero config)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { selectProvider } from "../features/web-search/select-provider.ts";
import { isClaudeAvailable } from "../features/web-search/claude.ts";

void describe("selectProvider", () => {
    const originals: Record<string, string | undefined> = {};

    beforeEach(() => {
        originals.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        originals.BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
    });

    afterEach(() => {
        if (originals.ANTHROPIC_API_KEY === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
        } else {
            process.env.ANTHROPIC_API_KEY = originals.ANTHROPIC_API_KEY;
        }
        if (originals.BRAVE_SEARCH_API_KEY === undefined) {
            delete process.env.BRAVE_SEARCH_API_KEY;
        } else {
            process.env.BRAVE_SEARCH_API_KEY = originals.BRAVE_SEARCH_API_KEY;
        }
    });

    void it("returns duckduckgo when no API keys are set", () => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.BRAVE_SEARCH_API_KEY;

        const provider = selectProvider();
        assert.equal(provider.name, "duckduckgo");
    });

    void it("prefers brave over duckduckgo when only BRAVE_SEARCH_API_KEY is set", () => {
        delete process.env.ANTHROPIC_API_KEY;
        process.env.BRAVE_SEARCH_API_KEY = "test-key";

        const provider = selectProvider();
        assert.equal(provider.name, "brave");
    });

    void it("prefers claude over brave when both ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY are set", () => {
        process.env.ANTHROPIC_API_KEY = "test-key";
        process.env.BRAVE_SEARCH_API_KEY = "test-key";

        const provider = selectProvider();
        assert.equal(provider.name, "claude");
    });

    void it("prefers claude when only ANTHROPIC_API_KEY is set", () => {
        process.env.ANTHROPIC_API_KEY = "test-key";
        delete process.env.BRAVE_SEARCH_API_KEY;

        const provider = selectProvider();
        assert.equal(provider.name, "claude");
    });
});
