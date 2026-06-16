/**
 * Regression test for pi core's waitForChildProcess helper.
 *
 * tau's background tasks read a child's stdout/stderr, so the helper must keep
 * those streams (and the awaited promise) alive until they have ended —
 * otherwise buffered output is discarded before the readable side drains.
 * Destruction after the streams end is harmless cleanup and is expected; the
 * guard here is against premature destruction between exit and drain.
 */

import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForChildProcess } from "../../node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js";

class FakeStream extends EventEmitter {
    destroyed = false;

    destroy(): void {
        this.destroyed = true;
    }
}

class FakeChildProcess extends EventEmitter {
    stdout: FakeStream;
    stderr: FakeStream;

    constructor() {
        super();
        this.stdout = new FakeStream();
        this.stderr = new FakeStream();
    }
}

void describe("waitForChildProcess", () => {
    void it("preserves stdio and does not settle before the streams drain", async () => {
        assert.notEqual(
            process.platform,
            "win32",
            "this test only applies off Windows"
        );

        const child = new FakeChildProcess();
        const done = waitForChildProcess(
            child as unknown as import("node:child_process").ChildProcess
        );
        let settled = false;
        void done.then(() => {
            settled = true;
        });

        child.emit("exit", 0);
        // Exited, but neither stream has ended yet. Destroying now would
        // discard buffered output, and the promise must not have settled.
        assert.equal(child.stdout.destroyed, false);
        assert.equal(child.stderr.destroyed, false);
        assert.equal(settled, false);

        child.stdout.emit("end");
        // Half drained: stderr still pending, so still unsettled.
        assert.equal(settled, false);

        child.stderr.emit("end");
        const code = await done;
        assert.equal(code, 0);
    });
});
