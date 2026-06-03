/**
 * Pure scope resolver for tau feature toggles.
 *
 * Given a feature id and a layered view of override stores, returns the
 * effective boolean and the source layer that produced it. Layers are
 * walked in priority order from highest to lowest; the first layer that
 * has a value for the feature wins. Missing or absent layers fall through.
 * The default is `true` (feature on) when no layer has a value.
 *
 * Priority order (highest first):
 *   temporary → thread → session → cwd → project → global → default
 */

export type ScopeName =
    | "temporary"
    | "thread"
    | "session"
    | "cwd"
    | "project"
    | "global";

export type FeatureSource = ScopeName | "default";

export interface FeatureLayers {
    temporary?: ReadonlyMap<string, boolean>;
    thread?: ReadonlyMap<string, boolean>;
    session?: ReadonlyMap<string, boolean>;
    cwd?: Readonly<Record<string, boolean>>;
    project?: Readonly<Record<string, boolean>>;
    global?: Readonly<Record<string, boolean>>;
}

export interface ResolvedFeature {
    value: boolean;
    source: FeatureSource;
}

const PRIORITY: ReadonlyArray<ScopeName> = [
    "temporary",
    "thread",
    "session",
    "cwd",
    "project",
    "global",
];

export function resolveFeature(
    id: string,
    layers: FeatureLayers
): ResolvedFeature {
    for (const scope of PRIORITY) {
        const layer = layers[scope];
        if (layer === undefined) continue;
        const value = getFromLayer(layer, id);
        if (value !== undefined) {
            return { value, source: scope };
        }
    }
    return { value: true, source: "default" };
}

function getFromLayer(
    layer: NonNullable<FeatureLayers[ScopeName]>,
    id: string
): boolean | undefined {
    if (layer instanceof Map) {
        return (layer as ReadonlyMap<string, boolean>).get(id);
    }
    return (layer as Readonly<Record<string, boolean>>)[id];
}
