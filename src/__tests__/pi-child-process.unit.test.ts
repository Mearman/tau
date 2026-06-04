/**
 * Regression test for pi core's waitForChildProcess helper.
 *
 * On Unix, it must not destroy stdout/stderr after exit, otherwise buffered
 * data can be discarded before the readable side has drained.
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
    void it("does not destroy stdio on non-Windows platforms", async () => {
        assert.notEqual(
            process.platform,
            "win32",
            "this test only applies off Windows"
        );

        const child = new FakeChildProcess();
        const done = waitForChildProcess(
            child as unknown as import("node:child_process").ChildProcess
        );

        child.emit("exit", 0);
        child.stdout.emit("end");
        child.stderr.emit("end");

        const code = await done;
        assert.equal(code, 0);
        assert.equal(child.stdout.destroyed, false);
        assert.equal(child.stderr.destroyed, false);
    });
});
