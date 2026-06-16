/**
 * Unit tests for the agent-sdk tool name/argument mapping and tool resolution.
 * Pure transforms — no SDK runtime dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    mapPiArgsToSdk,
    mapPiToolNameToSdk,
    mapSdkArgsToPi,
    mapSdkToolNameToPi,
    resolveSdkTools,
} from "../features/agent-sdk/tools.ts";
import type { Context } from "@earendil-works/pi-ai";

void describe("mapSdkToolNameToPi", () => {
    void it("maps Claude Code built-ins to pi names", () => {
        assert.equal(mapSdkToolNameToPi("Read"), "read");
        assert.equal(mapSdkToolNameToPi("Write"), "write");
        assert.equal(mapSdkToolNameToPi("Edit"), "edit");
        assert.equal(mapSdkToolNameToPi("Bash"), "bash");
        assert.equal(mapSdkToolNameToPi("Grep"), "grep");
        assert.equal(mapSdkToolNameToPi("Glob"), "find");
    });

    void it("strips the custom-tools MCP prefix", () => {
        assert.equal(
            mapSdkToolNameToPi("mcp__custom-tools__subagent"),
            "subagent"
        );
    });

    void it("passes unknown names through unchanged", () => {
        assert.equal(mapSdkToolNameToPi("Mystery"), "Mystery");
    });

    void it("uses the custom map for non-builtin names", () => {
        const map = new Map([["Special", "pi-special"]]);
        assert.equal(mapSdkToolNameToPi("Special", map), "pi-special");
    });
});

void describe("mapPiToolNameToSdk", () => {
    void it("maps pi built-ins to Claude Code names (case-insensitive)", () => {
        assert.equal(mapPiToolNameToSdk("read"), "Read");
        assert.equal(mapPiToolNameToSdk("FIND"), "Glob");
        assert.equal(mapPiToolNameToSdk("grep"), "Grep");
    });

    void it("pascal-cases custom tool names", () => {
        assert.equal(mapPiToolNameToSdk("web_search"), "WebSearch");
        assert.equal(mapPiToolNameToSdk("my-tool"), "MyTool");
    });

    void it("prefers the custom map over the static table", () => {
        const map = new Map([["read", "OverrideRead"]]);
        assert.equal(mapPiToolNameToSdk("read", map), "OverrideRead");
    });
});

void describe("mapSdkArgsToPi", () => {
    void it("maps Read file_path -> path", () => {
        assert.deepEqual(
            mapSdkArgsToPi("read", {
                file_path: "/x",
                offset: 10,
                limit: 20,
            }),
            { path: "/x", offset: 10, limit: 20 }
        );
    });

    void it("wraps a single Edit pair into pi's edits array", () => {
        const out = mapSdkArgsToPi("edit", {
            file_path: "/x",
            old_string: "a",
            new_string: "b",
        });
        assert.deepEqual(out, {
            path: "/x",
            edits: [{ oldText: "a", newText: "b" }],
        });
    });

    void it("maps Grep head_limit -> limit and -i -> ignoreCase", () => {
        const out = mapSdkArgsToPi("grep", {
            pattern: "foo",
            path: "/x",
            "-i": true,
            head_limit: 5,
            glob: "*.ts",
        });
        assert.equal(out.ignoreCase, true);
        assert.equal(out.limit, 5);
        assert.equal(out.glob, "*.ts");
        assert.equal(out.pattern, "foo");
    });

    void it("passes custom tool args through unchanged", () => {
        assert.deepEqual(mapSdkArgsToPi("subagent", { a: 1 }), { a: 1 });
    });
});

void describe("mapPiArgsToSdk", () => {
    void it("maps read path -> file_path", () => {
        assert.deepEqual(
            mapPiArgsToSdk("read", { path: "/x", offset: 1, limit: 2 }),
            { file_path: "/x", offset: 1, limit: 2 }
        );
    });

    void it("flattens pi edit edits[0] -> old_string/new_string", () => {
        assert.deepEqual(
            mapPiArgsToSdk("edit", {
                path: "/x",
                edits: [{ oldText: "a", newText: "b" }],
            }),
            { file_path: "/x", old_string: "a", new_string: "b" }
        );
    });

    void it("maps grep limit -> head_limit", () => {
        const out = mapPiArgsToSdk("grep", {
            pattern: "x",
            path: "/p",
            limit: 9,
        });
        assert.equal(out.head_limit, 9);
    });
});

void describe("resolveSdkTools", () => {
    void it("returns default built-ins when no tools are active", () => {
        const result = resolveSdkTools({ messages: [] });
        assert.ok(result.sdkTools.includes("Read"));
        assert.ok(result.sdkTools.includes("Bash"));
        assert.equal(result.customTools.length, 0);
    });

    void it("partitions built-ins and custom tools", () => {
        const ctx: Context = {
            messages: [],
            tools: [
                { name: "read", description: "d", parameters: {} },
                { name: "bash", description: "d", parameters: {} },
                { name: "subagent", description: "d", parameters: {} },
                {
                    name: "web_search",
                    description: "d",
                    parameters: {},
                },
            ],
        };
        const result = resolveSdkTools(ctx);
        assert.deepEqual(result.sdkTools.sort(), ["Bash", "Read"]);
        assert.equal(result.customTools.length, 2);
        assert.equal(
            result.customToolNameToSdk.get("subagent"),
            "mcp__custom-tools__subagent"
        );
        assert.equal(
            result.customToolNameToPi.get("mcp__custom-tools__web_search"),
            "web_search"
        );
    });
});
