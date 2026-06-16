/**
 * Tests for the web_search tool registration.
 *
 * Verifies the tool is registered with the correct name, parameters,
 * and delegates to the selected provider. Uses a mock ExtensionAPI
 * and mock provider.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TauState } from "../state.ts";
import { registerWebSearch } from "../features/web-search/index.ts";

/** Minimal mock of ExtensionAPI capturing registerTool calls. */
interface RegisteredTool {
    name: string;
    label: string;
    parameters: unknown;
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<unknown>;
}

function createMockApi(): {
    tools: RegisteredTool[];
    pi: {
        registerTool: (tool: RegisteredTool) => void;
        on: () => void;
    };
} {
    const tools: RegisteredTool[] = [];
    return {
        tools,
        pi: {
            registerTool: (tool: RegisteredTool) => {
                tools.push(tool);
            },
            on: () => {},
        },
    };
}

void describe("registerWebSearch", () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.BRAVE_SEARCH_API_KEY;
    });

    afterEach(() => {
        if (originalApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
        } else {
            process.env.ANTHROPIC_API_KEY = originalApiKey;
        }
        if (originalBraveKey === undefined) {
            delete process.env.BRAVE_SEARCH_API_KEY;
        } else {
            process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
        }
        globalThis.fetch = originalFetch;
    });

    void it("registers a tool named web_search", () => {
        const { pi, tools } = createMockApi();
        registerWebSearch(pi as never, {} as TauState);

        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "web_search");
    });

    void it("returns search results from the provider", async () => {
        // Mock fetch for DDG (zero-config fallback)
        globalThis.fetch = async () =>
            new Response(
                `<html><body>
                <div class="result">
                    <h2 class="result__title">
                        <a class="result__a" href="https://example.com">Test Title</a>
                    </h2>
                    <a class="result__snippet" href="https://example.com">Test snippet</a>
                </div>
                </body></html>`,
                { status: 200 }
            );

        const { pi, tools } = createMockApi();
        registerWebSearch(pi as never, {} as TauState);

        const result = await tools[0].execute(
            "test-call",
            { query: "test query" },
            undefined as never,
            undefined,
            undefined
        );

        const parsed = result as {
            content: Array<{ type: string; text: string }>;
            details: Record<string, unknown>;
        };
        assert.equal(parsed.content.length, 1);
        assert.equal(parsed.content[0].type, "text");
        assert.ok(parsed.content[0].text.includes("Test Title"));
        assert.equal(parsed.details.provider, "duckduckgo");
    });

    void it("returns disabled message when feature is disabled", async () => {
        const { pi, tools } = createMockApi();
        const state = {
            featureOverridesTemporary: new Map([["web-search", false]]),
        } as unknown as TauState;
        registerWebSearch(pi as never, state);

        const result = await tools[0].execute(
            "test-call",
            { query: "test" },
            undefined as never,
            undefined,
            undefined
        );

        const parsed = result as {
            content: Array<{ type: string; text: string }>;
        };
        assert.ok(parsed.content[0].text.includes("disabled"));
    });
});
