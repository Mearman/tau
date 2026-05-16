import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { taskRenderResult } from "../features/task.ts";

// ─── taskRenderResult edge cases ────────────────────────────────────

void describe("taskRenderResult", () => {
    const theme = {
        fg: (_colour: string, text: string) => text,
        bold: (text: string) => text,
    };

    void it("returns a component when details is an empty object (unknown action)", () => {
        const result = taskRenderResult(
            {
                content: [
                    {
                        type: "text",
                        text: "Something went wrong",
                    },
                ],
                details: {},
            },
            { expanded: false, isPartial: false },
            theme
        );

        assert.notEqual(result, undefined);
    });
});
