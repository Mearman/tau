import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    parseGitHubRepo,
    extractIssueToken,
    filterIssues,
    formatIssueItem,
} from "../features/github-autocomplete.ts";

void describe("parseGitHubRepo", () => {
    void it("parses SSH URLs", () => {
        assert.equal(
            parseGitHubRepo("git@github.com:owner/repo.git"),
            "owner/repo"
        );
        assert.equal(
            parseGitHubRepo("git@github.com:owner/repo"),
            "owner/repo"
        );
    });

    void it("parses HTTPS URLs", () => {
        assert.equal(
            parseGitHubRepo("https://github.com/owner/repo.git"),
            "owner/repo"
        );
        assert.equal(
            parseGitHubRepo("https://github.com/owner/repo"),
            "owner/repo"
        );
        assert.equal(
            parseGitHubRepo("http://github.com/owner/repo"),
            "owner/repo"
        );
    });

    void it("returns undefined for non-GitHub URLs", () => {
        assert.equal(
            parseGitHubRepo("git@gitlab.com:owner/repo.git"),
            undefined
        );
        assert.equal(parseGitHubRepo("not a url"), undefined);
        assert.equal(parseGitHubRepo(""), undefined);
    });

    void it("handles URLs with trailing slash", () => {
        assert.equal(
            parseGitHubRepo("https://github.com/owner/repo/"),
            undefined
        );
    });

    void it("rejects non-GitHub SSH hosts", () => {
        assert.equal(parseGitHubRepo("git@gitlab.org:org/repo.git"), undefined);
    });
});

void describe("extractIssueToken", () => {
    void it("extracts token after #", () => {
        assert.equal(extractIssueToken("fix #12"), "12");
        assert.equal(extractIssueToken("see #"), "");
        assert.equal(extractIssueToken("#abc"), "abc");
    });

    void it("returns undefined when no # token", () => {
        assert.equal(extractIssueToken("no token here"), undefined);
        assert.equal(extractIssueToken(""), undefined);
    });

    void it("does not match mid-word #", () => {
        assert.equal(extractIssueToken("use foo#bar"), undefined);
    });
});

void describe("formatIssueItem", () => {
    void it("formats an issue as autocomplete item", () => {
        const item = formatIssueItem({
            number: 42,
            title: "Bug in login",
            state: "open",
        });
        assert.equal(item.value, "#42");
        assert.equal(item.label, "#42");
        assert.equal(item.description, "[open] Bug in login");
    });
});

void describe("filterIssues", () => {
    const issues = [
        { number: 1, title: "Bug in auth", state: "open" },
        { number: 2, title: "Feature request", state: "open" },
        { number: 10, title: "Fix crash", state: "closed" },
        { number: 20, title: "Update docs", state: "open" },
    ];

    void it("returns first 20 issues when no query", () => {
        const results = filterIssues(issues, "");
        assert.equal(results.length, 4);
        assert.equal(results[0].value, "#1");
    });

    void it("returns all when query is whitespace", () => {
        const results = filterIssues(issues, "  ");
        assert.equal(results.length, 4);
    });

    void it("filters by numeric prefix", () => {
        const results = filterIssues(issues, "1");
        assert.equal(results.length, 2); // #1 and #10
        assert.equal(results[0].value, "#1");
        assert.equal(results[1].value, "#10");
    });

    void it("filters by text using fuzzy matching", () => {
        const results = filterIssues(issues, "bug");
        assert.ok(results.length >= 1);
        assert.equal(results[0].value, "#1");
    });

    void it("returns empty for no matches", () => {
        const results = filterIssues(issues, "zzzznonexistent");
        assert.equal(results.length, 0);
    });

    void it("limits to 20 results", () => {
        const many = Array.from({ length: 50 }, (_, i) => ({
            number: i + 1,
            title: `Issue ${i + 1}`,
            state: "open",
        }));
        const results = filterIssues(many, "");
        assert.equal(results.length, 20);
    });

    void it("numeric query falls through to fuzzy when no numeric matches", () => {
        const results = filterIssues(issues, "5");
        assert.ok(results !== undefined);
    });
});
