/**
 * Tests for the tau feature file I/O layer.
 *
 * `readTauFeatures` and `writeTauFeature` read/write the `tau.features`
 * sub-object of `.pi/settings.json` (or `~/.pi/agent/settings.json` for
 * the global layer). `findProjectSettingsFile` and `walkProjectLayers`
 * walk the directory tree from cwd up to the git root.
 *
 * The tests use a real temp directory; we clean up at the end of each
 * test rather than relying on snapshot mocking.
 */

import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    findProjectSettingsFile,
    readTauFeatures,
    removeTauFeature,
    walkProjectLayers,
    writeTauFeature,
} from "../features/features-files.ts";

const TEST_ROOT = join(tmpdir(), "tau-test-features-files");

before(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
});

/**
 * Parse a settings file with a runtime-checked return type. The
 * production `features-files.ts` follows the same JSON-parse-then-narrow
 * pattern; this helper keeps the tests in lockstep.
 */
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

void describe("readTauFeatures", () => {
    void it("returns an empty object for a non-existent file", () => {
        const path = join(TEST_ROOT, "missing.json");
        assert.deepEqual(readTauFeatures(path), {});
    });

    void it("returns an empty object for a file with no tau key", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(path, JSON.stringify({ compaction: { enabled: true } }));
        assert.deepEqual(readTauFeatures(path), {});
    });

    void it("returns an empty object for a file with tau but no features key", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(path, JSON.stringify({ tau: { otherKey: true } }));
        assert.deepEqual(readTauFeatures(path), {});
    });

    void it("returns the features object when present", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(
            path,
            JSON.stringify({
                tau: { features: { bookmark: false, goal: true } },
            })
        );
        assert.deepEqual(readTauFeatures(path), {
            bookmark: false,
            goal: true,
        });
    });

    void it("returns an empty object for malformed JSON", () => {
        const path = join(TEST_ROOT, "broken.json");
        writeFileSync(path, "{not valid json");
        assert.deepEqual(readTauFeatures(path), {});
    });

    void it("returns an empty object for a non-object root", () => {
        const path = join(TEST_ROOT, "array.json");
        writeFileSync(path, "[1, 2, 3]");
        assert.deepEqual(readTauFeatures(path), {});
    });
});

void describe("writeTauFeature", () => {
    void it("creates the file and parent directory if missing", () => {
        const path = join(TEST_ROOT, "nested", "settings.json");
        writeTauFeature(path, "bookmark", false);
        assert.ok(existsSync(path));
        const json = readJsonFile(path);
        assert.deepEqual(json["tau"], { features: { bookmark: false } });
    });

    void it("preserves other top-level keys", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(path, JSON.stringify({ compaction: { enabled: true } }));
        writeTauFeature(path, "bookmark", true);
        const json = readJsonFile(path);
        assert.deepEqual(json["compaction"], { enabled: true });
        assert.deepEqual(json["tau"], { features: { bookmark: true } });
    });

    void it("preserves other tau keys", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(path, JSON.stringify({ tau: { otherKey: "keep" } }));
        writeTauFeature(path, "bookmark", false);
        const json = readJsonFile(path);
        const tau = json["tau"] as Record<string, unknown>;
        assert.equal(tau["otherKey"], "keep");
        assert.deepEqual(tau["features"], { bookmark: false });
    });

    void it("updates an existing feature value", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeTauFeature(path, "bookmark", false);
        writeTauFeature(path, "bookmark", true);
        const json = readJsonFile(path);
        const features = (json["tau"] as Record<string, unknown>)[
            "features"
        ] as Record<string, boolean>;
        assert.equal(features["bookmark"], true);
    });

    void it("writes multiple features independently", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeTauFeature(path, "bookmark", false);
        writeTauFeature(path, "goal", true);
        const json = readJsonFile(path);
        const features = (json["tau"] as Record<string, unknown>)[
            "features"
        ] as Record<string, boolean>;
        assert.deepEqual(features, { bookmark: false, goal: true });
    });
});

void describe("removeTauFeature", () => {
    void it("is a no-op if the file does not exist", () => {
        const path = join(TEST_ROOT, "missing.json");
        // Should not throw.
        removeTauFeature(path, "bookmark");
    });

    void it("removes the feature key while preserving other features", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeTauFeature(path, "bookmark", false);
        writeTauFeature(path, "goal", true);
        removeTauFeature(path, "bookmark");
        const features = readTauFeatures(path);
        assert.deepEqual(features, { goal: true });
    });

    void it("preserves other top-level and tau keys", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(
            path,
            JSON.stringify({
                compaction: { enabled: true },
                tau: { features: { bookmark: false }, otherKey: "keep" },
            })
        );
        removeTauFeature(path, "bookmark");
        const json = readJsonFile(path);
        assert.deepEqual(json["compaction"], { enabled: true });
        const tau = json["tau"] as Record<string, unknown>;
        assert.equal(tau["otherKey"], "keep");
        assert.deepEqual(tau["features"], {});
    });

    void it("is a no-op if the key does not exist in features", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeTauFeature(path, "goal", true);
        removeTauFeature(path, "bookmark");
        const features = readTauFeatures(path);
        assert.deepEqual(features, { goal: true });
    });

    void it("is a no-op if the file has no tau key", () => {
        const path = join(TEST_ROOT, "settings.json");
        writeFileSync(path, JSON.stringify({ compaction: { enabled: true } }));
        removeTauFeature(path, "bookmark");
        const json = readJsonFile(path);
        assert.deepEqual(json, { compaction: { enabled: true } });
    });
});

void describe("findProjectSettingsFile", () => {
    void it("returns undefined when no .pi/settings.json exists in the tree", () => {
        // TEST_ROOT has no .pi folder and no .git folder, so the walk
        // goes all the way up to the system root.
        const result = findProjectSettingsFile(TEST_ROOT);
        assert.equal(result, undefined);
    });

    void it("returns the path to .pi/settings.json when present in cwd", () => {
        const cwd = join(TEST_ROOT, "with-cwd");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
        const result = findProjectSettingsFile(cwd);
        assert.equal(result, join(cwd, ".pi", "settings.json"));
    });
});

void describe("walkProjectLayers", () => {
    void it("returns an empty array when no settings files exist", () => {
        const result = walkProjectLayers(TEST_ROOT);
        assert.deepEqual(result, []);
    });

    void it("returns the cwd's settings file when present", () => {
        const cwd = join(TEST_ROOT, "with-cwd");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        const settingsPath = join(cwd, ".pi", "settings.json");
        writeFileSync(settingsPath, "{}");
        const result = walkProjectLayers(cwd);
        assert.ok(result.includes(settingsPath));
    });

    void it("stops walking at the git root", () => {
        // Create a fake git root at the parent, with a settings file
        // there. The walk should not look past the .git directory.
        const gitRoot = join(TEST_ROOT, "fake-git-root");
        mkdirSync(join(gitRoot, ".git"), { recursive: true });
        mkdirSync(join(gitRoot, ".pi"), { recursive: true });
        writeFileSync(join(gitRoot, ".pi", "settings.json"), "{}");

        // cwd is a child of the git root.
        const cwd = join(gitRoot, "sub", "deeper");
        mkdirSync(cwd, { recursive: true });

        const result = walkProjectLayers(cwd);
        // Should find the git root's file, but not look above it for
        // TEST_ROOT (which has no .git).
        assert.deepEqual(result, [join(gitRoot, ".pi", "settings.json")]);
    });

    void it("returns cwd's file first, then ancestors in walk order", () => {
        // No .git anywhere, so the walk proceeds up to TEST_ROOT's parent.
        // We'll add files at two levels and check the order.
        const inner = join(TEST_ROOT, "outer", "inner");
        const outer = join(TEST_ROOT, "outer");
        mkdirSync(join(inner, ".pi"), { recursive: true });
        mkdirSync(join(outer, ".pi"), { recursive: true });
        writeFileSync(join(inner, ".pi", "settings.json"), "{}");
        writeFileSync(join(outer, ".pi", "settings.json"), "{}");

        const result = walkProjectLayers(inner);
        // Inner (closer) should come first.
        assert.deepEqual(result, [
            join(inner, ".pi", "settings.json"),
            join(outer, ".pi", "settings.json"),
        ]);
    });
});
