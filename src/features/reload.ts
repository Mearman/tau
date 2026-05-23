/**
 * Reload tool — lets the model trigger a full reload of keybindings,
 * extensions, skills, prompts, and themes.
 *
 * The model cannot invoke slash commands, so this exposes reload as a tool.
 * The reload function is captured from ExtensionCommandContext (available
 * only in command handlers) and bridged into the tool via TauState.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";

/**
 * Capture the reload function from a command context.
 * Call this from every command handler so it's available on first invocation.
 */
export function captureReload(
    state: TauState,
    ctx: ExtensionCommandContext
): void {
    if (!state.commandContextReload && typeof ctx.reload === "function") {
        state.commandContextReload = ctx.reload.bind(ctx);
    }
}

/**
 * Register the reload tool.
 *
 * The tool requires that at least one command has been invoked (e.g. /bg,
 * /jobs, /tasks) so the reload function has been captured. If no command
 * has been invoked yet, the tool returns an error message asking the user
 * to run /reload manually.
 */
export function registerReloadTool(pi: ExtensionAPI, state: TauState): void {
    pi.registerTool({
        name: "reload",
        label: "Reload Configuration",
        description:
            "Reload keybindings, extensions, skills, prompts, and themes. " +
            "Use when the user asks to reload, when configuration files have changed, " +
            "or after installing new extensions/skills/themes. " +
            "Equivalent to running /reload in the terminal.",
        promptSnippet:
            "Reload extensions, skills, prompts, themes, and keybindings",
        promptGuidelines: [
            "Use reload when the user mentions changes to configuration files.",
            "Use reload after installing or updating extensions, skills, or themes.",
            "Do NOT use reload to retry a failed operation — it restarts the extension runtime.",
        ],
        parameters: Type.Object({}),

        async execute(
            _toolCallId,
            _params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            if (!state.commandContextReload) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                "Reload is not yet available in this session. " +
                                "Please run /reload manually in the terminal to reload " +
                                "extensions, skills, prompts, and themes.",
                        },
                    ],
                    details: undefined,
                };
            }

            // Defer the reload until the agent is truly idle.
            // ctx.reload() shows a warning but resolves when the agent is
            // busy. We must wait for ctx.isIdle() before calling reload.
            const doReload = state.commandContextReload;
            const pollIdleAndReload = async () => {
                // Wait up to 30s for the agent to go idle
                for (let i = 0; i < 150; i++) {
                    await new Promise((r) => setTimeout(r, 200));
                    if (_ctx.isIdle()) {
                        await doReload();
                        return;
                    }
                }
            };
            pollIdleAndReload();

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            "Reload scheduled — will fire after the current response " +
                            "completes. All configuration changes will be active once " +
                            "the reload finishes.",
                    },
                ],
                details: undefined,
            };
        },
    });
}
