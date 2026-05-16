import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTitleBase } from "../features/titlebar.ts";

void describe("getTitleBase", () => {
    void it("returns cwd basename when no session name", () => {
        const pi = {
            getSessionName: () => undefined,
        } as never;
        const originalCwd = process.cwd();
        try {
            process.chdir("/tmp");
            assert.equal(getTitleBase(pi), "π - tmp");
        } finally {
            process.chdir(originalCwd);
        }
    });

    void it("includes session name when set", () => {
        const pi = {
            getSessionName: () => "my-session",
        } as never;
        const originalCwd = process.cwd();
        try {
            process.chdir("/tmp");
            assert.equal(getTitleBase(pi), "π - my-session - tmp");
        } finally {
            process.chdir(originalCwd);
        }
    });
});
