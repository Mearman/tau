/**
 * Unit tests for agent-sdk auth determinism helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    assertSubscriptionAuth,
    buildSdkEnv,
    isSubscriptionAuthSource,
    SubscriptionAuthError,
} from "../features/agent-sdk/auth.ts";

void describe("isSubscriptionAuthSource", () => {
    void it("treats oauth as subscription", () => {
        assert.equal(isSubscriptionAuthSource("oauth"), true);
    });

    void it("treats 'none' (no API key found) as subscription", () => {
        // The normal subscription-mode value: ANTHROPIC_API_KEY is scrubbed, so
        // the SDK finds no key and falls back to the OAuth login.
        assert.equal(isSubscriptionAuthSource("none"), true);
    });

    void it("treats an absent source as subscription", () => {
        assert.equal(isSubscriptionAuthSource(undefined), true);
    });

    void it("treats api-key sources as non-subscription", () => {
        assert.equal(isSubscriptionAuthSource("user"), false);
        assert.equal(isSubscriptionAuthSource("project"), false);
        assert.equal(isSubscriptionAuthSource("org"), false);
        assert.equal(isSubscriptionAuthSource("temporary"), false);
    });
});

void describe("buildSdkEnv", () => {
    void it("scrubs ANTHROPIC_API_KEY in subscription mode", () => {
        const prev = process.env["ANTHROPIC_API_KEY"];
        process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
        try {
            const env = buildSdkEnv("subscription");
            assert.equal(env["ANTHROPIC_API_KEY"], undefined);
            // Other vars are still inherited.
            assert.equal(env["PATH"], process.env["PATH"]);
        } finally {
            if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
            else process.env["ANTHROPIC_API_KEY"] = prev;
        }
    });

    void it("preserves ANTHROPIC_API_KEY in apiKey mode", () => {
        const prev = process.env["ANTHROPIC_API_KEY"];
        process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
        try {
            const env = buildSdkEnv("apiKey");
            assert.equal(env["ANTHROPIC_API_KEY"], "sk-ant-test");
        } finally {
            if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
            else process.env["ANTHROPIC_API_KEY"] = prev;
        }
    });
});

void describe("assertSubscriptionAuth", () => {
    void it("passes when oauth is detected in subscription mode", () => {
        assert.doesNotThrow(() =>
            assertSubscriptionAuth("oauth", "subscription")
        );
    });

    void it("throws when an api-key source is detected in subscription mode", () => {
        assert.throws(
            () => assertSubscriptionAuth("user", "subscription"),
            SubscriptionAuthError
        );
    });

    void it("is a no-op in apiKey mode regardless of source", () => {
        assert.doesNotThrow(() => assertSubscriptionAuth("user", "apiKey"));
        assert.doesNotThrow(() => assertSubscriptionAuth(undefined, "apiKey"));
    });

    void it("reports the detected source in the error", () => {
        try {
            assertSubscriptionAuth("temporary", "subscription");
            assert.fail("expected throw");
        } catch (error) {
            assert.ok(error instanceof SubscriptionAuthError);
            assert.equal(error.detectedSource, "temporary");
            assert.match((error as Error).message, /temporary/);
        }
    });
});
