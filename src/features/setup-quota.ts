/**
 * /setup-quota — wraps Claude Code's statusline so tau can read both
 * subscription quota windows (five-hour + seven-day) natively.
 *
 * Claude Code pipes a JSON payload to its statusline command that includes
 * rate_limits.five_hour and rate_limits.seven_day. tau's wrapper script
 * (bin/statusline-wrapper.sh) tees that JSON to a file and passes stdin
 * through to the original statusline unchanged, so tau can read both windows
 * without depending on any specific statusline tool.
 *
 * Run /setup-quota to wrap; run it again to unwrap and restore the original.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const ORIGINAL_PATH = join(
    homedir(),
    ".pi",
    "agent",
    "extensions",
    "tau",
    ".statusline-original"
);
const WRAPPER_MARKER = "statusline-wrapper.sh";

export function registerSetupQuotaCommand(
    pi: ExtensionAPI,
    _state: TauState
): void {
    pi.registerCommand("setup-quota", {
        description:
            "Wrap Claude Code's statusline so tau can read both quota windows",
        handler: async (_args, ctx) => {
            if (!existsSync(CLAUDE_SETTINGS)) {
                ctx.ui.notify(
                    "~/.claude/settings.json not found — is Claude Code installed?",
                    "warning"
                );
                return;
            }

            let raw: string;
            try {
                raw = readFileSync(CLAUDE_SETTINGS, "utf8");
            } catch {
                ctx.ui.notify(
                    "Failed to read ~/.claude/settings.json",
                    "error"
                );
                return;
            }

            let settings: Record<string, unknown>;
            try {
                settings = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                ctx.ui.notify(
                    "~/.claude/settings.json is malformed JSON",
                    "error"
                );
                return;
            }

            const statusLine = settings["statusLine"];
            const currentCommand =
                typeof statusLine === "object" &&
                statusLine !== null &&
                typeof (statusLine as Record<string, unknown>)["command"] ===
                    "string"
                    ? ((statusLine as Record<string, unknown>)[
                          "command"
                      ] as string)
                    : undefined;

            const isWrapped =
                currentCommand !== undefined &&
                currentCommand.includes(WRAPPER_MARKER);

            if (isWrapped) {
                // Unwrap: restore the original command.
                let original: string | undefined;
                try {
                    original = readFileSync(ORIGINAL_PATH, "utf8").trim();
                } catch {
                    ctx.ui.notify(
                        "Can't find the saved original statusline — remove the wrapper manually from ~/.claude/settings.json",
                        "warning"
                    );
                    return;
                }
                if (original) {
                    (settings["statusLine"] as Record<string, unknown>)[
                        "command"
                    ] = original;
                    writeFileSync(
                        CLAUDE_SETTINGS,
                        JSON.stringify(settings, null, 2) + "\n"
                    );
                    ctx.ui.notify(
                        "Statusline unwrapped — original restored. Restart Claude Code.",
                        "info"
                    );
                }
                return;
            }

            // Wrap: save the current command and set the wrapper.
            if (currentCommand === undefined) {
                ctx.ui.notify(
                    "No statusLine.command found in ~/.claude/settings.json. The wrapper still works but there's no original to pass through to.",
                    "warning"
                );
            }
            mkdirSync(dirname(ORIGINAL_PATH), { recursive: true });
            writeFileSync(ORIGINAL_PATH, currentCommand ?? "", "utf8");

            const wrapperCommand = `bash ${join(
                homedir(),
                ".pi",
                "agent",
                "extensions",
                "tau",
                "bin",
                "statusline-wrapper.sh"
            )}`;
            settings["statusLine"] = {
                ...(typeof statusLine === "object" && statusLine !== null
                    ? statusLine
                    : {}),
                type: "command",
                command: wrapperCommand,
            };
            writeFileSync(
                CLAUDE_SETTINGS,
                JSON.stringify(settings, null, 2) + "\n"
            );
            ctx.ui.notify(
                "Statusline wrapped — tau will capture both quota windows. Restart Claude Code to activate.",
                "info"
            );
        },
    });
}
