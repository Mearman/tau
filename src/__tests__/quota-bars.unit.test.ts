/**
 * Unit tests for the quota-bars renderer (pure, no I/O).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    drawBar,
    buildStatusBars,
    levelColour,
    type BarTheme,
} from "../features/quota-bars.ts";

const theme: BarTheme = { fg: (c, t) => `<${c}>${t}</>` };

void describe("levelColour", () => {
    void it("is green under 60, amber 60-84, red 85+", () => {
        assert.equal(levelColour(0), "success");
        assert.equal(levelColour(59), "success");
        assert.equal(levelColour(60), "warning");
        assert.equal(levelColour(84), "warning");
        assert.equal(levelColour(85), "error");
        assert.equal(levelColour(100), "error");
    });
});

void describe("drawBar", () => {
    void it("fills proportionally and colours by level", () => {
        assert.equal(drawBar(50, 6, theme), "<success>███░░░</>");
        assert.equal(drawBar(90, 6, theme), "<error>█████░</>");
    });

    void it("clamps below 0 and above 100", () => {
        assert.equal(drawBar(-10, 4, theme), "<success>░░░░</>");
        assert.equal(drawBar(200, 4, theme), "<error>████</>");
    });
});

void describe("buildStatusBars", () => {
    void it("joins available bars with a separator", () => {
        const out = buildStatusBars(
            {
                contextPct: 50,
                sessionPct: null,
                sessionLabel: null,
                weeklyPct: 80,
                weeklyLabel: "7d",
            },
            theme
        );
        assert.ok(out);
        assert.match(out, /ctx/);
        assert.ok(!out.includes("ses")); // session omitted
        assert.match(out, /wk/);
        assert.match(out, /80% 7d/);
    });

    void it("returns undefined when no data", () => {
        assert.equal(
            buildStatusBars(
                {
                    contextPct: null,
                    sessionPct: null,
                    sessionLabel: null,
                    weeklyPct: null,
                    weeklyLabel: null,
                },
                theme
            ),
            undefined
        );
    });
});
