/**
 * Tests for the tau feature scope resolver.
 *
 * The resolver takes a feature id and a layered view of override maps and
 * records, and returns the effective boolean plus the source layer. Layers
 * are walked highest-to-lowest priority and the first match wins. Missing
 * entries fall through to the next layer. Default is `true` (feature on)
 * if no layer provides a value.
 *
 * Priority order (highest first):
 *   temporary → thread → session → cwd → project → global → default
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    resolveFeature,
    type FeatureLayers,
} from "../features/features-resolver.ts";

void describe("resolveFeature", () => {
    void it("returns the default value (true) when no layer provides a value", () => {
        const result = resolveFeature("bookmark", {});
        assert.deepEqual(result, { value: true, source: "default" });
    });

    void it("ignores empty layers and still returns the default", () => {
        const layers: FeatureLayers = {
            temporary: new Map(),
            thread: new Map(),
            session: new Map(),
            cwd: {},
            project: {},
            global: {},
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "default" });
    });

    void it("treats undefined layers as empty (no entries to consult)", () => {
        const layers: FeatureLayers = {
            temporary: undefined,
            thread: undefined,
            session: undefined,
            cwd: undefined,
            project: undefined,
            global: undefined,
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "default" });
    });

    void it("returns the temporary layer's value when only temporary is set", () => {
        const layers: FeatureLayers = {
            temporary: new Map([["bookmark", false]]),
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "temporary" });
    });

    void it("returns the thread layer's value when only thread is set", () => {
        const layers: FeatureLayers = {
            thread: new Map([["bookmark", true]]),
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "thread" });
    });

    void it("returns the session layer's value when only session is set", () => {
        const layers: FeatureLayers = {
            session: new Map([["bookmark", false]]),
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "session" });
    });

    void it("returns the cwd layer's value when only cwd is set", () => {
        const layers: FeatureLayers = {
            cwd: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "cwd" });
    });

    void it("returns the project layer's value when only project is set", () => {
        const layers: FeatureLayers = {
            project: { bookmark: false },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "project" });
    });

    void it("returns the global layer's value when only global is set", () => {
        const layers: FeatureLayers = {
            global: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "global" });
    });

    void it("temporary beats thread when both are set", () => {
        const layers: FeatureLayers = {
            temporary: new Map([["bookmark", true]]),
            thread: new Map([["bookmark", false]]),
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "temporary" });
    });

    void it("thread beats session when both are set", () => {
        const layers: FeatureLayers = {
            thread: new Map([["bookmark", false]]),
            session: new Map([["bookmark", true]]),
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "thread" });
    });

    void it("session beats cwd when both are set", () => {
        const layers: FeatureLayers = {
            session: new Map([["bookmark", true]]),
            cwd: { bookmark: false },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "session" });
    });

    void it("cwd beats project when both are set", () => {
        const layers: FeatureLayers = {
            cwd: { bookmark: false },
            project: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "cwd" });
    });

    void it("project beats global when both are set", () => {
        const layers: FeatureLayers = {
            project: { bookmark: true },
            global: { bookmark: false },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "project" });
    });

    void it("global beats default when both are set", () => {
        const layers: FeatureLayers = {
            global: { bookmark: false },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "global" });
    });

    void it("falls through missing keys within a layer to the next layer", () => {
        const layers: FeatureLayers = {
            cwd: { other: false },
            project: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "project" });
    });

    void it("falls through a layer that has the id but maps to undefined", () => {
        const layers: FeatureLayers = {
            cwd: { bookmark: undefined as unknown as boolean },
            project: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "project" });
    });

    void it("queries are case-sensitive — mismatched case falls through", () => {
        const layers: FeatureLayers = {
            cwd: { Bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: true, source: "default" });
    });

    void it("all seven layers set, temporary wins", () => {
        const layers: FeatureLayers = {
            temporary: new Map([["bookmark", false]]),
            thread: new Map([["bookmark", true]]),
            session: new Map([["bookmark", false]]),
            cwd: { bookmark: true },
            project: { bookmark: false },
            global: { bookmark: true },
        };
        const result = resolveFeature("bookmark", layers);
        assert.deepEqual(result, { value: false, source: "temporary" });
    });
});
