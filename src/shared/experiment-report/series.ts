// Series — best-so-far curve + the deterministic accept/reject and stop
// predicates (docs/design/experiment-runner-reporting.md §5). The autoresearch
// loop and the dashboard curve share THESE functions, so the chart can never
// disagree with what the loop actually did. Pure functions over plain arrays.

import type {
	AutoresearchCaps,
	Direction,
	LedgerEntry,
	ObjectivePoint,
	ObjectiveSpec,
	RunRecord,
	StopAnnotation,
	StopSpec,
} from "./types.js";

/** A run is verified iff it passed the correctness gate AND its bar is 'passed'. */
export function isRunVerified(run: RunRecord): boolean {
	if (run.verified === false) return false;
	if (run.completionBar && run.completionBar !== "passed") return false;
	// Default: a run with verified===true OR an explicit passed bar is verified.
	return run.verified === true || run.completionBar === "passed";
}

function objectiveValue(run: RunRecord, objective: ObjectiveSpec): number | null {
	const v = run.metrics?.[objective.metricId];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sort autoresearch runs by iteration ascending (stable on missing iteration). */
export function sortByIteration(runs: RunRecord[]): RunRecord[] {
	return [...runs].sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
}

/**
 * Build the best-objective-vs-iteration curve. Walk iterations in order, keep the
 * running best of `objective.metricId` AMONG VERIFIED runs only (the correctness
 * gate): a higher-objective but unverified run is rejected and `bestSoFar` does
 * not rise. This is the single source for both the loop's accept decision and the
 * dashboard curve.
 */
export function buildObjectiveSeries(runs: RunRecord[], objective: ObjectiveSpec, eps = 0): ObjectivePoint[] {
	const ordered = sortByIteration(runs.filter((r) => r.iteration !== undefined));
	const out: ObjectivePoint[] = [];
	let best: number | null = null;
	for (const r of ordered) {
		const obj = objectiveValue(r, objective);
		const verified = isRunVerified(r);
		let accepted = false;
		if (verified && obj !== null) {
			// eps gates marginal improvements: a sub-eps gain counts as no improvement,
			// so bestSoFar does not rise and the candidate is not accepted. Threaded from
			// StopSpec.plateauEps so the loop AND the dashboard curve agree.
			if (best === null || improvesBy(obj, best, objective.direction, eps)) {
				best = obj;
				accepted = true;
			}
		}
		out.push({
			iteration: r.iteration as number,
			runId: r.runId,
			armId: r.armId,
			objective: obj,
			accepted,
			verified,
			bestSoFar: best,
		});
	}
	return out;
}

/** The running best objective at the end of the series (null if none accepted). */
export function bestObjective(series: ObjectivePoint[]): number | null {
	for (let i = series.length - 1; i >= 0; i--) {
		if (series[i].bestSoFar !== null) return series[i].bestSoFar;
	}
	return null;
}

/**
 * True if `candidate` improves on `incumbent` by MORE than eps (direction-aware).
 * eps=0 reduces to strict-improvement (`isBetter`). The single eps-aware
 * improvement predicate, shared by the curve and the accept decision.
 */
export function improvesBy(candidate: number, incumbent: number, direction: Direction, eps = 0): boolean {
	const improvement = direction === "max" ? candidate - incumbent : incumbent - candidate;
	return improvement > eps;
}

/**
 * Deterministic accept/reject for ONE candidate against the current best.
 * Accept iff verified AND objective improves by more than eps (direction-aware).
 * The framework decides; the LLM only proposes.
 */
export function decideCandidate(args: {
	objective: number | null;
	verified: boolean;
	best: number | null;
	direction: Direction;
	eps?: number;
}): { decision: "accepted" | "rejected"; reason: string } {
	const { objective, verified, best, direction } = args;
	const eps = args.eps ?? 0;
	if (!verified) return { decision: "rejected", reason: "failed-correctness-gate" };
	if (objective === null) return { decision: "rejected", reason: "no-objective" };
	if (best === null) return { decision: "accepted", reason: "improved & passed" };
	if (improvesBy(objective, best, direction, eps)) return { decision: "accepted", reason: "improved & passed" };
	return { decision: "rejected", reason: "regressed" };
}

/**
 * Plateau predicate: true if there has been no accepted improvement over the last
 * K iterations. Mirrors the loop's stop decision exactly.
 */
export function isPlateau(series: ObjectivePoint[], K: number): boolean {
	if (!K || K <= 0) return false;
	if (series.length < K) return false;
	const tail = series.slice(-K);
	return tail.every((p) => !p.accepted);
}

/**
 * Target predicate: true once the best objective has crossed `target`
 * (direction-aware). For 'max' the best must be >= target; for 'min', <= target.
 */
export function hitTarget(series: ObjectivePoint[], target: number, direction: Direction): boolean {
	const best = bestObjective(series);
	if (best === null) return false;
	return direction === "max" ? best >= target : best <= target;
}

/** Cumulative measured cost across the runs (USD). */
export function cumulativeCost(runs: RunRecord[]): number {
	let total = 0;
	for (const r of runs) {
		const c = r.cost?.costUsd;
		if (typeof c === "number" && Number.isFinite(c)) total += c;
	}
	return total;
}

/** A run is over its per-run budget (with the same threshold used everywhere). */
export function isOverBudget(run: RunRecord, perRunBudget: number | undefined): boolean {
	if (perRunBudget === undefined || !Number.isFinite(perRunBudget)) return false;
	const c = run.cost?.costUsd;
	if (typeof c !== "number" || !Number.isFinite(c)) return false;
	return c > perRunBudget;
}

/**
 * Budget-cap predicate: any finite cap exceeded → true.
 *
 * `projectedNextCostUsd` (default 0) is the cost the loop expects the NEXT
 * candidate to incur (the comparable per-run budget). The `maxCostUsd` cap is a
 * HARD PRE-SPAWN cap: the loop must refuse to launch another candidate when the
 * already-spent cost plus that projection would exceed the cap. Without this,
 * a loop with `cumulative < maxCostUsd` but `cumulative + perRunBudget >
 * maxCostUsd` would still spawn one more (over-budget) child.
 */
export function exceedsCaps(args: {
	caps?: AutoresearchCaps;
	iterations: number;
	cumulativeCostUsd: number;
	elapsedMs: number;
	projectedNextCostUsd?: number;
}): { exceeded: boolean; reason?: string } {
	const caps = args.caps ?? {};
	if (typeof caps.maxIterations === "number" && args.iterations >= caps.maxIterations) {
		return { exceeded: true, reason: `budget: iterations >= ${caps.maxIterations}` };
	}
	if (typeof caps.maxCostUsd === "number") {
		if (args.cumulativeCostUsd >= caps.maxCostUsd) {
			return { exceeded: true, reason: `budget: cost >= ${caps.maxCostUsd}` };
		}
		const projected = typeof args.projectedNextCostUsd === "number" && Number.isFinite(args.projectedNextCostUsd)
			? args.projectedNextCostUsd
			: 0;
		if (projected > 0 && args.cumulativeCostUsd + projected > caps.maxCostUsd) {
			return {
				exceeded: true,
				reason: `budget: projected cost ${args.cumulativeCostUsd + projected} > ${caps.maxCostUsd}`,
			};
		}
	}
	if (typeof caps.maxWallClockMs === "number" && args.elapsedMs >= caps.maxWallClockMs) {
		return { exceeded: true, reason: `budget: wallClock >= ${caps.maxWallClockMs}ms` };
	}
	return { exceeded: false };
}

/**
 * Evaluate ALL stop conditions deterministically from the registry. Used both by
 * the loop (to decide) and by reporting (to annotate the curve) — one
 * implementation, so they cannot drift.
 */
export function evaluateStop(args: {
	series: ObjectivePoint[];
	objective: ObjectiveSpec;
	caps?: AutoresearchCaps;
	stop?: StopSpec;
	cumulativeCostUsd: number;
	elapsedMs: number;
	/** Cost the next candidate is expected to incur (the comparable per-run
	 *  budget). Enforces `maxCostUsd` as a hard PRE-SPAWN cap. */
	projectedNextCostUsd?: number;
}): StopAnnotation {
	const { series, objective, caps, stop } = args;
	const iterations = series.length;

	const budget = exceedsCaps({
		caps,
		iterations,
		cumulativeCostUsd: args.cumulativeCostUsd,
		elapsedMs: args.elapsedMs,
		projectedNextCostUsd: args.projectedNextCostUsd,
	});
	if (budget.exceeded) {
		return { stopped: true, reason: budget.reason as string, iteration: iterations };
	}

	const target = stop?.target ?? objective.target;
	if (typeof target === "number" && hitTarget(series, target, objective.direction)) {
		return { stopped: true, reason: `target: objective crossed ${target}`, iteration: iterations };
	}

	if (typeof stop?.plateauK === "number" && stop.plateauK > 0 && isPlateau(series, stop.plateauK)) {
		return { stopped: true, reason: `plateau over K=${stop.plateauK}`, iteration: iterations };
	}

	return { stopped: false, reason: "" };
}

/** Derive a stop annotation directly from a ledger (when no live timers/cost). */
export function stopFromLedger(ledger: LedgerEntry[], stop?: StopSpec): StopAnnotation {
	if (!ledger.length) return { stopped: false, reason: "" };
	const K = stop?.plateauK;
	if (typeof K === "number" && K > 0 && ledger.length >= K) {
		const tail = ledger.slice(-K);
		if (tail.every((e) => e.decision === "rejected")) {
			return { stopped: true, reason: `plateau over K=${K}`, iteration: ledger.length };
		}
	}
	return { stopped: false, reason: "" };
}
