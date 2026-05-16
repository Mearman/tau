import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerGithubAutocomplete } from "../features/github-autocomplete.ts";

function setupProvider(
    issues: { number: number; title: string; state: string }[]
) {
    let providerFactory: ((current: unknown) => unknown) | undefined;
    let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;

    const pi = {
        on(event: string, handler: (...args: unknown[]) => unknown) {
            if (event === "session_start") sessionStartHandler = handler;
        },
        exec: async (_cmd: string, args: string[]) => {
            if (args[0] === "remote") {
                return {
                    code: 0,
                    stdout: "origin\tgit@github.com:test/repo.git (fetch)",
                    stderr: "",
                };
            }
            return { code: 0, stdout: JSON.stringify(issues), stderr: "" };
        },
    } as never;

    registerGithubAutocomplete(pi);

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
        async start() {
            await sessionStartHandler!({}, ctx);
            return providerFactory!;
        },
    };
}

function makeCurrent(
    overrides?: Partial<{
        getSuggestions: () => unknown;
        applyCompletion: (...args: unknown[]) => unknown;
        shouldTriggerFileCompletion: (...args: unknown[]) => boolean;
    }>
) {
    return {
        getSuggestions: async () => ({ items: [] }),
        applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
        shouldTriggerFileCompletion: () => true,
        ...overrides,
    };
}

void describe("github provider — empty suggestions fallback", () => {
    void it("delegates when no matching issues found", async () => {
        const setup = setupProvider([
            { number: 1, title: "Bug", state: "open" },
        ]);
        const factory = await setup.start();

        const current = makeCurrent({
            getSuggestions: async () => "delegated-empty",
        });

        const provider = factory(current) as {
            getSuggestions: (...args: unknown[]) => Promise<unknown>;
        };

        // Query "999" → no numeric match, fuzzy also fails → delegates
        const result = await provider.getSuggestions(["fix #999"], 0, 8, {
            signal: { aborted: false },
        });
        assert.equal(result, "delegated-empty");
    });
});

void describe("github provider — applyCompletion", () => {
    void it("delegates applyCompletion to current", async () => {
        const setup = setupProvider([]);
        const factory = await setup.start();

        const applyArgs: unknown[] = [];
        const current = makeCurrent({
            applyCompletion: (...args: unknown[]) => {
                applyArgs.push(...args);
                return { lines: ["result"], cursorLine: 0, cursorCol: 6 };
            },
        });

        const provider = factory(current) as {
            applyCompletion: (...args: unknown[]) => unknown;
        };

        const result = provider.applyCompletion(
            ["fix #1"],
            0,
            6,
            { value: "#1", label: "#1", description: "[open] Bug" },
            "#1"
        );
        assert.ok(result);
        assert.ok(applyArgs.length > 0);
    });
});

void describe("github provider — shouldTriggerFileCompletion", () => {
    void it("delegates when current has the method", async () => {
        const setup = setupProvider([]);
        const factory = await setup.start();

        const current = makeCurrent({
            shouldTriggerFileCompletion: () => false,
        });

        const provider = factory(current) as {
            shouldTriggerFileCompletion: (...args: unknown[]) => boolean;
        };

        assert.equal(provider.shouldTriggerFileCompletion([""], 0, 0), false);
    });

    void it("returns true when current does not have the method", async () => {
        const setup = setupProvider([]);
        const factory = await setup.start();

        const current = {
            getSuggestions: async () => null,
            applyCompletion: () => ({}),
            // No shouldTriggerFileCompletion
        };

        const provider = factory(current) as {
            shouldTriggerFileCompletion: (...args: unknown[]) => boolean;
        };

        assert.equal(provider.shouldTriggerFileCompletion([""], 0, 0), true);
    });
});
