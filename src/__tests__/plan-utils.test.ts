import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isSafeCommand,
    cleanStepText,
    extractTodoItems,
    extractDoneSteps,
    markCompletedSteps,
} from "../plan-utils.ts";

void describe("isSafeCommand", () => {
    void it("allows read-only commands", () => {
        assert.equal(isSafeCommand("ls -la"), true);
        assert.equal(isSafeCommand("cat file.txt"), true);
        assert.equal(isSafeCommand("grep -r pattern src/"), true);
        assert.equal(isSafeCommand("git status"), true);
        assert.equal(isSafeCommand("git log --oneline -5"), true);
        assert.equal(isSafeCommand("find . -name '*.ts'"), true);
        assert.equal(isSafeCommand("pwd"), true);
        assert.equal(isSafeCommand("echo hello"), true);
        assert.equal(isSafeCommand("node --version"), true);
        assert.equal(isSafeCommand("rg 'pattern' src/"), true);
    });

    void it("blocks destructive commands", () => {
        assert.equal(isSafeCommand("rm -rf node_modules"), false);
        assert.equal(isSafeCommand("npm install express"), false);
        assert.equal(isSafeCommand("git commit -m 'fix'"), false);
        assert.equal(isSafeCommand("vim file.txt"), false);
        assert.equal(isSafeCommand("sudo apt install build-essential"), false);
        assert.equal(isSafeCommand("mkdir new-dir"), false);
        assert.equal(isSafeCommand("echo 'hi' > file.txt"), false);
        assert.equal(isSafeCommand("echo 'hi' >> file.txt"), false);
        assert.equal(isSafeCommand("kill -9 1234"), false);
        assert.equal(isSafeCommand("brew install node"), false);
    });

    void it("blocks commands that look destructive even with safe prefixes", () => {
        assert.equal(isSafeCommand("echo rm something"), false);
        assert.equal(isSafeCommand("cat file | sudo tee /etc/config"), false);
    });
});

void describe("cleanStepText", () => {
    void it("removes bold/italic markdown", () => {
        assert.equal(cleanStepText("**bold text**"), "Bold text");
        assert.equal(cleanStepText("*italic text*"), "Italic text");
    });

    void it("removes inline code markers and capitalises", () => {
        assert.equal(cleanStepText("`code here`"), "Code here");
    });

    void it("strips leading imperative verbs", () => {
        assert.equal(cleanStepText("Use the config file"), "Config file");
        assert.equal(cleanStepText("Run the tests"), "Tests");
        assert.equal(cleanStepText("Create a new file"), "A new file");
        assert.equal(cleanStepText("Read the documentation"), "Documentation");
    });

    void it("capitalises the first letter", () => {
        assert.equal(cleanStepText("add a new route"), "A new route");
    });

    void it("truncates to 50 characters", () => {
        const long = "a".repeat(80);
        const result = cleanStepText(long);
        assert.equal(result.length, 50);
        assert.equal(result.endsWith("..."), true);
    });
});

void describe("extractTodoItems", () => {
    void it("extracts numbered steps from a Plan: header", () => {
        const message =
            "Here's my analysis.\n\nPlan:\n1. Read the source files\n2. Identify the bug\n3. Write a fix\n\nLet me know if this works.";
        const items = extractTodoItems(message);
        assert.equal(items.length, 3);
        assert.equal(items[0].step, 1);
        assert.equal(items[0].completed, false);
        assert.equal(items[2].step, 3);
    });

    void it("returns empty array when no Plan: header exists", () => {
        assert.deepEqual(extractTodoItems("No plan here, just text"), []);
        assert.deepEqual(extractTodoItems(""), []);
    });

    void it("ignores steps that are too short", () => {
        const message =
            "Plan:\n1. Do\n2. This is a proper step that should be extracted";
        const items = extractTodoItems(message);
        assert.equal(items.length, 1);
    });

    void it("ignores steps starting with backticks, slashes, or dashes", () => {
        const message =
            "Plan:\n1. `code block step`\n2. /command step\n3. - dash step\n4. A real valid step here";
        const items = extractTodoItems(message);
        assert.equal(items.length, 1);
    });
});

void describe("extractDoneSteps", () => {
    void it("extracts [DONE:n] tags", () => {
        assert.deepEqual(
            extractDoneSteps("Completed [DONE:1] and [DONE:3]"),
            [1, 3]
        );
        assert.deepEqual(extractDoneSteps("[DONE:42]"), [42]);
    });

    void it("returns empty array when no tags present", () => {
        assert.deepEqual(extractDoneSteps("No tags here"), []);
        assert.deepEqual(extractDoneSteps(""), []);
    });

    void it("is case-insensitive", () => {
        assert.deepEqual(extractDoneSteps("[done:1]"), [1]);
        assert.deepEqual(extractDoneSteps("[Done:5]"), [5]);
    });
});

void describe("markCompletedSteps", () => {
    void it("marks steps as completed based on [DONE:n] tags", () => {
        const items = [
            { step: 1, text: "First", completed: false },
            { step: 2, text: "Second", completed: false },
            { step: 3, text: "Third", completed: false },
        ];
        const count = markCompletedSteps(
            "Done with [DONE:1] and [DONE:3]",
            items
        );
        assert.equal(count, 2);
        assert.equal(items[0].completed, true);
        assert.equal(items[1].completed, false);
        assert.equal(items[2].completed, true);
    });

    void it("returns count of DONE tags found even if no items match", () => {
        const items = [{ step: 1, text: "First", completed: false }];
        const count = markCompletedSteps("[DONE:99]", items);
        assert.equal(count, 1); // returns number of [DONE:n] tags found
        assert.equal(items[0].completed, false); // step 99 doesn't match step 1
    });

    void it("does not double-mark already completed steps", () => {
        const items = [{ step: 1, text: "First", completed: true }];
        const count = markCompletedSteps("[DONE:1]", items);
        assert.equal(count, 1);
        assert.equal(items[0].completed, true);
    });
});
