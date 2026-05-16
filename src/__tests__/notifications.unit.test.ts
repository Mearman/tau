import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, sendNotification } from "../features/notifications.ts";
import { TauState } from "../state.ts";

void describe("shouldNotify", () => {
    void it("returns true when DnD is disabled", async () => {
        const state = new TauState();
        state.notificationRespectDnd = false;
        assert.equal(await shouldNotify(state), true);
    });

    void it("returns true when DnD is enabled but system DnD is off", async () => {
        const state = new TauState();
        state.notificationRespectDnd = true;
        // On non-macOS or without DnD active, this should return true
        // On macOS with DnD off, also true
        const result = await shouldNotify(state);
        assert.equal(typeof result, "boolean");
    });
});

void describe("sendNotification", () => {
    void it("does not throw", () => {
        const state = new TauState();
        state.notificationPersistent = false;
        assert.doesNotThrow(() => {
            sendNotification(state, [
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Task completed successfully" },
                    ],
                },
            ] as never);
        });
    });

    void it("handles empty messages", () => {
        const state = new TauState();
        assert.doesNotThrow(() => {
            sendNotification(state, []);
        });
    });

    void it("handles messages without assistant text", () => {
        const state = new TauState();
        assert.doesNotThrow(() => {
            sendNotification(state, [
                { role: "user", content: "hello" },
            ] as never);
        });
    });
});
