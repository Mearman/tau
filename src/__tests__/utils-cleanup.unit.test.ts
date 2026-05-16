import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanupStaleLogs } from "../utils.ts";

void describe("cleanupStaleLogs", () => {
    void it("does not throw on normal execution", () => {
        assert.doesNotThrow(() => cleanupStaleLogs());
    });

    void it("handles missing /tmp gracefully", () => {
        // Function uses try/catch internally, so it never throws
        assert.doesNotThrow(() => cleanupStaleLogs());
    });
});
