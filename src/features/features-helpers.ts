/**
 * Convenience helpers for the soft-toggle wiring.
 *
 * Each feature module's command/tool/shortcut handler calls
 * `isFeatureEnabled(state, "feature-id")` at the top and bails out if
 * disabled. `getFeatureSource` reports which scope the value came from,
 * for use in the TUI's source column and the CLI's `get` verb.
 *
 * These are thin wrappers around `resolveFeature` that extract the
 * override fields from `TauState`. They're kept separate so feature
 * modules can import only the helpers (not the resolver types).
 */

import type { TauState } from "../state.ts";
import {
    resolveFeature,
    type FeatureLayers,
    type FeatureSource,
    type ResolvedFeature,
} from "./features-resolver.ts";

/**
 * Extract the feature-override fields from `TauState` and return them as
 * a `FeatureLayers` object. Defaults to empty layers for any field not
 * present on state.
 */
export function featureLayersFromState(state: TauState): FeatureLayers {
    return {
        temporary: state.featureOverridesTemporary,
        session: state.featureOverridesSession,
        // `thread` is intentionally not yet wired here — handled in
        // phase 3 when session-branch persistence is added. Until then
        // it stays `undefined` and `resolveFeature` falls through to
        // session / file layers.
        thread: undefined,
        cwd: state.cwdFeatures,
        project: state.projectFeatures,
        global: state.globalFeatures,
    };
}

/**
 * Resolve and return the effective boolean for a feature.
 */
export function isFeatureEnabled(state: TauState, id: string): boolean {
    return resolveFeature(id, featureLayersFromState(state)).value;
}

/**
 * Resolve and return the source layer that supplied the value.
 * Useful for diagnostics and for the TUI's "why is this off?" display.
 */
export function getFeatureSource(state: TauState, id: string): FeatureSource {
    return resolveFeature(id, featureLayersFromState(state)).source;
}

/**
 * Resolve and return both the effective value and the source. Useful
 * when the caller needs both.
 */
export function resolveFeatureFromState(
    state: TauState,
    id: string
): ResolvedFeature {
    return resolveFeature(id, featureLayersFromState(state));
}
