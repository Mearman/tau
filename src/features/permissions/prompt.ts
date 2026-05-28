/**
 * Permission prompt component — custom TUI for approval/rejection with
 * inline feedback.
 *
 * Ported from permission-gate.ts with adaptations for pi-tui's API.
 * Matches Claude Code's UX: select Yes or No with arrow keys,
 * press Tab to enter an inline feedback input, Enter to submit.
 */

import type {
    Component,
    Focusable,
    TUI,
    KeybindingsManager,
} from "@earendil-works/pi-tui";
import { Input, matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────

export interface Decision {
    approved: boolean;
    feedback: string;
}

// ─── ANSI helpers ─────────────────────────────────────────────────────

const ESC = "\x1b";

interface PromptTheme {
    title: (s: string) => string;
    question: (s: string) => string;
    selectedLabel: (s: string) => string;
    mutedLabel: (s: string) => string;
    feedbackPrefix: (s: string) => string;
    hint: (s: string) => string;
}

const PROMPT_THEME: PromptTheme = {
    title: (s) => ESC + "[1m" + s + ESC + "[22m",
    question: (s) => s,
    selectedLabel: (s) => ESC + "[7m " + s + " " + ESC + "[27m",
    mutedLabel: (s) => " " + s + " ",
    feedbackPrefix: (s) => ESC + "[36m" + s + ESC + "[39m",
    hint: (s) => ESC + "[2m" + s + ESC + "[22m",
};

// ─── Permission prompt component ────────────────────────────────────

type FeedbackTarget = "approve" | "reject";

export class PermissionPrompt implements Component, Focusable {
    private question: string;
    private selectedIndex = 0; // 0 = yes, 1 = no
    private feedbackTarget: FeedbackTarget | null = null;
    private feedbackInput: Input;
    private done: (decision: Decision) => void;
    private _focused = false;
    private invalidated = true;
    private cachedLines: string[] | null = null;
    private cachedWidth: number | null = null;
    private theme: PromptTheme;
    private showYes: boolean;
    private showNo: boolean;

    constructor(
        question: string,
        done: (decision: Decision) => void,
        options: { showYes?: boolean; showNo?: boolean } = {}
    ) {
        this.question = question;
        this.done = done;
        this.showYes = options.showYes ?? true;
        this.showNo = options.showNo ?? true;
        this.theme = PROMPT_THEME;

        this.feedbackInput = new Input();
        this.feedbackInput.onSubmit = () => {
            const feedback = this.feedbackInput.getValue().trim();
            if (this.feedbackTarget === "approve") {
                this.done({ approved: true, feedback });
            } else {
                this.done({ approved: false, feedback });
            }
        };
        this.feedbackInput.onEscape = () => {
            this.feedbackTarget = null;
            this.invalidate();
        };

        // Default to "no" if that's the only option
        if (!this.showYes && this.showNo) {
            this.selectedIndex = 0;
        }
    }

    get focused(): boolean {
        return this._focused;
    }
    set focused(value: boolean) {
        this._focused = value;
        if (this.feedbackTarget !== null) {
            this.feedbackInput.focused = value;
        }
    }

    private handleSelectionKey(isForward: boolean): void {
        if (!this.showYes || !this.showNo) return;
        this.selectedIndex = isForward ? 1 : 0;
        this.invalidate();
    }

    private handleTab(): void {
        if (this.selectedIndex === 0 && this.showYes) {
            this.feedbackTarget = "approve";
        } else if (this.showNo) {
            this.feedbackTarget = "reject";
        }
        this.invalidate();
    }

    handleInput(data: string): void {
        // In feedback mode, delegate to the input
        if (this.feedbackTarget !== null) {
            this.feedbackInput.handleInput(data);
            this.invalidate();
            return;
        }

        if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
            this.handleSelectionKey(false);
        } else if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
            this.handleSelectionKey(true);
        } else if (matchesKey(data, Key.tab)) {
            this.handleTab();
        } else if (matchesKey(data, Key.enter)) {
            this.submitSelected();
        } else if (matchesKey(data, Key.escape)) {
            this.done({ approved: false, feedback: "" });
        }
    }

    private submitSelected(): void {
        const approved = this.selectedIndex === 0 && this.showYes;
        this.done({ approved, feedback: "" });
    }

    invalidate(): void {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (
            this.cachedLines !== null &&
            this.cachedWidth === width &&
            !this.invalidated
        ) {
            return this.cachedLines;
        }
        this.invalidated = false;
        this.cachedWidth = width;
        this.cachedLines = this.buildLines(width);
        return this.cachedLines;
    }

    private buildLines(width: number): string[] {
        const { theme } = this;
        const inner = width - 2;
        const lines: string[] = [];

        const styledLine = (content: string): string => {
            const BG = ESC + "[48;5;236m";
            const BG_RESET = ESC + "[0m";
            const visible = visibleWidth(content);
            const pad = Math.max(0, inner - visible);
            return BG + " " + content + " ".repeat(pad + 1) + BG_RESET;
        };

        lines.push(styledLine(theme.title("WARNING:  Permission required")));

        for (const line of wrapLines(this.question, inner)) {
            lines.push(styledLine(theme.question(line)));
        }

        if (this.feedbackTarget !== null) {
            const target = this.feedbackTarget;
            const label =
                target === "approve"
                    ? "Approve with feedback"
                    : "Reject with feedback";
            lines.push(styledLine(theme.feedbackPrefix(label + ":")));

            this.feedbackInput.focused = this._focused;
            const inputLines = this.feedbackInput.render(inner - 2);
            for (const il of inputLines) {
                const ilWidth = visibleWidth(il);
                const ilPad = Math.max(0, inner - ilWidth);
                lines.push(
                    ESC +
                        "[48;5;236m " +
                        il +
                        " ".repeat(ilPad + 1) +
                        ESC +
                        "[0m"
                );
            }

            lines.push(
                styledLine(theme.hint("Enter to submit * Escape to go back"))
            );
        } else {
            const options: { label: string; selected: boolean }[] = [];
            if (this.showYes) {
                options.push({
                    label: "Yes",
                    selected: this.selectedIndex === 0,
                });
            }
            if (this.showNo) {
                options.push({
                    label: "No",
                    selected: this.selectedIndex === (this.showYes ? 1 : 0),
                });
            }

            const buttonLine = options
                .map((opt) =>
                    opt.selected
                        ? theme.selectedLabel(opt.label)
                        : theme.mutedLabel(opt.label)
                )
                .join("  ");
            lines.push(styledLine(buttonLine));
            lines.push(
                styledLine(
                    theme.hint(
                        "← → to select * Tab to add feedback * Enter to confirm * Esc to reject"
                    )
                )
            );
        }

        return lines;
    }
}

// ─── Text wrapping ────────────────────────────────────────────────────

function wrapLines(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    const paragraphs = text.split("\n");

    for (const paragraph of paragraphs) {
        if (paragraph === "") {
            lines.push("");
            continue;
        }

        let current = "";
        for (const word of paragraph.split(" ")) {
            const test = current ? current + " " + word : word;
            if (visibleWidth(test) > maxWidth && current) {
                lines.push(current);
                current = word;
            } else {
                current = test;
            }
        }
        if (current) {
            lines.push(current);
        }
    }

    return lines;
}

// ─── Prompt helper ───────────────────────────────────────────────────

/**
 * Show the permission prompt and return the user's decision.
 *
 * @param ctx Extension context (for ui.custom)
 * @param question The question to display
 * @param options Whether to show Yes/No buttons
 */
export async function promptPermission(
    ctx: ExtensionContext,
    question: string,
    options: { showYes?: boolean; showNo?: boolean } = {}
): Promise<Decision> {
    return ctx.ui.custom<Decision>(
        (
            _tui: TUI,
            _theme: unknown,
            _keybindings: KeybindingsManager,
            done: (d: Decision) => void
        ) => new PermissionPrompt(question, done, options)
    );
}
