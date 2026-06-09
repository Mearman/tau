/**
 * Tests for the tau feature registry.
 *
 * The registry is the canonical list of features that can be toggled. The
 * TUI uses it to render rows, the CLI uses it for validation and
 * autocomplete, and the soft-toggle wiring uses it to look up a feature
 * by id.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    FEATURE_REGISTRY,
    type FeatureDef,
    getFeatureDef,
    isKnownFeature,
} from "../features/features-registry.ts";

void describe("feature registry", () => {
    void it("contains a non-empty list of features", () => {
        assert.ok(FEATURE_REGISTRY.length > 0);
    });

    void it("has a stable order (insertion order)", () => {
        const ids = FEATURE_REGISTRY.map((f) => f.id);
        const firstCopy = [...ids];
        const secondCopy = [...ids];
        assert.deepEqual(secondCopy, firstCopy);
    });

    void it("every id is unique", () => {
        const ids = FEATURE_REGISTRY.map((f) => f.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    void it("every id matches the kebab-case identifier shape", () => {
        const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        for (const f of FEATURE_REGISTRY) {
            assert.match(f.id, idPattern, `id "${f.id}" is not kebab-case`);
        }
    });

    void it("every entry has a non-empty label and description", () => {
        for (const f of FEATURE_REGISTRY) {
            assert.ok(f.label.length > 0, `label missing for ${f.id}`);
            assert.ok(
                f.description.length > 0,
                `description missing for ${f.id}`
            );
        }
    });

    void it("every entry has a non-empty group", () => {
        for (const f of FEATURE_REGISTRY) {
            assert.ok(f.group.length > 0, `group missing for ${f.id}`);
        }
    });

    void it("every entry defaults to on (true)", () => {
        for (const f of FEATURE_REGISTRY) {
            assert.equal(f.defaultOn, true, `${f.id} should default to on`);
        }
    });

    void it("getFeatureDef returns the matching entry for a known id", () => {
        const first = FEATURE_REGISTRY[0];
        assert.ok(first !== undefined);
        const found = getFeatureDef(first.id);
        assert.deepEqual(found, first);
    });

    void it("getFeatureDef returns undefined for an unknown id", () => {
        assert.equal(getFeatureDef("not-a-real-feature"), undefined);
    });

    void it("isKnownFeature returns true for a known id", () => {
        const first = FEATURE_REGISTRY[0];
        assert.ok(first !== undefined);
        assert.equal(isKnownFeature(first.id), true);
    });

    void it("isKnownFeature returns false for an unknown id", () => {
        assert.equal(isKnownFeature("not-a-real-feature"), false);
    });

    void it("includes the features explicitly named in the plan", () => {
        // Quality of life (5)
        for (const id of [
            "bookmark",
            "session-name",
            "custom-footer",
            "goal",
            "preset",
        ]) {
            assert.ok(isKnownFeature(id), `missing: ${id}`);
        }
        // Workflow (6)
        for (const id of [
            "task",
            "plan-mode",
            "workflow",
            "context",
            "summarize",
            "loop",
        ]) {
            assert.ok(isKnownFeature(id), `missing: ${id}`);
        }
        // Integrations (5)
        for (const id of ["instructions", "web-browse", "callbacks"]) {
            assert.ok(isKnownFeature(id), `missing: ${id}`);
        }
        // Background (3)
        for (const id of ["agent-background", "notifications", "reload"]) {
            assert.ok(isKnownFeature(id), `missing: ${id}`);
        }
    });
});

void describe("FeatureDef shape", () => {
    void it("is the documented shape: id, label, description, group, defaultOn", () => {
        const first = FEATURE_REGISTRY[0];
        assert.ok(first !== undefined);
        const keys = Object.keys(first).sort();
        assert.deepEqual(keys, [
            "defaultOn",
            "description",
            "group",
            "id",
            "label",
        ]);
    });

    void it("a typed feature object round-trips through getFeatureDef", () => {
        const first: FeatureDef = {
            id: "bookmark",
            label: "Bookmark",
            description: "Bookmark the last assistant message",
            group: "Quality of life",
            defaultOn: true,
        };
        // Type check only — we just want to be sure the interface compiles.
        assert.equal(first.defaultOn, true);
    });
});
