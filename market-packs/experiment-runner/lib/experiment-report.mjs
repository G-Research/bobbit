// Experiment-runner SHARED reporting library (single source of truth).
//
// This file is the `build:packs` bundle target of `src/shared/experiment-report/`
// (authored by the reporting sub-stream). Until that branch lands, this committed
// module IS the canonical implementation: every median/spread/same-bar
// aggregation, every best-so-far/plateau/target/budget predicate, and the entire
// spec-driven widget registry live HERE and nowhere else. The pack-side adapters
// (`lib/aggregate.mjs`, `lib/autoresearch.mjs`, `lib/widgets.mjs`) import from this
// module and add only store/orchestration plumbing — they contain NO local
// median/percentile/accept-stop math (the no-fork pinning guard enforces this).
//
// All functions here are PURE (no I/O, no clock, no randomness) so the report
// route, the panel dashboard, and the unit tests all produce byte-identical output
// for the same registry input.

// ───────────────────────────── aggregation ─────────────────────────────

/** Median of a numeric array (sorted copy). null for an empty array. */
export function median(values) {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).slice().sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const mid = Math.floor(nums.length / 2);
	return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

/** Linear-interpolated percentile (p in [0,100]). null for an empty array. */
export function percentile(values, p) {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).slice().sort((a, b) => a - b);
	if (nums.length === 0) return null;
	if (nums.length === 1) return nums[0];
	const rank = (p / 100) * (nums.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return nums[lo];
	return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo);
}

/** Interquartile range (p75 - p25) as the spread measure. 0 for <2 values. */
export function iqr(values) {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	if (nums.length < 2) return 0;
	const q1 = percentile(nums, 25);
	const q3 = percentile(nums, 75);
	return q1 === null || q3 === null ? 0 : q3 - q1;
}

function mean(values) {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	if (nums.length === 0) return null;
	return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Reduce values per a selected aggregation. Defaults to median. */
export function reduceValues(values, aggregation = "median") {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	switch (aggregation) {
		case "mean":
			return mean(nums);
		case "min":
			return nums.length ? Math.min(...nums) : null;
		case "max":
			return nums.length ? Math.max(...nums) : null;
		case "p90":
			return percentile(nums, 90);
		case "count":
			return nums.length;
		case "median":
		default:
			return median(nums);
	}
}

function better(a, b, direction) {
	return direction === "min" ? a < b : a > b;
}

function armLabel(def, armId) {
	const v = def && Array.isArray(def.variants) ? def.variants.find((x) => x.armId === armId) : undefined;
	return (v && v.label) || armId;
}

/**
 * A/B aggregation: for each (armId, metricId), median + spread over same-bar runs.
 * `metrics` are resolved descriptors `{ metricId, label?, direction?, unit?, aggregation? }`.
 * `bar` is the canonical CompletionBar to keep (default 'passed').
 */
export function aggregateExperiment({ def, runs = [], metrics = [], bar = "passed" }) {
	const arms = {};
	const armOrder = [];
	for (const run of runs) {
		if (!run || !run.armId) continue;
		if (!arms[run.armId]) {
			arms[run.armId] = { armId: run.armId, label: armLabel(def, run.armId), metrics: {}, n: 0, nPassed: 0 };
			armOrder.push(run.armId);
		}
	}
	for (const armId of armOrder) {
		const arm = arms[armId];
		const armRuns = runs.filter((r) => r.armId === armId);
		arm.n = armRuns.length;
		const barRuns = armRuns.filter((r) => r.completionBar === bar);
		arm.nPassed = barRuns.length;
		for (const m of metrics) {
			const values = barRuns
				.map((r) => (r.metrics ? r.metrics[m.metricId] : undefined))
				.filter((v) => typeof v === "number" && Number.isFinite(v));
			arm.metrics[m.metricId] = {
				value: reduceValues(values, m.aggregation || "median"),
				spread: iqr(values),
				n: values.length,
				droppedN: barRuns.length - values.length,
				values,
			};
		}
	}
	const ranking = {};
	for (const m of metrics) {
		const dir = m.direction || "max";
		const scored = armOrder
			.map((a) => ({ armId: a, value: arms[a].metrics[m.metricId] ? arms[a].metrics[m.metricId].value : null }))
			.filter((x) => typeof x.value === "number" && Number.isFinite(x.value));
		scored.sort((x, y) => (better(x.value, y.value, dir) ? -1 : better(y.value, x.value, dir) ? 1 : 0));
		ranking[m.metricId] = { order: scored.map((s) => s.armId), winner: scored.length ? scored[0].armId : null, direction: dir };
	}
	return { mode: (def && def.mode) || "ab", arms, armOrder, ranking, bar };
}

// ───────────────────────────── series / accept-stop ─────────────────────────────

const VALID_BAR = "passed";

/** Running best objective over verified+passed runs only (correctness gate). */
export function computeBestSoFar(runs = [], objective) {
	if (!objective) return null;
	const dir = objective.direction || "max";
	let best = null;
	for (const r of runs) {
		if (r.verified !== true || r.completionBar !== VALID_BAR) continue;
		const v = r.metrics ? r.metrics[objective.metricId] : undefined;
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		if (best === null || better(v, best, dir)) best = v;
	}
	return best;
}

/**
 * Best-objective-vs-iteration series. Walks iterations in order, keeping the
 * running best of verified+passed candidates only. Single source for both the
 * loop's accept decision and the dashboard curve.
 */
export function objectiveSeries({ runs = [], objective } = {}) {
	if (!objective) return [];
	const dir = objective.direction || "max";
	const iters = runs
		.filter((r) => typeof r.iteration === "number")
		.slice()
		.sort((a, b) => a.iteration - b.iteration);
	let best = null;
	const out = [];
	for (const r of iters) {
		const v = r.metrics ? r.metrics[objective.metricId] : undefined;
		const valid = r.verified === true && r.completionBar === VALID_BAR && typeof v === "number" && Number.isFinite(v);
		let accepted = false;
		if (valid && (best === null || better(v, best, dir))) {
			best = v;
			accepted = true;
		}
		out.push({
			iteration: r.iteration,
			runId: r.runId,
			objective: typeof v === "number" && Number.isFinite(v) ? v : null,
			verified: r.verified === true,
			completionBar: r.completionBar || null,
			accepted,
			bestSoFar: best,
		});
	}
	return out;
}

/** Whether `value` improves on `best` by more than eps (direction-aware). */
export function isImprovement(value, best, direction = "max", eps = 0) {
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	if (best === null || best === undefined) return true;
	const delta = direction === "max" ? value - best : best - value;
	return delta > eps;
}

/** No accepted improvement (> eps) over the last K iterations of the series. */
export function isPlateau(series = [], K, eps = 0) {
	if (!Number.isFinite(K) || K <= 0) return false;
	if (series.length < K) return false;
	let lastImprove = -1;
	let prevBest = null;
	for (let i = 0; i < series.length; i++) {
		const b = series[i].bestSoFar;
		if (b === null || b === undefined) continue;
		if (prevBest === null) {
			prevBest = b;
			lastImprove = i;
			continue;
		}
		if (Math.abs(b - prevBest) > eps) {
			lastImprove = i;
			prevBest = b;
		}
	}
	const sinceImprove = series.length - 1 - lastImprove;
	return sinceImprove >= K;
}

/** Whether `best` has crossed `target` (direction-aware). */
export function hitTarget(best, target, direction = "max") {
	if (typeof best !== "number" || !Number.isFinite(best)) return false;
	if (typeof target !== "number" || !Number.isFinite(target)) return false;
	return direction === "max" ? best >= target : best <= target;
}

/** Hard-cap budget check. Returns { exceeded, reason } or null. */
export function budgetStatus({ cumulativeCostUsd = 0, iterations = 0, elapsedMs = 0, caps = {} } = {}) {
	if (Number.isFinite(caps.maxIterations) && iterations >= caps.maxIterations) {
		return { exceeded: true, reason: `maxIterations (${caps.maxIterations})` };
	}
	if (Number.isFinite(caps.maxCostUsd) && cumulativeCostUsd >= caps.maxCostUsd) {
		return { exceeded: true, reason: `maxCostUsd (${caps.maxCostUsd})` };
	}
	if (Number.isFinite(caps.maxWallClockMs) && elapsedMs >= caps.maxWallClockMs) {
		return { exceeded: true, reason: `maxWallClockMs (${caps.maxWallClockMs})` };
	}
	return null;
}

/**
 * Deterministic accept/reject for a settled candidate. The LLM proposes; this
 * decides. Correctness gate is absolute: a candidate failing verification is
 * rejected even if the objective "improved".
 */
export function decideCandidate({ objective, verified, completionBar, best, direction = "max", plateauEps = 0 } = {}) {
	if (verified !== true || completionBar !== VALID_BAR) {
		return { decision: "rejected", reason: "failed-correctness-gate" };
	}
	if (typeof objective !== "number" || !Number.isFinite(objective)) {
		return { decision: "rejected", reason: "no-objective" };
	}
	if (best === null || best === undefined) {
		return { decision: "accepted", reason: "first valid candidate" };
	}
	if (isImprovement(objective, best, direction, plateauEps)) {
		return { decision: "accepted", reason: "improved & passed" };
	}
	return { decision: "rejected", reason: "regressed" };
}

/**
 * Deterministic stop evaluation over the registry (ledger/series + caps + stop).
 * Returns { stopped, reason? }.
 */
export function evaluateStop({ series = [], caps = {}, stop = {}, objective, cumulativeCostUsd = 0, elapsedMs = 0, iterations = 0 } = {}) {
	const budget = budgetStatus({ cumulativeCostUsd, iterations, elapsedMs, caps });
	if (budget) return { stopped: true, reason: `budget: ${budget.reason}` };
	const best = series.length ? series[series.length - 1].bestSoFar : null;
	const dir = (objective && objective.direction) || "max";
	if (stop && typeof stop.target === "number" && hitTarget(best, stop.target, dir)) {
		return { stopped: true, reason: `target (${stop.target})` };
	}
	if (stop && Number.isFinite(stop.plateauK) && isPlateau(series, stop.plateauK, stop.plateauEps || 0)) {
		return { stopped: true, reason: `plateau over K=${stop.plateauK}` };
	}
	return { stopped: false };
}

// ───────────────────────────── widget registry ─────────────────────────────

const widgetRegistry = new Map();

/** Register a widget renderer. type collisions overwrite (last-write-wins). */
export function registerWidget(renderer) {
	if (!renderer || typeof renderer.type !== "string" || typeof renderer.render !== "function") {
		throw new Error("registerWidget: { type, render } required");
	}
	widgetRegistry.set(renderer.type, renderer);
}

/** Resolve a registered widget renderer by type. */
export function getWidget(type) {
	return widgetRegistry.get(type);
}

/** Descriptors for the dashboard editor (the registry introspection seam). */
export function listWidgets() {
	return [...widgetRegistry.values()].map((w) => ({ type: w.type, label: w.label || w.type, modes: w.modes || ["ab", "autoresearch"] }));
}

function esc(value) {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmt(value, unit) {
	if (value === null || value === undefined || typeof value !== "number" || !Number.isFinite(value)) return "—";
	const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(3);
	return unit ? `${rounded} ${esc(unit)}` : String(rounded);
}

function metricLabel(model, metricId) {
	const m = (model.metrics || []).find((x) => x.metricId === metricId);
	return (m && (m.label || m.metricId)) || metricId;
}

function metricUnit(model, metricId) {
	const m = (model.metrics || []).find((x) => x.metricId === metricId);
	return m ? m.unit : undefined;
}

function chartColor(i) {
	return `var(--chart-${(i % 6) + 1})`;
}

// ── built-in widget renderers (canonical type ids) ──

registerWidget({
	type: "summary-cards",
	label: "Summary cards",
	render: ({ model }) => {
		const cards = (model.summary && model.summary.cards) || [];
		const items = cards
			.map(
				(c) => `
		<div style="flex:1 1 160px;min-width:140px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;">
			<div style="font-size:12px;color:var(--muted-foreground);">${esc(c.label)}</div>
			<div style="font-size:20px;font-weight:600;color:var(--foreground);margin-top:4px;">${esc(c.value)}</div>
		</div>`
			)
			.join("");
		return `<div style="display:flex;gap:12px;flex-wrap:wrap;">${items}</div>`;
	},
});

registerWidget({
	type: "comparison-table",
	label: "Comparison table",
	modes: ["ab"],
	render: ({ model, spec }) => {
		const agg = model.aggregation || { arms: {}, armOrder: [], ranking: {} };
		const metricIds = (spec && spec.bind && spec.bind.metricIds) || (model.metrics || []).map((m) => m.metricId);
		const head = metricIds.map((id) => `<th style="text-align:right;padding:6px 10px;color:var(--muted-foreground);font-weight:500;">${esc(metricLabel(model, id))}</th>`).join("");
		const rows = agg.armOrder
			.map((armId) => {
				const arm = agg.arms[armId] || { label: armId, metrics: {} };
				const cells = metricIds
					.map((id) => {
						const cell = arm.metrics[id] || {};
						const winner = agg.ranking[id] && agg.ranking[id].winner === armId;
						const color = winner ? "var(--positive)" : "var(--foreground)";
						const weight = winner ? "600" : "400";
						return `<td style="text-align:right;padding:6px 10px;color:${color};font-weight:${weight};">${esc(fmt(cell.value, metricUnit(model, id)))}<span style="color:var(--muted-foreground);font-size:11px;"> ±${esc(fmt(cell.spread))}</span></td>`;
					})
					.join("");
				return `<tr><td style="padding:6px 10px;color:var(--foreground);">${esc(arm.label)}</td>${cells}</tr>`;
			})
			.join("");
		return `<table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr><th style="text-align:left;padding:6px 10px;color:var(--muted-foreground);font-weight:500;">Arm</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
	},
});

registerWidget({
	type: "score-bars",
	label: "Score bars",
	modes: ["ab"],
	render: ({ model, spec }) => {
		const agg = model.aggregation || { arms: {}, armOrder: [], ranking: {} };
		const metricIds = (spec && spec.bind && spec.bind.metricIds) || (model.metrics || []).map((m) => m.metricId);
		const blocks = metricIds
			.map((id) => {
				const vals = agg.armOrder.map((a) => (agg.arms[a].metrics[id] ? agg.arms[a].metrics[id].value : null)).filter((v) => typeof v === "number");
				const max = vals.length ? Math.max(...vals.map((v) => Math.abs(v))) || 1 : 1;
				const bars = agg.armOrder
					.map((armId, i) => {
						const cell = agg.arms[armId].metrics[id] || {};
						const v = typeof cell.value === "number" ? cell.value : 0;
						const pct = Math.max(2, Math.round((Math.abs(v) / max) * 100));
						return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
						<div style="width:90px;font-size:12px;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(agg.arms[armId].label)}</div>
						<div style="flex:1;background:color-mix(in oklch, var(--muted-foreground) 15%, transparent);border-radius:4px;height:14px;"><div style="width:${pct}%;height:14px;background:${chartColor(i)};border-radius:4px;"></div></div>
						<div style="width:64px;text-align:right;font-size:12px;color:var(--foreground);">${esc(fmt(cell.value, metricUnit(model, id)))}</div>
					</div>`;
					})
					.join("");
				return `<div style="margin-bottom:12px;"><div style="font-size:12px;font-weight:600;color:var(--foreground);margin-bottom:4px;">${esc(metricLabel(model, id))}</div>${bars}</div>`;
			})
			.join("");
		return `<div>${blocks}</div>`;
	},
});

registerWidget({
	type: "objective-curve",
	label: "Objective curve",
	modes: ["autoresearch"],
	render: ({ model }) => {
		const series = model.series || [];
		if (series.length === 0) return `<div style="color:var(--muted-foreground);font-size:13px;">No iterations yet.</div>`;
		const bests = series.map((p) => p.bestSoFar).filter((v) => typeof v === "number");
		const lo = bests.length ? Math.min(...bests) : 0;
		const hi = bests.length ? Math.max(...bests) : 1;
		const span = hi - lo || 1;
		const w = 480;
		const h = 140;
		const pts = series
			.map((p, i) => {
				const x = series.length === 1 ? 0 : (i / (series.length - 1)) * w;
				const y = typeof p.bestSoFar === "number" ? h - ((p.bestSoFar - lo) / span) * h : h;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
		const markers = series
			.map((p, i) => {
				if (!p.accepted) return "";
				const x = series.length === 1 ? 0 : (i / (series.length - 1)) * w;
				const y = typeof p.bestSoFar === "number" ? h - ((p.bestSoFar - lo) / span) * h : h;
				return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--positive)" />`;
			})
			.join("");
		const stop = model.summary && model.summary.stopped ? `<div style="font-size:12px;color:var(--warning);margin-top:6px;">Stopped: ${esc(model.summary.stopped)}</div>` : "";
		return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="background:var(--card);border:1px solid var(--border);border-radius:8px;"><polyline points="${pts}" fill="none" stroke="var(--chart-1)" stroke-width="2" />${markers}</svg>${stop}`;
	},
});

registerWidget({
	type: "ledger-table",
	label: "Ledger",
	modes: ["autoresearch"],
	render: ({ model }) => {
		const ledger = model.ledger || [];
		if (ledger.length === 0) return `<div style="color:var(--muted-foreground);font-size:13px;">Ledger empty.</div>`;
		const rows = ledger
			.map((e) => {
				const color = e.decision === "accepted" ? "var(--positive)" : "var(--negative)";
				return `<tr>
				<td style="padding:5px 10px;color:var(--foreground);">${esc(e.iteration)}</td>
				<td style="padding:5px 10px;text-align:right;color:var(--foreground);">${esc(fmt(e.objective))}</td>
				<td style="padding:5px 10px;color:${color};">${esc(e.decision)}</td>
				<td style="padding:5px 10px;color:var(--muted-foreground);">${esc(e.reason)}</td>
				<td style="padding:5px 10px;text-align:right;color:var(--foreground);">${esc(fmt(e.bestObjectiveAfter))}</td>
			</tr>`;
			})
			.join("");
		return `<table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Iter</th>
			<th style="text-align:right;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Objective</th>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Decision</th>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Reason</th>
			<th style="text-align:right;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Best</th>
		</tr></thead><tbody>${rows}</tbody></table>`;
	},
});

registerWidget({
	type: "raw-drilldown",
	label: "Raw outcomes",
	render: ({ model }) => {
		const runs = model.runs || [];
		if (runs.length === 0) return `<div style="color:var(--muted-foreground);font-size:13px;">No runs.</div>`;
		const rows = runs
			.map((r) => {
				const raw = r.rawOutcome || {};
				return `<tr>
				<td style="padding:5px 10px;color:var(--foreground);">${esc(r.runId)}</td>
				<td style="padding:5px 10px;color:var(--muted-foreground);">${esc(r.status)}</td>
				<td style="padding:5px 10px;color:var(--muted-foreground);">${esc(r.completionBar || "—")}</td>
				<td style="padding:5px 10px;text-align:right;color:var(--foreground);">${esc(fmt(raw.costUsd, "$"))}</td>
			</tr>`;
			})
			.join("");
		return `<table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Run</th>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Status</th>
			<th style="text-align:left;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Bar</th>
			<th style="text-align:right;padding:5px 10px;color:var(--muted-foreground);font-weight:500;">Cost</th>
		</tr></thead><tbody>${rows}</tbody></table>`;
	},
});

// ───────────────────────────── report model + html ─────────────────────────────

/** Default dashboard layout per mode (the single rule both surfaces share). */
export function defaultDashboardFor(mode) {
	if (mode === "autoresearch") {
		return {
			widgets: [
				{ id: "summary", type: "summary-cards" },
				{ id: "curve", type: "objective-curve", bind: { objective: true } },
				{ id: "ledger", type: "ledger-table" },
			],
		};
	}
	return {
		widgets: [
			{ id: "summary", type: "summary-cards" },
			{ id: "comparison", type: "comparison-table" },
			{ id: "bars", type: "score-bars" },
		],
	};
}

/** stored ?? defaultDashboardFor(mode). */
export function resolveDashboard(stored, mode) {
	if (stored && Array.isArray(stored.widgets) && stored.widgets.length > 0) return stored;
	return defaultDashboardFor(mode);
}

function buildSummary({ def, runs, aggregation, series, ledger, state }) {
	const mode = (def && def.mode) || "ab";
	const cards = [];
	const totalRuns = runs.length;
	const collected = runs.filter((r) => r.status === "collected").length;
	cards.push({ label: "Runs", value: `${collected}/${totalRuns}` });
	const totalCost = runs.reduce((acc, r) => acc + (r.cost && typeof r.cost.costUsd === "number" ? r.cost.costUsd : 0), 0);
	cards.push({ label: "Total cost", value: totalCost ? `$${totalCost.toFixed(2)}` : "—" });
	let stopped;
	if (mode === "autoresearch") {
		const best = series.length ? series[series.length - 1].bestSoFar : null;
		cards.push({ label: "Best objective", value: best === null ? "—" : fmt(best) });
		cards.push({ label: "Iterations", value: String(series.length) });
		stopped = state && state.stopped ? state.stopped.reason : undefined;
	} else {
		const objMetric = (aggregation.ranking && Object.keys(aggregation.ranking)[0]) || null;
		const winner = objMetric && aggregation.ranking[objMetric] ? aggregation.ranking[objMetric].winner : null;
		const winnerLabel = winner && aggregation.arms[winner] ? aggregation.arms[winner].label : "—";
		cards.push({ label: "Leading arm", value: winnerLabel });
	}
	return { cards, stopped, ledgerSize: (ledger || []).length };
}

/**
 * Pure registry → ReportModel. No store access, no clock.
 * `metrics` are resolved descriptors; `dashboard`/`state` are optional.
 */
export function buildReportModel({ def, runs = [], ledger = [], dashboard, metrics = [], state } = {}) {
	const mode = (def && def.mode) || "ab";
	const resolved = resolveDashboard(dashboard, mode);
	const aggregation = aggregateExperiment({ def, runs, metrics });
	const series = mode === "autoresearch" && def && def.objective ? objectiveSeries({ runs, objective: def.objective }) : [];
	const summary = buildSummary({ def, runs, aggregation, series, ledger, state });
	return {
		experimentId: def && def.experimentId,
		title: def && def.title,
		mode,
		def: def || null,
		runs,
		ledger,
		metrics,
		dashboard: resolved,
		aggregation,
		series,
		summary,
	};
}

/** Render a full self-contained themed HTML document from a ReportModel. */
export function renderReportHtml(model) {
	const widgets = (model.dashboard && model.dashboard.widgets) || [];
	const body = widgets
		.map((spec) => {
			const renderer = getWidget(spec.type);
			const inner = renderer ? renderer.render({ model, spec }) : `<div style="color:var(--negative);">Unknown widget: ${esc(spec.type)}</div>`;
			const title = spec.title ? `<h3 style="font-size:14px;font-weight:600;color:var(--foreground);margin:0 0 8px;">${esc(spec.title)}</h3>` : "";
			return `<section style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;">${title}${inner}</section>`;
		})
		.join("");
	return `<div style="background:var(--background);color:var(--foreground);padding:16px;font-family:system-ui,sans-serif;">
		<h2 style="font-size:18px;font-weight:700;margin:0 0 16px;">${esc(model.title || model.experimentId || "Experiment")}</h2>
		${body}
	</div>`;
}
