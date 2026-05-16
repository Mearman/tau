import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPresetDescription } from "../features/preset.ts";

void describe("buildPresetDescription", () => {
    void it("describes provider/model", () => {
        const result = buildPresetDescription({
            provider: "openai",
            model: "gpt-4",
        });
        assert.equal(result, "openai/gpt-4");
    });

    void it("includes thinking level", () => {
        const result = buildPresetDescription({ thinkingLevel: "high" });
        assert.equal(result, "thinking:high");
    });

    void it("includes tools", () => {
        const result = buildPresetDescription({
            tools: ["read", "bash"],
        });
        assert.equal(result, "tools:read,bash");
    });

    void it("includes truncated instructions", () => {
        const long = "a".repeat(50);
        const result = buildPresetDescription({ instructions: long });
        assert.ok(result.includes("..."));
        assert.ok(result.startsWith('"'));
    });

    void it("includes short instructions without truncation", () => {
        const result = buildPresetDescription({ instructions: "short" });
        assert.equal(result, '"short"');
    });

    void it("combines all parts with pipe separator", () => {
        const result = buildPresetDescription({
            provider: "openai",
            model: "gpt-4",
            thinkingLevel: "medium",
            tools: ["read", "bash"],
        });
        assert.ok(result.includes(" | "));
        assert.ok(result.includes("openai/gpt-4"));
        assert.ok(result.includes("thinking:medium"));
        assert.ok(result.includes("tools:read,bash"));
    });

    void it("returns empty string for empty preset", () => {
        assert.equal(buildPresetDescription({}), "");
    });
});
