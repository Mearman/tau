/**
 * Unit tests for agent-sdk settings parsing and merge precedence.
 * No SDK dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    parseAgentSdkSettings,
    readAgentSdkSettingsFromFile,
    loadAgentSdkSettings,
} from "../features/agent-sdk/settings.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

void describe("parseAgentSdkSettings", () => {
    void it("defaults authMode to subscription", () => {
        assert.equal(parseAgentSdkSettings({})?.authMode, "subscription");
    });

    void it("defaults mode to flatten", () => {
        assert.equal(parseAgentSdkSettings({})?.mode, "flatten");
    });

    void it("reads an explicit session mode", () => {
        assert.equal(
            parseAgentSdkSettings({ mode: "session" })?.mode,
            "session"
        );
    });

    void it("ignores an invalid mode and keeps the flatten default", () => {
        assert.equal(parseAgentSdkSettings({ mode: "bogus" })?.mode, "flatten");
    });

    void it("reads an explicit apiKey authMode", () => {
        assert.equal(
            parseAgentSdkSettings({ authMode: "apiKey" })?.authMode,
            "apiKey"
        );
    });

    void it("ignores an invalid authMode and keeps the default", () => {
        assert.equal(
            parseAgentSdkSettings({ authMode: "bogus" })?.authMode,
            "subscription"
        );
    });

    void it("validates settingSources", () => {
        assert.deepEqual(
            parseAgentSdkSettings({ settingSources: ["user", "project"] })
                ?.settingSources,
            ["user", "project"]
        );
        assert.equal(
            parseAgentSdkSettings({ settingSources: ["user", "bogus"] })
                ?.settingSources,
            undefined
        );
    });

    void it("returns undefined for non-object input", () => {
        assert.equal(parseAgentSdkSettings(null), undefined);
        assert.equal(parseAgentSdkSettings("x"), undefined);
        assert.equal(parseAgentSdkSettings([1, 2]), undefined);
    });
});

void describe("readAgentSdkSettingsFromFile", () => {
    void it("reads the tau.claudeAgentSdk block", () => {
        const dir = mkdtempSync(join(tmpdir(), "tau-sdk-cfg-"));
        try {
            const path = join(dir, "settings.json");
            writeFileSync(
                path,
                JSON.stringify({
                    tau: {
                        claudeAgentSdk: {
                            authMode: "apiKey",
                            strictMcpConfig: true,
                        },
                    },
                    other: { keep: true },
                })
            );
            const settings = readAgentSdkSettingsFromFile(path);
            assert.equal(settings?.authMode, "apiKey");
            assert.equal(settings?.strictMcpConfig, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("returns undefined for a missing file", () => {
        assert.equal(
            readAgentSdkSettingsFromFile("/no/such/path/settings.json"),
            undefined
        );
    });

    void it("returns undefined for malformed JSON", () => {
        const dir = mkdtempSync(join(tmpdir(), "tau-sdk-cfg-"));
        try {
            const path = join(dir, "settings.json");
            writeFileSync(path, "{ not json");
            assert.equal(readAgentSdkSettingsFromFile(path), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

void describe("loadAgentSdkSettings", () => {
    void it("returns defaults when no settings exist", () => {
        const dir = mkdtempSync(join(tmpdir(), "tau-sdk-cfg-"));
        try {
            // A cwd with no .pi/settings.json and assume no global block.
            const settings = loadAgentSdkSettings(dir);
            assert.equal(settings.authMode, "subscription");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("project settings override global", () => {
        const globalDir = mkdtempSync(join(tmpdir(), "tau-sdk-cfg-g-"));
        const projectDir = mkdtempSync(join(tmpdir(), "tau-sdk-cfg-p-"));
        try {
            writeFileSync(
                join(globalDir, "settings.json"),
                JSON.stringify({
                    tau: { claudeAgentSdk: { authMode: "apiKey" } },
                })
            );
            writeFileSync(
                join(projectDir, "settings.json"),
                JSON.stringify({
                    tau: {
                        claudeAgentSdk: {
                            authMode: "subscription",
                            strictMcpConfig: true,
                        },
                    },
                })
            );
            const settings = loadAgentSdkSettings(projectDir, {
                global: join(globalDir, "settings.json"),
                project: join(projectDir, "settings.json"),
            });
            // Project wins over global for authMode...
            assert.equal(settings.authMode, "subscription");
            // ...and project-only fields are present.
            assert.equal(settings.strictMcpConfig, true);
        } finally {
            rmSync(globalDir, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });
});
