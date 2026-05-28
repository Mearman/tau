/**
 * Permission prompt component — custom TUI for approval/rejection with
 * destination selection and inline feedback.
 *
 * When approving, the user chooses where to persist the allow rule:
 *   Once     — approve this time only (no persistence)
 *   Session  — in-memory, lasts until the session ends
 *   Local    — .claude/settings.local.json (gitignored, personal)
 *   Project  — .claude/settings.json (shared with team)
 *   Always   — ~/.claude/settings.json (global, permanent)
 *
 * Ported from permission-gate.ts and Claude Code's PermissionPrompt.tsx.
 */

import type {
    Component,
    Focusable,
    TUI,
    KeybindingsManager,
} from "@earendil-works/pi-tui";
import { Input, matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionUpdateDestination } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface Decision {
    approved: boolean;
    feedback: string;
    /** Where to persist the allow rule. Undefined means "this time only". */
    destination?: PermissionUpdateDestination;
    /** The rule string to persist, e.g. "Bash(git:*)" */
    rule?: string;
}

interface PromptOption {
    label: string;
    shortLabel: string;
    key: string; // single-char shortcut
    value: Decision;
}

// ─── Destination option builders ────────────────────────────────────

const DESTINATION_OPTIONS: {
    label: string;
    shortLabel: string;
    key: string;
    destination?: PermissionUpdateDestination;
}[] = [
    {
        label: "Once (this time only)",
        shortLabel: "Once",
        key: "o",
        destination: undefined,
    },
    {
        label: "Session (until session ends)",
        shortLabel: "Session",
        key: "s",
        destination: "session",
    },
    {
        label: "Local (.claude/settings.local.json)",
        shortLabel: "Local",
        key: "l",
        destination: "localSettings",
    },
    {
        label: "Project (.claude/settings.json)",
        shortLabel: "Project",
        key: "p",
        destination: "projectSettings",
    },
    {
        label: "Always (~/.claude/settings.json)",
        shortLabel: "Always",
        key: "a",
        destination: "userSettings",
    },
];

function buildOptions(rule?: string): PromptOption[] {
    const approveOpts = DESTINATION_OPTIONS.map((d) => ({
        label: d.label,
        shortLabel: d.shortLabel,
        key: d.key,
        value: {
            approved: true,
            feedback: "",
            destination: d.destination,
            rule,
        },
    }));

    return [
        ...approveOpts,
        {
            label: "No (reject)",
            shortLabel: "No",
            key: "n",
            value: { approved: false, feedback: "", rule },
        },
    ];
}

// ─── ANSI helpers ─────────────────────────────────────────────────────

const ESC = "\x1b";

interface PromptTheme {
    title: (s: string) => string;
    question: (s: string) => string;
    selectedLabel: (s: string) => string;
    mutedLabel: (s: string) => string;
    keyHint: (key: string, label: string) => string;
    feedbackPrefix: (s: string) => string;
    hint: (s: string) => string;
}

const PROMPT_THEME: PromptTheme = {
    title: (s) => ESC + "[1m" + s + ESC + "[22m",
    question: (s) => s,
    selectedLabel: (s) => ESC + "[7m " + s + " " + ESC + "[27m",
    mutedLabel: (s) => " " + s + " ",
    keyHint: (key, label) => ESC + "[1m" + key + ESC + "[22m" + ")" + label,
    feedbackPrefix: (s) => ESC + "[36m" + s + ESC + "[39m",
    hint: (s) => ESC + "[2m" + s + ESC + "[22m",
};

// ─── Permission prompt component ────────────────────────────────────

export class PermissionPrompt implements Component, Focusable {
    private question: string;
    private options: PromptOption[];
    private selectedIndex = 0;
    private feedbackTarget: "approve" | "reject" | null = null;
    private feedbackInput: Input;
    private done: (decision: Decision) => void;
    private _focused = false;
    private invalidated = true;
    private cachedLines: string[] | null = null;
    private cachedWidth: number | null = null;
    private theme: PromptTheme;

    constructor(
        question: string,
        done: (decision: Decision) => void,
        options: { rule?: string } = {}
    ) {
        this.question = question;
        this.done = done;
        this.options = buildOptions(options.rule);
        this.theme = PROMPT_THEME;

        this.feedbackInput = new Input();
        this.feedbackInput.onSubmit = () => {
            const feedback = this.feedbackInput.getValue().trim();
            const opt = this.options[this.selectedIndex];
            this.done({
                ...opt.value,
                feedback,
            });
        };
        this.feedbackInput.onEscape = () => {
            this.feedbackTarget = null;
            this.invalidate();
        };
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

    handleInput(data: string): void {
        // In feedback mode, delegate to the input
        if (this.feedbackTarget !== null) {
            this.feedbackInput.handleInput(data);
            this.invalidate();
            return;
        }

        if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
            this.selectedIndex =
                (this.selectedIndex - 1 + this.options.length) %
                this.options.length;
            this.invalidate();
        } else if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
            this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
            this.invalidate();
        } else if (matchesKey(data, Key.tab)) {
            const opt = this.options[this.selectedIndex];
            this.feedbackTarget = opt.value.approved ? "approve" : "reject";
            this.invalidate();
        } else if (matchesKey(data, Key.enter)) {
            const opt = this.options[this.selectedIndex];
            this.done(opt.value);
        } else if (matchesKey(data, Key.escape)) {
            this.done({ approved: false, feedback: "", rule: undefined });
        } else {
            // Shortcut key matching
            const ch = data.length === 1 ? data.toLowerCase() : "";
            const idx = this.options.findIndex((o) => o.key === ch);
            if (idx !== -1) {
                this.done(this.options[idx].value);
            }
        }
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
            const label =
                this.feedbackTarget === "approve"
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
            // Show options as a list with key shortcuts
            for (let i = 0; i < this.options.length; i++) {
                const opt = this.options[i];
                const isSelected = i === this.selectedIndex;
                const prefix = theme.keyHint(opt.key, " ");
                const label = isSelected
                    ? theme.selectedLabel(prefix + opt.shortLabel)
                    : theme.mutedLabel(prefix + opt.shortLabel);
                lines.push(styledLine(label));
            }
            lines.push(
                styledLine(
                    theme.hint(
                        "↑ ↓ to select * Tab for feedback * Enter to confirm * Esc to reject"
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
 * @param options.rule The rule string to persist if approved with a destination
 */
export async function promptPermission(
    ctx: ExtensionContext,
    question: string,
    options: { rule?: string } = {}
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
