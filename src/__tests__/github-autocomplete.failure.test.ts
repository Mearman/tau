import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerGithubAutocomplete } from "../features/github-autocomplete.ts";

void describe("github-autocomplete — gh failure path", () => {
    void it("notifies error when gh issue list fails", async () => {
        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;

        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async (_cmd: string, args: string[], _opts: unknown) => {
                if (args[0] === "remote") {
                    return {
                        code: 0,
                        stdout: "origin\tgit@github.com:test/repo.git (fetch)",
                        stderr: "",
                    };
                }
                // gh issue list fails
                return {
                    code: 1,
                    stdout: "",
                    stderr: "gh not authenticated",
                };
            },
        } as never;

        registerGithubAutocomplete(pi);

        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
                addAutocompleteProvider: () => {},
            },
        } as never;

        await sessionStartHandler!({}, ctx);

        // Wait a tick for the async gh call to complete
        await new Promise((r) => setTimeout(r, 50));

        assert.ok(
            notifications.some((n) => n.message.includes("failed to load"))
        );
    });

    void it("notifies error when gh output is invalid JSON", async () => {
        let sessionStartHandler: ((...args: unknown[]) => unknown) | undefined;

        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                if (event === "session_start") sessionStartHandler = handler;
            },
            exec: async (_cmd: string, args: string[], _opts: unknown) => {
                if (args[0] === "remote") {
                    return {
                        code: 0,
                        stdout: "origin\tgit@github.com:test/repo.git (fetch)",
                        stderr: "",
                    };
                }
                return {
                    code: 0,
                    stdout: "not valid json",
                    stderr: "",
                };
            },
        } as never;

        registerGithubAutocomplete(pi);

        const notifications: { message: string; level: string }[] = [];
        const ctx = {
            cwd: "/tmp",
            ui: {
                notify: (message: string, level: string) =>
                    notifications.push({ message, level }),
                addAutocompleteProvider: () => {},
            },
        } as never;

        await sessionStartHandler!({}, ctx);
        await new Promise((r) => setTimeout(r, 50));

        assert.ok(
            notifications.some((n) => n.message.includes("failed to parse"))
        );
    });
});
