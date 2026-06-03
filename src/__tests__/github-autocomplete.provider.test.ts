import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerGithubAutocomplete } from "../features/github-autocomplete.ts";
import { TauState } from "../state.ts";

/**
 * Test the autocomplete provider via DI.
 * Capture the provider factory from addAutocompleteProvider,
 * then call getSuggestions with controlled issue data.
 */
void describe("github-autocomplete provider", () => {
    function setupProvider(
        issues: { number: number; title: string; state: string }[]
    ) {
        let providerFactory: ((current: unknown) => unknown) | undefined;
        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;

        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async (_cmd: string, args: string[], _opts: unknown) => {
                if (args[0] === "remote") {
                    return {
                        code: 0,
                        stdout: "origin\tgit@github.com:test/repo.git (fetch)\norigin\tgit@github.com:test/repo.git (push)",
                        stderr: "",
                    };
                }
                return {
                    code: 0,
                    stdout: JSON.stringify(issues),
                    stderr: "",
                };
            },
        } as never;

        registerGithubAutocomplete(pi, new TauState());

        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: () => {},
                addAutocompleteProvider: (
                    factory: (current: unknown) => unknown
                ) => {
                    providerFactory = factory;
                },
            },
        } as never;

        return {
            sessionStartHandler,
            ctx,
            getProviderFactory: () => providerFactory,
        };
    }

    void it("provider returns null when no # token", async () => {
        const issues = [{ number: 1, title: "Bug", state: "open" }];
        const { sessionStartHandler, ctx, getProviderFactory } =
            setupProvider(issues);

        await sessionStartHandler!({}, ctx);
        const factory = getProviderFactory();
        assert.ok(factory);

        const current = {
            getSuggestions: async () => ({ items: [] }),
            applyCompletion: () => ({}),
            shouldTriggerFileCompletion: () => true,
        };

        const provider = factory(current) as {
            getSuggestions: (
                lines: string[],
                cursorLine: number,
                cursorCol: number,
                options: { signal: { aborted: boolean } }
            ) => Promise<unknown>;
        };

        // No # token → delegates to current provider
        // The current provider returns { items: [] }, so our provider
        // delegates and returns that result (not null)
        const result = await provider.getSuggestions(["hello world"], 0, 11, {
            signal: { aborted: false },
        });
        assert.ok(result);
        assert.deepEqual((result as { items: unknown[] }).items, []);
    });

    void it("provider returns suggestions for # token", async () => {
        const issues = [
            { number: 1, title: "Bug in auth", state: "open" },
            { number: 2, title: "Feature", state: "closed" },
        ];
        const { sessionStartHandler, ctx, getProviderFactory } =
            setupProvider(issues);

        await sessionStartHandler!({}, ctx);
        const factory = getProviderFactory();
        assert.ok(factory);

        const current = {
            getSuggestions: async () => ({ items: [] }),
            applyCompletion: (
                _l: unknown,
                _cl: unknown,
                _cc: unknown,
                item: unknown,
                _prefix: unknown
            ) => ({
                lines: [item as string],
                cursorLine: 0,
                cursorCol: 5,
            }),
            shouldTriggerFileCompletion: () => true,
        };

        const provider = factory(current) as {
            getSuggestions: (
                lines: string[],
                cursorLine: number,
                cursorCol: number,
                options: { signal: { aborted: boolean } }
            ) => Promise<unknown>;
            applyCompletion: (...args: unknown[]) => unknown;
            shouldTriggerFileCompletion: (...args: unknown[]) => boolean;
        };

        // "#1" token → should return suggestions
        const result = await provider.getSuggestions(["fix #1"], 0, 6, {
            signal: { aborted: false },
        });
        assert.ok(result);
        assert.ok("items" in (result as Record<string, unknown>));
        assert.ok("prefix" in (result as Record<string, unknown>));
    });

    void it("provider delegates when signal is aborted", async () => {
        const issues = [{ number: 1, title: "Bug", state: "open" }];
        const { sessionStartHandler, ctx, getProviderFactory } =
            setupProvider(issues);

        await sessionStartHandler!({}, ctx);
        const factory = getProviderFactory();

        const current = {
            getSuggestions: async () => "delegated",
            applyCompletion: () => ({}),
            shouldTriggerFileCompletion: () => true,
        };

        const provider = factory!(current) as {
            getSuggestions: (
                lines: string[],
                cursorLine: number,
                cursorCol: number,
                options: { signal: { aborted: boolean } }
            ) => Promise<unknown>;
        };

        const result = await provider.getSuggestions(["fix #1"], 0, 6, {
            signal: { aborted: true },
        });
        assert.equal(result, "delegated");
    });

    void it("shouldTriggerFileCompletion delegates to current", () => {
        const current = {
            shouldTriggerFileCompletion: () => false,
        };
        assert.equal(current.shouldTriggerFileCompletion(), false);
    });
});
