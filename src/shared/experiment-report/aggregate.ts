// Aggregation — the ONLY place medians/spreads/same-bar filters are computed
// (docs/design/experiment-runner-reporting.md §5). Pure functions over plain
// arrays; no I/O, no clock, no randomness. Both the report route and the panel
// import these (via the bundled lib) so the numbers can never drift; the no-fork
// pinning test fails CI on any local median(/percentile( definition elsewhere.

import type {
	Aggregation,
	ArmAggregate,
	CompletionBar,
	Direction,
	ExperimentDef,
	MetricComparison,
	MetricSelection,
	MetricValue,
	RunRecord,
	Spread,
} from "./types.js";

/** Built-in metric directions (canonical ids — pack-backend §7.1). */
export const BUILTIN_METRIC_DIRECTIONS: Record<string, Direction> = {
	"cost.totalUsd": "min",
	"cost.tokensTotal": "min",
	"cost.cacheHitRate": "max",
	"gates.passRate": "max",
	"gates.firstPassClean": "max",
	"tasks.completionRate": "max",
	"time.wallClockMs": "min",
	"objective.value": "max",
	"command.metric": "max",
};

/** Numeric sort ascending (does not mutate the input). */
function sortedAsc(values: number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

/** Median of a numeric array. Returns null for an empty array. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = sortedAsc(values);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Linear-interpolated percentile (p in [0,100]). Returns null for an empty array. */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const s = sortedAsc(values);
	if (s.length === 1) return s[0];
	const clamped = Math.min(100, Math.max(0, p));
	const rank = (clamped / 100) * (s.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return s[lo];
	const frac = rank - lo;
	return s[lo] + (s[hi] - s[lo]) * frac;
}

/** Arithmetic mean. Returns null for an empty array. */
export function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Reduce a set of numbers per the requested aggregation. */
export function reduceValues(values: number[], aggregation: Aggregation): number | null {
	if (aggregation === "count") return values.length;
	if (values.length === 0) return null;
	switch (aggregation) {
		case "mean":
			return mean(values);
		case "min":
			return Math.min(...values);
		case "max":
			return Math.max(...values);
		case "p90":
			return percentile(values, 90);
		case "median":
		default:
			return median(values);
	}
}

/** Spread (min/p25/p75/max + IQR) of a set of numbers, or null if empty. */
export function spreadOf(values: number[]): Spread | null {
	if (values.length === 0) return null;
	const p25 = percentile(values, 25) as number;
	const p75 = percentile(values, 75) as number;
	return {
		min: Math.min(...values),
		max: Math.max(...values),
		p25,
		p75,
		iqr: p75 - p25,
	};
}

/** A bar filter: a concrete completion bar, or 'all' (no same-bar filtering). */
export type BarFilter = CompletionBar | "all";

/**
 * Keep only runs whose completionBar matches the requested bar (default
 * 'passed'). The special value 'all' disables same-completion-bar filtering and
 * keeps every run (used when an experiment opts out of same-bar aggregation).
 */
export function filterByBar(runs: RunRecord[], bar: BarFilter = "passed"): RunRecord[] {
	if (bar === "all") return [...runs];
	return runs.filter((r) => (r.completionBar ?? "incomplete") === bar);
}

/** Resolve a metric's optimization direction (selection override > built-in > 'max'). */
export function metricDirection(metricId: string, selection?: MetricSelection): Direction {
	if (selection?.directionOverride) return selection.directionOverride;
	return BUILTIN_METRIC_DIRECTIONS[metricId] ?? "max";
}

function numericMetric(run: RunRecord, metricId: string): number | null {
	const v: MetricValue | undefined = run.metrics?.[metricId];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Aggregate one (arm × metric): collect across the arm's repeats, apply
 * same-completion-bar filtering, drop nulls, reduce per the selection's
 * aggregation (median default). `droppedN` counts samples removed by the bar
 * filter (not the null drop, which is reflected by a lower `n`).
 */
export function aggregateArm(
	runs: RunRecord[],
	armId: string,
	selection: MetricSelection,
): ArmAggregate {
	const metricId = selection.metricId;
	const bar: BarFilter = selection.bar ?? "passed";
	const armRuns = runs.filter((r) => r.armId === armId);
	const kept = filterByBar(armRuns, bar);
	const droppedN = armRuns.length - kept.length;
	const values: number[] = [];
	for (const r of kept) {
		const v = numericMetric(r, metricId);
		if (v !== null) values.push(v);
	}
	const aggregation: Aggregation = selection.aggregation ?? "median";
	return {
		armId,
		metricId,
		value: reduceValues(values, aggregation),
		spread: spreadOf(values),
		n: values.length,
		droppedN,
	};
}

/** Distinct arm ids in stable order (variants first, then any run-only arms). */
export function armIdsOf(def: ExperimentDef | undefined, runs: RunRecord[]): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const v of def?.variants ?? []) {
		if (!seen.has(v.armId)) {
			seen.add(v.armId);
			order.push(v.armId);
		}
	}
	for (const r of runs) {
		if (!seen.has(r.armId)) {
			seen.add(r.armId);
			order.push(r.armId);
		}
	}
	return order;
}

/** Aggregate every (arm × selected metric) for A/B reporting. */
export function aggregateAB(
	def: ExperimentDef | undefined,
	runs: RunRecord[],
	metrics: MetricSelection[],
): ArmAggregate[] {
	const arms = armIdsOf(def, runs);
	const out: ArmAggregate[] = [];
	for (const selection of metrics) {
		for (const armId of arms) {
			out.push(aggregateArm(runs, armId, selection));
		}
	}
	return out;
}

/** True if `candidate` is strictly better than `incumbent` for the direction. */
export function isBetter(candidate: number, incumbent: number, direction: Direction): boolean {
	return direction === "max" ? candidate > incumbent : candidate < incumbent;
}

/**
 * Direction-aware comparison for one metric across arms. The framework picks the
 * winner deterministically (the LLM never does). Deltas are relative to the
 * chosen baseline (default: the first arm with a non-null value).
 */
export function compareMetric(
	aggregates: ArmAggregate[],
	selection: MetricSelection,
	baselineArmId?: string,
): MetricComparison {
	const metricId = selection.metricId;
	const direction = metricDirection(metricId, selection);
	const forMetric = aggregates.filter((a) => a.metricId === metricId);

	// Winner: best non-null value for the direction.
	let winnerArmId: string | null = null;
	let winnerValue: number | null = null;
	for (const a of forMetric) {
		if (a.value === null) continue;
		if (winnerValue === null || isBetter(a.value, winnerValue, direction)) {
			winnerValue = a.value;
			winnerArmId = a.armId;
		}
	}

	// Baseline: explicit, else first arm with a non-null value.
	let baseId = baselineArmId;
	if (!baseId) {
		const firstWithValue = forMetric.find((a) => a.value !== null);
		baseId = firstWithValue?.armId;
	}
	const baseValue = forMetric.find((a) => a.armId === baseId)?.value ?? null;

	return {
		metricId,
		direction,
		baselineArmId: baseId,
		winnerArmId,
		arms: forMetric.map((a) => {
			const delta = a.value !== null && baseValue !== null ? a.value - baseValue : null;
			const deltaPct = delta !== null && baseValue !== null && baseValue !== 0 ? delta / baseValue : null;
			return {
				armId: a.armId,
				value: a.value,
				spread: a.spread,
				n: a.n,
				droppedN: a.droppedN,
				isWinner: a.armId === winnerArmId,
				delta,
				deltaPct,
			};
		}),
	};
}

/** Per-metric comparisons across all selected metrics. */
export function compareAll(
	aggregates: ArmAggregate[],
	metrics: MetricSelection[],
	baselineArmId?: string,
): MetricComparison[] {
	return metrics.map((selection) => compareMetric(aggregates, selection, baselineArmId));
}
