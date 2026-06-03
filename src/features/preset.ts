/**
 * Preset feature — named presets that configure model, thinking level,
 * tools, and system prompt instructions. Loaded from JSON config files.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/presets.json (global)
 * - <cwd>/.pi/presets.json (project-local)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Key,
    type SelectItem,
    SelectList,
    Text,
} from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

export interface Preset {
    provider?: string;
    model?: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    tools?: string[];
    instructions?: string;
}

export interface PresetsConfig {
    [name: string]: Preset;
}

interface OriginalState {
    model: Model<Api> | undefined;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    tools: string[];
}

export function loadPresets(cwd: string): PresetsConfig {
    const globalPath = join(getAgentDir(), "presets.json");
    const projectPath = join(cwd, ".pi", "presets.json");

    let globalPresets: PresetsConfig = {};
    let projectPresets: PresetsConfig = {};

    if (existsSync(globalPath)) {
        try {
            globalPresets = JSON.parse(
                readFileSync(globalPath, "utf-8")
            ) as PresetsConfig;
        } catch (err: unknown) {
            console.error(
                `Failed to load global presets from ${globalPath}: ${String(err)}`
            );
        }
    }

    if (existsSync(projectPath)) {
        try {
            projectPresets = JSON.parse(
                readFileSync(projectPath, "utf-8")
            ) as PresetsConfig;
        } catch (err: unknown) {
            console.error(
                `Failed to load project presets from ${projectPath}: ${String(err)}`
            );
        }
    }

    return { ...globalPresets, ...projectPresets };
}

export function buildPresetDescription(preset: Preset): string {
    const parts: string[] = [];

    if (preset.provider && preset.model) {
        parts.push(`${preset.provider}/${preset.model}`);
    }
    if (preset.thinkingLevel) {
        parts.push(`thinking:${preset.thinkingLevel}`);
    }
    if (preset.tools) {
        parts.push(`tools:${preset.tools.join(",")}`);
    }
    if (preset.instructions) {
        const truncated =
            preset.instructions.length > 30
                ? `${preset.instructions.slice(0, 27)}...`
                : preset.instructions;
        parts.push(`"${truncated}"`);
    }

    return parts.join(" | ");
}

export function registerPreset(pi: ExtensionAPI, state: TauState): void {
    let presets: PresetsConfig = {};
    let activePresetName: string | undefined;
    let activePreset: Preset | undefined;
    let originalState: OriginalState | undefined;

    pi.registerFlag("preset", {
        description: "Preset configuration to use",
        type: "string",
    });

    async function applyPreset(
        name: string,
        preset: Preset,
        ctx: ExtensionContext
    ): Promise<boolean> {
        if (activePresetName === undefined) {
            originalState = {
                model: ctx.model,
                thinkingLevel: pi.getThinkingLevel(),
                tools: pi.getActiveTools(),
            };
        }

        if (preset.provider && preset.model) {
            const model = ctx.modelRegistry.find(preset.provider, preset.model);
            if (model) {
                const success = await pi.setModel(model);
                if (!success) {
                    ctx.ui.notify(
                        `Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
                        "warning"
                    );
                }
            } else {
                ctx.ui.notify(
                    `Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
                    "warning"
                );
            }
        }

        if (preset.thinkingLevel) {
            pi.setThinkingLevel(preset.thinkingLevel);
        }

        if (preset.tools && preset.tools.length > 0) {
            const allToolNames = pi.getAllTools().map((t) => t.name);
            const validTools = preset.tools.filter((t) =>
                allToolNames.includes(t)
            );
            const invalidTools = preset.tools.filter(
                (t) => !allToolNames.includes(t)
            );

            if (invalidTools.length > 0) {
                ctx.ui.notify(
                    `Preset "${name}": Unknown tools: ${invalidTools.join(", ")}`,
                    "warning"
                );
            }

            if (validTools.length > 0) {
                pi.setActiveTools(validTools);
            }
        }

        activePresetName = name;
        activePreset = preset;

        return true;
    }

    function updateStatus(ctx: ExtensionContext) {
        if (activePresetName) {
            ctx.ui.setStatus(
                "preset",
                ctx.ui.theme.fg("accent", `preset:${activePresetName}`)
            );
        } else {
            ctx.ui.setStatus("preset", undefined);
        }
    }

    function getPresetOrder(): string[] {
        return Object.keys(presets).sort();
    }

    async function cyclePreset(ctx: ExtensionContext): Promise<void> {
        const presetNames = getPresetOrder();
        if (presetNames.length === 0) {
            ctx.ui.notify(
                "No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json",
                "warning"
            );
            return;
        }

        const cycleList = ["(none)", ...presetNames];
        const currentName = activePresetName ?? "(none)";
        const currentIndex = cycleList.indexOf(currentName);
        const nextIndex =
            currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
        const nextName = cycleList[nextIndex];

        if (nextName === "(none)") {
            activePresetName = undefined;
            activePreset = undefined;
            if (originalState) {
                if (originalState.model) {
                    await pi.setModel(originalState.model);
                }
                pi.setThinkingLevel(originalState.thinkingLevel);
                pi.setActiveTools(originalState.tools);
            } else {
                pi.setActiveTools(["read", "bash", "edit", "write"]);
            }
            ctx.ui.notify("Preset cleared, defaults restored", "info");
            updateStatus(ctx);
            return;
        }

        const preset = presets[nextName];
        if (!preset) return;

        await applyPreset(nextName, preset, ctx);
        ctx.ui.notify(`Preset "${nextName}" activated`, "info");
        updateStatus(ctx);
    }

    async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
        const presetNames = Object.keys(presets);

        if (presetNames.length === 0) {
            ctx.ui.notify(
                "No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json",
                "warning"
            );
            return;
        }

        const items: SelectItem[] = presetNames.map((name) => {
            const preset = presets[name];
            const isActive = name === activePresetName;
            return {
                value: name,
                label: isActive ? `${name} (active)` : name,
                description: buildPresetDescription(preset),
            };
        });

        items.push({
            value: "(none)",
            label: "(none)",
            description: "Clear active preset, restore defaults",
        });

        const result = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
                const container = new Container();
                container.addChild(
                    new DynamicBorder((str) => theme.fg("accent", str))
                );

                container.addChild(
                    new Text(theme.fg("accent", theme.bold("Select Preset")))
                );

                const selectList = new SelectList(
                    items,
                    Math.min(items.length, 10),
                    {
                        selectedPrefix: (text) => theme.fg("accent", text),
                        selectedText: (text) => theme.fg("accent", text),
                        description: (text) => theme.fg("muted", text),
                        scrollInfo: (text) => theme.fg("dim", text),
                        noMatch: (text) => theme.fg("warning", text),
                    }
                );

                selectList.onSelect = (item) => done(item.value);
                selectList.onCancel = () => done(null);

                container.addChild(selectList);

                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            "↑↓ navigate • enter select • esc cancel"
                        )
                    )
                );

                container.addChild(
                    new DynamicBorder((str) => theme.fg("accent", str))
                );

                return {
                    render(width: number) {
                        return container.render(width);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        selectList.handleInput(data);
                        tui.requestRender();
                    },
                };
            }
        );

        if (!result) return;

        if (result === "(none)") {
            activePresetName = undefined;
            activePreset = undefined;
            if (originalState) {
                if (originalState.model) {
                    await pi.setModel(originalState.model);
                }
                pi.setThinkingLevel(originalState.thinkingLevel);
                pi.setActiveTools(originalState.tools);
            } else {
                pi.setActiveTools(["read", "bash", "edit", "write"]);
            }
            ctx.ui.notify("Preset cleared, defaults restored", "info");
            updateStatus(ctx);
            return;
        }

        const preset = presets[result];
        if (preset) {
            await applyPreset(result, preset, ctx);
            ctx.ui.notify(`Preset "${result}" activated`, "info");
            updateStatus(ctx);
        }
    }

    pi.registerShortcut(Key.ctrlShift("u"), {
        description: "Cycle presets",
        handler: async (ctx) => {
            if (!isFeatureEnabled(state, "preset")) return;

            await cyclePreset(ctx);
        },
    });

    pi.registerCommand("preset", {
        description: "Switch preset configuration",
        handler: async (args, ctx) => {
            if (!isFeatureEnabled(state, "preset")) {
                ctx.ui.notify(
                    "Preset is disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            if (args?.trim()) {
                const name = args.trim();
                const preset = presets[name];

                if (!preset) {
                    const available =
                        Object.keys(presets).join(", ") || "(none defined)";
                    ctx.ui.notify(
                        `Unknown preset "${name}". Available: ${available}`,
                        "error"
                    );
                    return;
                }

                await applyPreset(name, preset, ctx);
                ctx.ui.notify(`Preset "${name}" activated`, "info");
                updateStatus(ctx);
                return;
            }

            await showPresetSelector(ctx);
        },
    });

    pi.on("before_agent_start", async (event) => {
        if (activePreset?.instructions) {
            return {
                systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}`,
            };
        }
    });

    pi.on("session_start", async (_event, ctx) => {
        presets = loadPresets(ctx.cwd);

        const presetFlag = pi.getFlag("preset");
        if (typeof presetFlag === "string" && presetFlag) {
            const preset = presets[presetFlag];
            if (preset) {
                await applyPreset(presetFlag, preset, ctx);
                ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
            } else {
                const available =
                    Object.keys(presets).join(", ") || "(none defined)";
                ctx.ui.notify(
                    `Unknown preset "${presetFlag}". Available: ${available}`,
                    "warning"
                );
            }
        }

        const entries = ctx.sessionManager.getEntries();
        const presetEntry = entries
            .filter(
                (e: { type: string; customType?: string }) =>
                    e.type === "custom" && e.customType === "preset-state"
            )
            .pop() as { data?: { name: string } } | undefined;

        if (presetEntry?.data?.name && !presetFlag) {
            const preset = presets[presetEntry.data.name];
            if (preset) {
                activePresetName = presetEntry.data.name;
                activePreset = preset;
            }
        }

        updateStatus(ctx);
    });

    pi.on("turn_start", async () => {
        if (activePresetName) {
            pi.appendEntry("preset-state", {
                name: activePresetName,
            });
        }
    });
}
