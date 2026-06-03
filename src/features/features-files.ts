/**
 * File I/O for the tau feature toggle system.
 *
 * Reads and writes the `tau.features` sub-object of `.pi/settings.json`
 * (for the cwd, project, and global layers). Walks the directory tree
 * from cwd up to the git root to discover project-level settings files.
 *
 * Locking and atomic writes will be added in a follow-up; the current
 * implementation re-reads, modifies, and writes back. Concurrent
 * writers in the same process are not a concern (single tau instance),
 * and external writers (manual `vi` edits) are expected to be rare and
 * recoverable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read the `tau.features` sub-object from a settings.json file.
 * Returns an empty object if the file is missing, malformed, or has
 * no features key.
 */
export function readTauFeatures(path: string): Record<string, boolean> {
    if (!existsSync(path)) return {};
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        return {};
    }
    const root = parsed as Record<string, unknown>;
    const tau = root["tau"];
    if (typeof tau !== "object" || tau === null || Array.isArray(tau)) {
        return {};
    }
    const features = (tau as Record<string, unknown>)["features"];
    if (
        typeof features !== "object" ||
        features === null ||
        Array.isArray(features)
    ) {
        return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(features)) {
        if (typeof v === "boolean") {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Write or update a single feature value in a settings.json file.
 * Creates the parent directory and the file if they do not exist.
 * Preserves all other keys in the file.
 */
export function writeTauFeature(
    path: string,
    id: string,
    value: boolean
): void {
    let root: Record<string, unknown> = {};
    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed)
            ) {
                root = parsed as Record<string, unknown>;
            }
        } catch {
            // Corrupted file — start fresh, do not delete the file
            // before writing because the user might have other keys we
            // couldn't parse. We re-read on next call.
        }
    }
    const tau =
        typeof root["tau"] === "object" && root["tau"] !== null
            ? { ...(root["tau"] as Record<string, unknown>) }
            : {};
    const features =
        typeof tau["features"] === "object" && tau["features"] !== null
            ? { ...(tau["features"] as Record<string, boolean>) }
            : {};
    features[id] = value;
    tau["features"] = features;
    root["tau"] = tau;

    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(root, null, 2) + "\n", "utf8");
}

/**
 * Walk the directory tree from cwd up to the git root (inclusive of
 * the git root's directory itself, exclusive of any ancestor beyond
 * it). Return the path of the closest existing `.pi/settings.json`,
 * or undefined if none is found.
 */
export function findProjectSettingsFile(cwd: string): string | undefined {
    const layers = walkProjectLayers(cwd);
    return layers[0];
}

/**
 * Walk the directory tree from cwd up to (but not including) the
 * first ancestor without a `.git` directory. Return the list of
 * `.pi/settings.json` paths that exist, closest first.
 *
 * If cwd is itself a git root, only cwd is considered. If cwd is not
 * inside a git repo at all, the walk proceeds up to the system root.
 */
export function walkProjectLayers(cwd: string): string[] {
    const found: string[] = [];
    let dir = cwd;
    while (true) {
        const candidate = join(dir, ".pi", "settings.json");
        if (existsSync(candidate)) {
            found.push(candidate);
        }
        // Stop at the git root — we don't walk beyond it.
        if (existsSync(join(dir, ".git"))) {
            break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            // Reached the filesystem root.
            break;
        }
        dir = parent;
    }
    return found;
}
