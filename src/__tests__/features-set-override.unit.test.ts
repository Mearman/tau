/**
 * Tests for setFeatureOverride — the function that applies a feature
 * toggle at a specific scope (in-memory or file-based).
 */

import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TauState } from "../state.ts";
import { setFeatureOverride } from "../features/features-state.ts";

const TEST_ROOT = join(tmpdir(), "tau-test-set-override");

before(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

void describe("setFeatureOverride", () => {
    void it("sets a temporary override", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "temporary");
        assert.equal(state.featureOverridesTemporary?.get("bookmark"), false);
    });

    void it("sets a session override", () => {
        const state = new TauState();
        setFeatureOverride(state, "goal", true, "session");
        assert.equal(state.featureOverridesSession?.get("goal"), true);
    });

    void it("sets a thread override", () => {
        const state = new TauState();
        setFeatureOverride(state, "loop", false, "thread");
        assert.equal(state.featureOverridesThread?.get("loop"), false);
    });

    void it("creates and writes to cwd/.pi/settings.json", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "cwd", {
            cwd: TEST_ROOT,
        });
        assert.deepEqual(state.cwdFeatures, { bookmark: false });
    });

    void it("throws for project scope when no project settings file exists", () => {
        const state = new TauState();
        assert.throws(
            () =>
                setFeatureOverride(state, "bookmark", false, "project", {
                    cwd: TEST_ROOT,
                }),
            /no project settings file found/
        );
    });

    void it("writes to global settings when homeDir is provided", () => {
        const state = new TauState();
        const homeDir = join(TEST_ROOT, "home");
        mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });

        setFeatureOverride(state, "bookmark", false, "global", { homeDir });
        assert.deepEqual(state.globalFeatures, { bookmark: false });
    });

    void it("updates an existing temporary override", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "temporary");
        setFeatureOverride(state, "bookmark", true, "temporary");
        assert.equal(state.featureOverridesTemporary?.get("bookmark"), true);
    });

    void it("preserves other overrides when setting a new one", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "temporary");
        setFeatureOverride(state, "goal", true, "temporary");
        assert.equal(state.featureOverridesTemporary?.get("bookmark"), false);
        assert.equal(state.featureOverridesTemporary?.get("goal"), true);
    });
});
