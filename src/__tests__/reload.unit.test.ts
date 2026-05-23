/**
 * Tests for the reload feature — captureReload and registerReloadTool.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureReload } from "../features/reload.ts";
import { TauState } from "../state.ts";

void describe("captureReload", () => {
    void it("stores the reload function from context", () => {
        const state = new TauState();
        const mockCtx = {
            reload: async () => {},
        } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

        captureReload(state, mockCtx);

        assert.ok(state.commandContextReload !== undefined);
        assert.equal(typeof state.commandContextReload, "function");
    });

    void it("does not overwrite an existing capture", () => {
        const state = new TauState();
        let firstCalled = false;
        let secondCalled = false;

        const firstCtx = {
            reload: async () => {
                firstCalled = true;
            },
        } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

        const secondCtx = {
            reload: async () => {
                secondCalled = true;
            },
        } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

        captureReload(state, firstCtx);
        captureReload(state, secondCtx);

        // Should still use the first capture
        assert.ok(state.commandContextReload);
        void state.commandContextReload();
        assert.equal(firstCalled, true);
        assert.equal(secondCalled, false);
    });

    void it("skips capture when ctx.reload is not a function", () => {
        const state = new TauState();
        const mockCtx =
            {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

        captureReload(state, mockCtx);

        assert.equal(state.commandContextReload, undefined);
    });

    void it("allows the captured function to be invoked", async () => {
        const state = new TauState();
        let callCount = 0;

        const mockCtx = {
            reload: async () => {
                callCount++;
            },
        } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

        captureReload(state, mockCtx);

        assert.ok(state.commandContextReload);
        await state.commandContextReload();
        await state.commandContextReload();

        assert.equal(callCount, 2);
    });
});
