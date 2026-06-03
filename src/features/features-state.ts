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
import {
    readTauFeatures,
    removeTauFeature,
    walkProjectLayers,
    writeTauFeature,
} from "./features-files.ts";
import type { ScopeName } from "./features-cmd.ts";

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

/**
 * Set a feature override at the specified scope.
 *
 * For in-memory scopes (temporary, session, thread), updates the
 * corresponding Map on state. For file-based scopes (cwd, project,
 * global), writes to the appropriate `.pi/settings.json` file and
 * updates the cached record on state.
 */
export function setFeatureOverride(
    state: TauState,
    id: string,
    value: boolean,
    scope: ScopeName,
    options?: { cwd?: string; homeDir?: string }
): void {
    switch (scope) {
        case "temporary": {
            if (!state.featureOverridesTemporary) {
                state.featureOverridesTemporary = new Map();
            }
            state.featureOverridesTemporary.set(id, value);
            break;
        }
        case "session": {
            if (!state.featureOverridesSession) {
                state.featureOverridesSession = new Map();
            }
            state.featureOverridesSession.set(id, value);
            break;
        }
        case "thread": {
            if (!state.featureOverridesThread) {
                state.featureOverridesThread = new Map();
            }
            state.featureOverridesThread.set(id, value);
            break;
        }
        case "cwd": {
            const cwd = options?.cwd ?? process.cwd();
            const path = join(cwd, ".pi", "settings.json");
            writeTauFeature(path, id, value);
            state.cwdFeatures = readTauFeatures(path);
            break;
        }
        case "project": {
            const cwd = options?.cwd ?? process.cwd();
            const layers = walkProjectLayers(cwd);
            let projectPath: string | undefined;
            for (const layer of layers) {
                if (layer !== join(cwd, ".pi", "settings.json")) {
                    projectPath = layer;
                    break;
                }
            }
            if (!projectPath) {
                throw new Error(
                    "no project settings file found — use --scope cwd to create one"
                );
            }
            writeTauFeature(projectPath, id, value);
            state.projectFeatures = readTauFeatures(projectPath);
            break;
        }
        case "global": {
            const home = options?.homeDir ?? homedir();
            const path = join(home, ".pi", "agent", "settings.json");
            writeTauFeature(path, id, value);
            state.globalFeatures = readTauFeatures(path);
            break;
        }
    }
}

/**
 * Remove a feature override at the specified scope.
 *
 * For in-memory scopes, deletes the key from the corresponding Map.
 * For file-based scopes, removes the key from the appropriate
 * `.pi/settings.json` file and refreshes the cached record.
 */
export function unsetFeatureOverride(
    state: TauState,
    id: string,
    scope: ScopeName,
    options?: { cwd?: string; homeDir?: string }
): void {
    switch (scope) {
        case "temporary": {
            state.featureOverridesTemporary?.delete(id);
            break;
        }
        case "session": {
            state.featureOverridesSession?.delete(id);
            break;
        }
        case "thread": {
            state.featureOverridesThread?.delete(id);
            break;
        }
        case "cwd": {
            const cwd = options?.cwd ?? process.cwd();
            const path = join(cwd, ".pi", "settings.json");
            removeTauFeature(path, id);
            state.cwdFeatures = readTauFeatures(path);
            break;
        }
        case "project": {
            const cwd = options?.cwd ?? process.cwd();
            const layers = walkProjectLayers(cwd);
            let projectPath: string | undefined;
            for (const layer of layers) {
                if (layer !== join(cwd, ".pi", "settings.json")) {
                    projectPath = layer;
                    break;
                }
            }
            if (!projectPath) {
                throw new Error(
                    "no project settings file found — use --scope cwd to create one"
                );
            }
            removeTauFeature(projectPath, id);
            state.projectFeatures = readTauFeatures(projectPath);
            break;
        }
        case "global": {
            const home = options?.homeDir ?? homedir();
            const path = join(home, ".pi", "agent", "settings.json");
            removeTauFeature(path, id);
            state.globalFeatures = readTauFeatures(path);
            break;
        }
    }
}
