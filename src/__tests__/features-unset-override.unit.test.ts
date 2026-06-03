/**
 * Tests for unsetFeatureOverride — removing a feature override at a
 * specific scope (in-memory or file-based).
 */

import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TauState } from "../state.ts";
import {
    setFeatureOverride,
    unsetFeatureOverride,
} from "../features/features-state.ts";

const TEST_ROOT = join(tmpdir(), "tau-test-features-unset");

before(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

function readJsonFile(path: string): Record<string, unknown> {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(`expected object at ${path}`);
    }
    return parsed as Record<string, unknown>;
}

void describe("unsetFeatureOverride", () => {
    void it("deletes from the temporary map", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "temporary");
        unsetFeatureOverride(state, "bookmark", "temporary");
        assert.equal(state.featureOverridesTemporary?.has("bookmark"), false);
    });

    void it("deletes from the session map", () => {
        const state = new TauState();
        setFeatureOverride(state, "goal", false, "session");
        unsetFeatureOverride(state, "goal", "session");
        assert.equal(state.featureOverridesSession?.has("goal"), false);
    });

    void it("deletes from the thread map", () => {
        const state = new TauState();
        setFeatureOverride(state, "preset", false, "thread");
        unsetFeatureOverride(state, "preset", "thread");
        assert.equal(state.featureOverridesThread?.has("preset"), false);
    });

    void it("is a no-op when the map is undefined", () => {
        const state = new TauState();
        // No prior set — maps are undefined.
        unsetFeatureOverride(state, "bookmark", "temporary");
        assert.equal(state.featureOverridesTemporary, undefined);
    });

    void it("is a no-op when the key is not in the map", () => {
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "temporary");
        unsetFeatureOverride(state, "goal", "temporary");
        assert.equal(state.featureOverridesTemporary?.get("bookmark"), false);
    });

    void it("removes the key from the cwd file", () => {
        const state = new TauState();
        const cwd = join(TEST_ROOT, "project");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        setFeatureOverride(state, "bookmark", false, "cwd", { cwd });
        unsetFeatureOverride(state, "bookmark", "cwd", { cwd });
        assert.deepEqual(state.cwdFeatures, {});
    });

    void it("preserves other features in the cwd file", () => {
        const state = new TauState();
        const cwd = join(TEST_ROOT, "project");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        setFeatureOverride(state, "bookmark", false, "cwd", { cwd });
        setFeatureOverride(state, "goal", true, "cwd", { cwd });
        unsetFeatureOverride(state, "bookmark", "cwd", { cwd });
        assert.deepEqual(state.cwdFeatures, { goal: true });
    });

    void it("removes the key from the global file", () => {
        const homeDir = join(TEST_ROOT, "home");
        mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "global", { homeDir });
        unsetFeatureOverride(state, "bookmark", "global", { homeDir });
        assert.deepEqual(state.globalFeatures, {});
    });

    void it("throws for project scope when no settings file exists", () => {
        const state = new TauState();
        const cwd = join(TEST_ROOT, "no-project");
        mkdirSync(cwd, { recursive: true });
        assert.throws(
            () =>
                unsetFeatureOverride(state, "bookmark", "project", {
                    cwd,
                }),
            /no project settings file found/
        );
    });

    void it("removes the key from the project file", () => {
        const gitRoot = join(TEST_ROOT, "git-root");
        mkdirSync(join(gitRoot, ".git"), { recursive: true });
        mkdirSync(join(gitRoot, ".pi"), { recursive: true });
        writeFileSync(join(gitRoot, ".pi", "settings.json"), "{}");
        const cwd = join(gitRoot, "sub");
        mkdirSync(cwd, { recursive: true });

        const state = new TauState();
        setFeatureOverride(state, "bookmark", false, "project", { cwd });
        unsetFeatureOverride(state, "bookmark", "project", { cwd });
        assert.deepEqual(state.projectFeatures, {});
    });

    void it("preserves non-tau keys in the file after removal", () => {
        const cwd = join(TEST_ROOT, "project");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        const settingsPath = join(cwd, ".pi", "settings.json");
        writeFileSync(
            settingsPath,
            JSON.stringify({
                compaction: { enabled: true },
                tau: { features: { bookmark: false } },
            })
        );
        const state = new TauState();
        state.cwdFeatures = { bookmark: false };
        unsetFeatureOverride(state, "bookmark", "cwd", { cwd });
        const json = readJsonFile(settingsPath);
        assert.deepEqual(json["compaction"], { enabled: true });
    });
});
