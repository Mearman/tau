import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerGithubAutocomplete } from "../features/github-autocomplete.ts";
import { TauState } from "../state.ts";

/**
 * DI approach: capture the event handlers registered on the mock pi,
 * then call them directly with controlled inputs.
 */
function captureHandlers() {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};

    const pi = {
        on(event: string, handler: (...args: unknown[]) => unknown) {
            handlers[event] = handler;
        },
        exec: async (
            _cmd: string,
            _args: string[],
            _opts: unknown
        ): Promise<{ code: number; stdout: string; stderr: string }> => ({
            code: 0,
            stdout: "",
            stderr: "",
        }),
    } as never;

    registerGithubAutocomplete(pi, new TauState());
    return handlers;
}

void describe("registerGithubAutocomplete", () => {
    void it("registers a session_start handler", () => {
        const handlers = captureHandlers();
        assert.ok(handlers["session_start"]);
    });
});

void describe("github resolveGitHubRepo (via DI)", () => {
    void it("notifies error when cwd is not a git repo", async () => {
        const notifications: { message: string; level: string }[] = [];
        const providers: unknown[] = [];

        const pi = {
            on(_event: string, _handler: (...args: unknown[]) => unknown) {
                // The session_start handler
            },
            exec: async () => ({ code: 1, stdout: "", stderr: "not a repo" }),
        } as never;

        registerGithubAutocomplete(pi, new TauState());

        // Get the handler directly by re-registering and capturing
        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;
        const pi2 = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async () => ({ code: 1, stdout: "", stderr: "not a repo" }),
        } as never;

        registerGithubAutocomplete(pi2, new TauState());

        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string, level: string) => {
                    notifications.push({ message, level });
                },
                addAutocompleteProvider: (p: unknown) => providers.push(p),
            },
        } as never;

        await sessionStartHandler!({}, ctx);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].level, "error");
        assert.ok(notifications[0].message.includes("not a git repository"));
    });

    void it("notifies error when cwd is not a GitHub repo", async () => {
        const notifications: { message: string; level: string }[] = [];

        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async () => ({
                code: 0,
                stdout: "origin\tgit@gitlab.com:user/repo.git (fetch)\norigin\tgit@gitlab.com:user/repo.git (push)",
                stderr: "",
            }),
        } as never;

        registerGithubAutocomplete(pi, new TauState());

        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string, level: string) => {
                    notifications.push({ message, level });
                },
                addAutocompleteProvider: () => {},
            },
        } as never;

        await sessionStartHandler!({}, ctx);
        assert.equal(notifications.length, 1);
        assert.ok(notifications[0].message.includes("not a GitHub repository"));
    });

    void it("registers autocomplete provider for GitHub repos", async () => {
        const notifications: { message: string; level: string }[] = [];
        const providers: unknown[] = [];

        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async (cmd: string, args: string[], _opts: unknown) => {
                if (args[0] === "remote") {
                    return {
                        code: 0,
                        stdout: "origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)",
                        stderr: "",
                    };
                }
                // gh issue list
                return {
                    code: 0,
                    stdout: JSON.stringify([
                        { number: 1, title: "Bug", state: "open" },
                        { number: 2, title: "Feature", state: "open" },
                    ]),
                    stderr: "",
                };
            },
        } as never;

        registerGithubAutocomplete(pi, new TauState());

        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string, level: string) => {
                    notifications.push({ message, level });
                },
                addAutocompleteProvider: (
                    factory: (current: unknown) => unknown
                ) => {
                    providers.push(factory);
                },
            },
        } as never;

        await sessionStartHandler!({}, ctx);

        // Should have registered a provider factory
        assert.ok(providers.length > 0);
    });
});
