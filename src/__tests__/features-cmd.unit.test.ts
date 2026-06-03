/**
 * Tests for the /tau command's argument parser and autocomplete.
 *
 * The parser turns the raw arg string into a structured ParsedArgs object.
 * The autocomplete function returns suggestions for the current cursor
 * position.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTauArgs, getTauCompletions } from "../features/features-cmd.ts";

void describe("parseTauArgs", () => {
    void it("returns list for empty input", () => {
        assert.deepEqual(parseTauArgs(""), { kind: "list" });
    });

    void it("returns list for 'features' alone", () => {
        assert.deepEqual(parseTauArgs("features"), { kind: "list" });
    });

    void it("parses 'features get <id>'", () => {
        assert.deepEqual(parseTauArgs("features get bookmark"), {
            kind: "get",
            id: "bookmark",
        });
    });

    void it("parses 'features set <id> on'", () => {
        assert.deepEqual(parseTauArgs("features set bookmark on"), {
            kind: "set",
            id: "bookmark",
            value: true,
            scope: "temporary",
        });
    });

    void it("parses 'features set <id> off'", () => {
        assert.deepEqual(parseTauArgs("features set bookmark off"), {
            kind: "set",
            id: "bookmark",
            value: false,
            scope: "temporary",
        });
    });

    void it("parses 'features set <id> on --scope session'", () => {
        assert.deepEqual(
            parseTauArgs("features set bookmark on --scope session"),
            {
                kind: "set",
                id: "bookmark",
                value: true,
                scope: "session",
            }
        );
    });

    void it("parses 'features unset <id> --scope cwd'", () => {
        assert.deepEqual(parseTauArgs("features unset goal --scope cwd"), {
            kind: "unset",
            id: "goal",
            scope: "cwd",
        });
    });

    void it("defaults scope to temporary for set", () => {
        assert.deepEqual(parseTauArgs("features set goal off"), {
            kind: "set",
            id: "goal",
            value: false,
            scope: "temporary",
        });
    });

    void it("errors on unknown verb", () => {
        assert.deepEqual(parseTauArgs("features destroy bookmark"), {
            kind: "error",
            message: "unknown verb 'destroy'",
        });
    });

    void it("errors on missing id for get", () => {
        assert.deepEqual(parseTauArgs("features get"), {
            kind: "error",
            message: "missing feature id",
        });
    });

    void it("errors on missing value for set", () => {
        assert.deepEqual(parseTauArgs("features set bookmark"), {
            kind: "error",
            message: "missing value (on or off)",
        });
    });

    void it("errors on invalid value", () => {
        assert.deepEqual(parseTauArgs("features set bookmark maybe"), {
            kind: "error",
            message: "invalid value 'maybe' — expected on or off",
        });
    });

    void it("errors on unknown scope", () => {
        assert.deepEqual(
            parseTauArgs("features set bookmark on --scope banana"),
            {
                kind: "error",
                message:
                    "unknown scope 'banana' — expected temporary, thread, session, cwd, project, global",
            }
        );
    });

    void it("errors on unknown feature id", () => {
        assert.deepEqual(parseTauArgs("features get nonexistent"), {
            kind: "error",
            message: "unknown feature 'nonexistent'",
        });
    });
});

void describe("getTauCompletions", () => {
    void it("suggests 'features' for empty input", () => {
        const completions = getTauCompletions("");
        assert.ok(completions !== null);
        assert.ok(completions.some((c) => c.value === "features"));
    });

    void it("suggests verbs after 'features '", () => {
        const completions = getTauCompletions("features ");
        assert.ok(completions !== null);
        const values = completions.map((c) => c.value);
        assert.ok(values.includes("set"));
        assert.ok(values.includes("get"));
        assert.ok(values.includes("unset"));
    });

    void it("suggests feature ids after 'features set '", () => {
        const completions = getTauCompletions("features set ");
        assert.ok(completions !== null);
        assert.ok(completions.some((c) => c.value === "bookmark"));
        assert.ok(completions.some((c) => c.value === "goal"));
    });

    void it("suggests on/off after 'features set bookmark '", () => {
        const completions = getTauCompletions("features set bookmark ");
        assert.ok(completions !== null);
        const values = completions.map((c) => c.value);
        assert.ok(values.includes("on"));
        assert.ok(values.includes("off"));
    });

    void it("suggests scopes after '--scope '", () => {
        const completions = getTauCompletions(
            "features set bookmark on --scope "
        );
        assert.ok(completions !== null);
        const values = completions.map((c) => c.value);
        assert.ok(values.includes("temporary"));
        assert.ok(values.includes("thread"));
        assert.ok(values.includes("session"));
        assert.ok(values.includes("cwd"));
        assert.ok(values.includes("project"));
        assert.ok(values.includes("global"));
    });

    void it("suggests feature ids after 'features get '", () => {
        const completions = getTauCompletions("features get ");
        assert.ok(completions !== null);
        assert.ok(completions.some((c) => c.value === "bookmark"));
    });

    void it("filters completions by prefix", () => {
        const completions = getTauCompletions("features set go");
        assert.ok(completions !== null);
        assert.ok(completions.some((c) => c.value === "goal"));
        // Should not include features that don't start with 'go'
        assert.ok(!completions.some((c) => c.value === "bookmark"));
    });

    void it("returns the matching scope for a fully typed command", () => {
        const completions = getTauCompletions(
            "features set bookmark on --scope session"
        );
        assert.ok(completions !== null);
        assert.ok(completions.some((c) => c.value === "session"));
    });
});
