/**
 * Tests for the soft-toggle wiring helpers.
 *
 * `isFeatureEnabled` and `getFeatureSource` are thin wrappers around
 * `resolveFeature` that read the override fields off `TauState`. The
 * tests focus on the wrapper behaviour: state field → layer mapping,
 * default-on when no layer is populated, and the source round-trip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TauState } from "../state.ts";
import {
    featureLayersFromState,
    getFeatureSource,
    isFeatureEnabled,
    resolveFeatureFromState,
} from "../features/features-helpers.ts";

function makeState(overrides: Partial<TauState> = {}): TauState {
    return overrides as unknown as TauState;
}

void describe("featureLayersFromState", () => {
    void it("returns empty layers for an empty state", () => {
        const layers = featureLayersFromState(makeState());
        assert.deepEqual(layers, {
            temporary: undefined,
            session: undefined,
            thread: undefined,
            cwd: undefined,
            project: undefined,
            global: undefined,
        });
    });

    void it("passes the override maps through unchanged", () => {
        const temp = new Map([["bookmark", false]]);
        const sess = new Map([["task", true]]);
        const cwd = { goal: false };
        const project = { preset: true };
        const global = { bookmark: true };

        const layers = featureLayersFromState(
            makeState({
                featureOverridesTemporary: temp,
                featureOverridesSession: sess,
                cwdFeatures: cwd,
                projectFeatures: project,
                globalFeatures: global,
            })
        );

        assert.strictEqual(layers.temporary, temp);
        assert.strictEqual(layers.session, sess);
        assert.strictEqual(layers.cwd, cwd);
        assert.strictEqual(layers.project, project);
        assert.strictEqual(layers.global, global);
    });
});

void describe("isFeatureEnabled", () => {
    void it("returns true by default (no layer set)", () => {
        assert.equal(isFeatureEnabled(makeState(), "bookmark"), true);
    });

    void it("returns false when cwd sets it off", () => {
        const state = makeState({ cwdFeatures: { bookmark: false } });
        assert.equal(isFeatureEnabled(state, "bookmark"), false);
    });

    void it("returns true when global sets it on", () => {
        const state = makeState({ globalFeatures: { bookmark: true } });
        assert.equal(isFeatureEnabled(state, "bookmark"), true);
    });

    void it("temporary override beats cwd", () => {
        const state = makeState({
            featureOverridesTemporary: new Map([["bookmark", true]]),
            cwdFeatures: { bookmark: false },
        });
        assert.equal(isFeatureEnabled(state, "bookmark"), true);
    });
});

void describe("getFeatureSource", () => {
    void it("returns 'default' when no layer is set", () => {
        assert.equal(getFeatureSource(makeState(), "bookmark"), "default");
    });

    void it("returns 'cwd' when cwd is the first layer with a value", () => {
        const state = makeState({ cwdFeatures: { bookmark: true } });
        assert.equal(getFeatureSource(state, "bookmark"), "cwd");
    });

    void it("returns 'project' when project is set but cwd is not", () => {
        const state = makeState({ projectFeatures: { bookmark: false } });
        assert.equal(getFeatureSource(state, "bookmark"), "project");
    });

    void it("returns 'global' when only global is set", () => {
        const state = makeState({ globalFeatures: { bookmark: true } });
        assert.equal(getFeatureSource(state, "bookmark"), "global");
    });
});

void describe("resolveFeatureFromState", () => {
    void it("returns both value and source", () => {
        const state = makeState({ cwdFeatures: { bookmark: false } });
        assert.deepEqual(resolveFeatureFromState(state, "bookmark"), {
            value: false,
            source: "cwd",
        });
    });
});
