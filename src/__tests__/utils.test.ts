import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatDuration,
    generateJobId,
    logPathForJob,
    looksLikePrompt,
    truncateNotificationBody,
    lastAssistantText,
    detectNonInteractive,
} from "../utils.ts";

void describe("detectNonInteractive", () => {
    void it("is true when -p is in argv (explicit print mode)", () => {
        assert.equal(
            detectNonInteractive(["node", "pi", "-p", "do x"], true),
            true
        );
    });

    void it("is true when --print is in argv", () => {
        assert.equal(
            detectNonInteractive(["node", "pi", "--print"], true),
            true
        );
    });

    void it("is true when stdin is not a TTY (piped/spawned)", () => {
        assert.equal(detectNonInteractive(["node", "pi"], false), true);
    });

    void it("is false for an interactive TTY with no print flag", () => {
        assert.equal(detectNonInteractive(["node", "pi", "chat"], true), false);
    });
});

void describe("formatDuration", () => {
    void it("formats seconds under a minute", () => {
        assert.equal(formatDuration(0), "0s");
        assert.equal(formatDuration(1_000), "1s");
        assert.equal(formatDuration(30_000), "30s");
        assert.equal(formatDuration(59_000), "59s");
    });

    void it("formats minutes and seconds", () => {
        assert.equal(formatDuration(60_000), "1m0s");
        assert.equal(formatDuration(90_000), "1m30s");
        assert.equal(formatDuration(3_700_000), "61m40s");
    });
});

void describe("generateJobId", () => {
    void it("generates a job ID with counter and PID", () => {
        const id = generateJobId(5, 1234);
        assert.equal(id, "job-1234-5");
    });

    void it("defaults to current process PID", () => {
        const id = generateJobId(1);
        assert.equal(id, `job-${process.pid}-1`);
    });
});

void describe("logPathForJob", () => {
    void it("returns the correct temp path", () => {
        assert.equal(logPathForJob("job-1234-5"), "/tmp/pi-bg-job-1234-5.log");
    });
});

void describe("looksLikePrompt", () => {
    void it("detects (y/n) prompts", () => {
        assert.equal(looksLikePrompt("Continue? (y/n)"), true);
        assert.equal(looksLikePrompt("[y/n]"), true);
    });

    void it("detects 'Press any key' prompts", () => {
        assert.equal(looksLikePrompt("Press any key to continue"), true);
        assert.equal(looksLikePrompt("Press Enter to proceed"), true);
    });

    void it("detects 'Do you / Would you' questions", () => {
        assert.equal(looksLikePrompt("Do you want to continue?"), true);
        assert.equal(looksLikePrompt("Would you like to overwrite?"), true);
        assert.equal(looksLikePrompt("Are you sure you want to delete?"), true);
    });

    void it("does not flag normal output", () => {
        assert.equal(looksLikePrompt("Building [1/10]..."), false);
        assert.equal(looksLikePrompt("Success!"), false);
        assert.equal(looksLikePrompt("  1234 bytes written"), false);
    });

    void it("only checks the last line", () => {
        const output =
            "Building [1/10]...\nBuilding [2/10]...\nContinue? (y/n)";
        assert.equal(looksLikePrompt(output), true);
    });
});

void describe("truncateNotificationBody", () => {
    void it("returns short text unchanged", () => {
        assert.equal(truncateNotificationBody("Hello world"), "Hello world");
    });

    void it("takes only the first line", () => {
        assert.equal(
            truncateNotificationBody("First line\nSecond line\nThird line"),
            "First line"
        );
    });

    void it("truncates lines exceeding 200 characters with ellipsis", () => {
        const long = "a".repeat(250);
        const result = truncateNotificationBody(long);
        assert.equal(result.length, 200);
        assert.equal(result.endsWith("…"), true);
    });
});

void describe("lastAssistantText", () => {
    void it("extracts text from the last assistant message", () => {
        const messages = [
            { role: "user", content: "hello" },
            {
                role: "assistant",
                content: [{ type: "text", text: "first response" }],
            },
            { role: "user", content: "again" },
            {
                role: "assistant",
                content: [{ type: "text", text: "second response" }],
            },
        ];
        assert.equal(lastAssistantText(messages), "second response");
    });

    void it("returns undefined when no assistant messages exist", () => {
        const messages = [{ role: "user", content: "hello" }];
        assert.equal(lastAssistantText(messages), undefined);
    });

    void it("returns undefined for empty array", () => {
        assert.equal(lastAssistantText([]), undefined);
    });
});
