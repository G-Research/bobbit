// THIN ADAPTER over the shared reporting lib (lib/experiment-report.mjs).
//
// This module adds ONLY store/registry plumbing on top of the bundled shared
// aggregation functions. It must NOT define local median/percentile/same-bar
// math — that single source lives in experiment-report.mjs (the no-fork pinning
// guard fails CI on a local `median(`/`percentile(` definition here).

import { aggregateExperiment, buildReportModel } from "./experiment-report.mjs";

// Re-export the shared aggregation surface so callers (engine/routes/tests) reach
// it through the adapter without re-importing the bundle directly.
export { aggregateExperiment, buildReportModel } from "./experiment-report.mjs";

/**
 * Compute the A/B aggregation for an experiment from already-loaded registry
 * objects. Pure pass-through to the shared lib (recompute on read; never cache a
 * divergent `agg/*` copy).
 *
 * @param {{ def:object, runs:object[], metrics:object[], bar?:string }} input
 */
export function aggregate(input) {
	return aggregateExperiment(input);
}

/**
 * Hydrate the registry objects for an experiment from the pack store and compute
 * the aggregation. The store/list plumbing is the only thing this adapter owns.
 *
 * @param {object} store host.store
 * @param {object} keys store-keys builders ({ experimentKey, runPrefix, metricsKey })
 * @param {string} experimentId
 * @param {object[]} resolvedMetrics metric descriptors resolved from the registry
 */
export async function aggregateFromStore(store, keys, experimentId, resolvedMetrics) {
	const def = await store.get(keys.experimentKey(experimentId));
	const runKeys = await store.list(keys.runPrefix(experimentId));
	const runs = (await Promise.all(runKeys.map((k) => store.get(k)))).filter((r) => r && typeof r === "object");
	return aggregateExperiment({ def, runs, metrics: resolvedMetrics || [] });
}
