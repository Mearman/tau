/**
 * Feature state restoration — called at `session_start` and
 * `session_tree`.
 *
 * Reads the most recent `tau-features-thread` session entry from the
 * current branch and reads file-based layers (cwd, project, global) from
 * disk. Clears ephemeral in-memory maps (temporary, session) so they
 * don't persist across reloads.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { TauState } from "../state.ts";
import { readTauFeatures, walkProjectLayers } from "./features-files.ts";

const THREAD_ENTRY_TYPE = "tau-features-thread";

/**
 * Restore feature toggle state from session entries and disk.
 *
 * @param state  The shared TauState instance.
 * @param ctx    The extension context (provides cwd and sessionManager).
 * @param options  Optional overrides for testing (e.g. custom homeDir).
 */
export function restoreFeaturesState(
    state: TauState,
    ctx: {
        cwd: string;
        sessionManager: {
            getBranch: () => Array<{
                type: string;
                customType?: string;
                data?: unknown;
            }>;
        };
    },
    options?: { homeDir?: string }
): void {
    // 1. Clear ephemeral layers.
    state.featureOverridesTemporary = undefined;
    state.featureOverridesSession = undefined;

    // 2. Walk branch entries for the most recent thread entry.
    state.featureOverridesThread = undefined;
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
        if (entry.type === "custom" && entry.customType === THREAD_ENTRY_TYPE) {
            const data = entry.data as Record<string, unknown> | undefined;
            if (data && typeof data === "object") {
                const map = new Map<string, boolean>();
                for (const [k, v] of Object.entries(data)) {
                    if (typeof v === "boolean") {
                        map.set(k, v);
                    }
                }
                state.featureOverridesThread = map;
            }
        }
    }

    // 3. Read file-based layers.
    state.cwdFeatures = readTauFeatures(join(ctx.cwd, ".pi", "settings.json"));

    // Walk up from cwd to git root for project layers. The closest
    // settings file is the project file.
    const projectLayers = walkProjectLayers(ctx.cwd);
    // The first layer that is not the cwd's own file is the project
    // layer. If the cwd's file exists, it's in projectLayers[0]; if
    // there's a second one, that's the project layer.
    state.projectFeatures = undefined;
    for (let i = 0; i < projectLayers.length; i++) {
        if (projectLayers[i] !== join(ctx.cwd, ".pi", "settings.json")) {
            state.projectFeatures = readTauFeatures(projectLayers[i]);
            break;
        }
    }

    // 4. Read global features from ~/.pi/agent/settings.json.
    const home = options?.homeDir ?? homedir();
    state.globalFeatures = readTauFeatures(
        join(home, ".pi", "agent", "settings.json")
    );
}
