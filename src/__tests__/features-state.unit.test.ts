/**
 * Tests for the tau feature state restoration module.
 *
 * `restoreFeaturesState` is called at `session_start` and `session_tree`.
 * It clears ephemeral maps, reads the most recent `tau-features-thread`
 * entry from the current branch, and reads file-based layers from disk.
 */

import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TauState } from "../state.ts";
import { restoreFeaturesState } from "../features/features-state.ts";

const TEST_ROOT = join(tmpdir(), "tau-test-features-state");

before(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

// ─── Mock context ───────────────────────────────────────────────────

function makeCtx(
    branch: Array<{ type: string; customType?: string; data?: unknown }> = []
) {
    return {
        cwd: TEST_ROOT,
        ui: {
            notify: (_msg: string, _level?: string) => {},
        },
        sessionManager: {
            getBranch: () => branch,
        },
    } as unknown as Parameters<typeof restoreFeaturesState>[1];
}

void describe("restoreFeaturesState", () => {
    void it("clears temporary and session maps on restore", () => {
        const state = new TauState();
        state.featureOverridesTemporary = new Map([["bookmark", false]]);
        state.featureOverridesSession = new Map([["goal", false]]);

        restoreFeaturesState(state, makeCtx());

        assert.equal(state.featureOverridesTemporary, undefined);
        assert.equal(state.featureOverridesSession, undefined);
    });

    void it("reads the most recent tau-features-thread entry from branch", () => {
        const state = new TauState();
        const branch = [
            {
                type: "custom",
                customType: "tau-features-thread",
                data: { bookmark: false },
            },
            {
                type: "custom",
                customType: "tau-features-thread",
                data: { bookmark: true, goal: false },
            },
        ];

        restoreFeaturesState(state, makeCtx(branch));

        assert.ok(state.featureOverridesThread instanceof Map);
        assert.equal(state.featureOverridesThread?.get("bookmark"), true);
        assert.equal(state.featureOverridesThread?.get("goal"), false);
    });

    void it("ignores entries with a different customType", () => {
        const state = new TauState();
        const branch = [
            {
                type: "custom",
                customType: "tau-goal-state",
                data: { condition: "fix all tests" },
            },
        ];

        restoreFeaturesState(state, makeCtx(branch));

        assert.equal(state.featureOverridesThread, undefined);
    });

    void it("reads global features from ~/.pi/agent/settings.json", () => {
        const state = new TauState();
        const globalDir = join(TEST_ROOT, "home", ".pi", "agent");
        mkdirSync(globalDir, { recursive: true });
        writeFileSync(
            join(globalDir, "settings.json"),
            JSON.stringify({ tau: { features: { bookmark: false } } })
        );

        // Pass a custom HOME override via the options parameter.
        restoreFeaturesState(state, makeCtx(), {
            homeDir: join(TEST_ROOT, "home"),
        });

        assert.deepEqual(state.globalFeatures, { bookmark: false });
    });

    void it("reads cwd features from cwd/.pi/settings.json", () => {
        const state = new TauState();
        const piDir = join(TEST_ROOT, ".pi");
        mkdirSync(piDir, { recursive: true });
        writeFileSync(
            join(piDir, "settings.json"),
            JSON.stringify({ tau: { features: { goal: true } } })
        );

        restoreFeaturesState(state, makeCtx());

        assert.deepEqual(state.cwdFeatures, { goal: true });
    });

    void it("handles empty branch with no thread entries", () => {
        const state = new TauState();

        restoreFeaturesState(state, makeCtx([]));

        assert.equal(state.featureOverridesThread, undefined);
    });
});
