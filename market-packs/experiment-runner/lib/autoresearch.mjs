// THIN ADAPTER over the shared reporting lib (lib/experiment-report.mjs) for the
// autoresearch loop's DETERMINISTIC decisions.
//
// The accept/reject + plateau/target/budget predicates are the SINGLE source in
// experiment-report.mjs (series.ts when bundled). This module adds only loop
// orchestration/store plumbing (ledger assembly, best-so-far hydration). It must
// NOT define local accept-stop math (the no-fork guard enforces this).

import {
	computeBestSoFar,
	decideCandidate,
	evaluateStop,
	objectiveSeries,
	budgetStatus,
	isPlateau,
	hitTarget,
	isRunVerified,
} from "./experiment-report.mjs";

// Re-export the shared decision surface so the loop reaches it through the adapter.
export { computeBestSoFar, decideCandidate, evaluateStop, objectiveSeries, budgetStatus, isPlateau, hitTarget, isRunVerified } from "./experiment-report.mjs";

/**
 * Decide accept/reject for a settled candidate run against the best-so-far
 * computed from prior runs. Pure plumbing around the shared decision function.
 *
 * @param {{ run:object, priorRuns:object[], objective:object }} input
 * @returns {{ decision:'accepted'|'rejected', reason:string, objective:(number|null), best:(number|null), bestAfter:(number|null) }}
 */
export function decideRun({ run, priorRuns = [], objective, eps = 0 }) {
	const dir = (objective && objective.direction) || "max";
	const best = computeBestSoFar(priorRuns, objective, eps);
	const value = run && run.metrics ? run.metrics[objective.metricId] : undefined;
	const objValue = typeof value === "number" && Number.isFinite(value) ? value : null;
	// Correctness gate (verified AND passed bar) is folded into one boolean by the
	// shared isRunVerified, since the canonical decideCandidate keys off `verified`.
	// `eps` (StopSpec.plateauEps) makes a sub-eps gain count as no improvement.
	const result = decideCandidate({
		objective: objValue,
		verified: run ? isRunVerified(run) : false,
		best,
		direction: dir,
		eps,
	});
	const bestAfter = result.decision === "accepted" ? objValue : best;
	return { ...result, objective: objValue, best, bestAfter };
}

/**
 * Build the append-only ledger from collected candidate runs. Recomputed on read
 * from the RunRecords (no second source of truth). Walks iterations in order,
 * applying the deterministic decision against the running best.
 *
 * @param {{ runs:object[], objective:object }} input
 * @returns {object[]} LedgerEntry[]
 */
export function buildLedger({ runs = [], objective, eps = 0 }) {
	if (!objective) return [];
	const iters = runs
		.filter((r) => typeof r.iteration === "number" && r.status === "collected")
		.slice()
		.sort((a, b) => a.iteration - b.iteration);
	const ledger = [];
	const prior = [];
	for (const run of iters) {
		const decided = decideRun({ run, priorRuns: prior, objective, eps });
		ledger.push({
			iteration: run.iteration,
			runId: run.runId,
			candidate: (run.rawOutcome && run.rawOutcome.userMetrics) || run.candidate || {},
			objective: decided.objective,
			completionBar: run.completionBar,
			decision: decided.decision,
			bestObjectiveAfter: decided.bestAfter,
			reason: decided.reason,
		});
		// Only accepted runs advance the best-so-far baseline used downstream.
		prior.push(run);
	}
	return ledger;
}

/**
 * Evaluate whether the loop must stop, deterministically, from the registry.
 *
 * @param {{ runs:object[], def:object, cumulativeCostUsd:number, elapsedMs:number }} input
 * @returns {{ stopped:boolean, reason?:string }}
 */
export function shouldStop({ runs = [], def, cumulativeCostUsd = 0, elapsedMs = 0 }) {
	const objective = def && def.objective;
	// No objective ⇒ no deterministic stop basis (autoresearch always has one).
	if (!objective) return { stopped: false };
	// StopSpec.plateauEps gates marginal improvements in the shared series, so the
	// plateau predicate counts a sub-eps gain as a non-improving iteration.
	const eps = def && def.stop && Number.isFinite(def.stop.plateauEps) ? def.stop.plateauEps : 0;
	const series = objectiveSeries({ runs, objective, eps });
	// Pass the comparable per-run budget as the projected next-candidate cost so
	// the shared `maxCostUsd` cap is enforced PRE-SPAWN (refuse to launch another
	// candidate when cumulative + perRunBudget would exceed the cap). Math stays
	// in the shared series lib — no fork here.
	const projectedNextCostUsd = def && Number.isFinite(def.perRunBudget) ? def.perRunBudget : 0;
	return evaluateStop({
		series,
		caps: (def && def.caps) || {},
		stop: (def && def.stop) || {},
		objective,
		cumulativeCostUsd,
		elapsedMs,
		projectedNextCostUsd,
	});
}
