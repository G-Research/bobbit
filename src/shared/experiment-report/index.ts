// The reporting library public surface — the ONLY sanctioned entry points every
// report surface goes through (docs/design/experiment-runner-reporting.md §11):
//   buildReportModel  — pure projection of registry + raw outcomes → ReportModel
//   renderReportHtml  — ReportModel → self-contained theme-token HTML document
//   resolveDashboard  — stored ?? defaultDashboardFor(mode)
//
// Pure module: no node:/server imports, so build:packs bundles it into the pack's
// confined worker as lib/experiment-report.mjs.

import { aggregateAB, compareAll, metricDirection } from "./aggregate.js";
import { bestObjective, buildObjectiveSeries, cumulativeCost, stopFromLedger } from "./series.js";
import type {
	ArmAggregate,
	DashboardSpec,
	ExperimentDef,
	ExperimentMode,
	LedgerEntry,
	MetricComparison,
	MetricSelection,
	ObjectivePoint,
	ReportModel,
	ReportSummary,
	RunRecord,
	StopAnnotation,
	WidgetSpec,
} from "./types.js";
import { registerBuiltinWidgets } from "./widgets/builtins.js";
import { getWidget } from "./widgets/registry.js";
import { card, emptyNote, escapeHtml } from "./widgets/theme.js";

// Register the built-in widgets exactly once at module load. Pack-contributed
// widgets register THROUGH the same shared registry (registry.ts).
registerBuiltinWidgets();

// Re-export the canonical contracts so consumers import from one place.
export * from "./types.js";
export * from "./aggregate.js";
export * from "./series.js";
export {
	getWidget,
	hasWidget,
	listWidgets,
	registerWidget,
	unregisterWidget,
	type WidgetRenderer,
} from "./widgets/registry.js";
export { BUILTIN_WIDGETS, BUILTIN_WIDGET_TYPES, registerBuiltinWidgets } from "./widgets/builtins.js";
export {
	card,
	chartColor,
	deltaColor,
	emptyNote,
	escapeHtml,
	fmtDelta,
	fmtPct,
	fmtValue,
} from "./widgets/theme.js";

/** Default dashboard layout per mode (the single per-mode default). */
export function defaultDashboardFor(mode: ExperimentMode): DashboardSpec {
	if (mode === "autoresearch") {
		return {
			mode,
			widgets: [
				{ id: "summary", type: "summary-cards", bind: {} },
				{ id: "objective", type: "objective-curve", bind: { objective: true } },
				{ id: "ledger", type: "ledger-table", bind: {} },
			],
		};
	}
	return {
		mode,
		widgets: [
			{ id: "summary", type: "summary-cards", bind: {} },
			{ id: "comparison", type: "comparison-table", bind: {} },
			{ id: "scores", type: "score-bars", bind: {} },
		],
	};
}

/** The single dashboard resolution rule: stored spec, else the per-mode default. */
export function resolveDashboard(
	stored: DashboardSpec | undefined | null,
	mode: ExperimentMode,
): DashboardSpec {
	if (stored && Array.isArray(stored.widgets)) return stored;
	return defaultDashboardFor(mode);
}

/** Distinct metric ids that appear across the runs, in first-seen order. */
function metricIdsFromRuns(runs: RunRecord[]): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const r of runs) {
		for (const id of Object.keys(r.metrics ?? {})) {
			if (!seen.has(id)) {
				seen.add(id);
				order.push(id);
			}
		}
	}
	return order;
}

/**
 * Resolve the metric selection: explicit selection wins; otherwise derive a
 * default from the metric ids present in the runs (median aggregation, built-in
 * direction). For autoresearch the objective metric is marked primary.
 */
function resolveMetrics(
	def: ExperimentDef | undefined,
	runs: RunRecord[],
	metrics?: MetricSelection[],
): MetricSelection[] {
	if (metrics && metrics.length) return metrics;
	const objId = def?.objective?.metricId;
	const ids = metricIdsFromRuns(runs);
	if (objId && !ids.includes(objId)) ids.unshift(objId);
	return ids.map((metricId) => ({
		metricId,
		aggregation: "median" as const,
		primary: objId ? metricId === objId : ids[0] === metricId,
	}));
}

function buildSummary(args: {
	mode: ExperimentMode;
	runs: RunRecord[];
	comparisons: MetricComparison[];
	series: ObjectivePoint[];
	metrics: MetricSelection[];
	objectiveMetricId?: string;
}): ReportSummary {
	const { mode, runs, comparisons, series, metrics, objectiveMetricId } = args;
	const failedRuns = runs.filter((r) => r.status === "failed" || r.status === "cancelled").length;
	const settledRuns = runs.filter((r) => r.status === "settled" || r.status === "collected").length;

	let actualCostUsd: number | null = null;
	for (const r of runs) {
		const c = r.cost?.costUsd;
		if (typeof c === "number" && Number.isFinite(c)) actualCostUsd = (actualCostUsd ?? 0) + c;
	}

	const primary = metrics.find((m) => m.primary) ?? metrics[0];
	const primaryMetricId =
		mode === "autoresearch" ? objectiveMetricId ?? primary?.metricId ?? null : primary?.metricId ?? null;

	let bestArmId: string | null = null;
	if (mode === "ab" && primaryMetricId) {
		bestArmId = comparisons.find((c) => c.metricId === primaryMetricId)?.winnerArmId ?? null;
	}

	return {
		mode,
		totalRuns: runs.length,
		settledRuns,
		failedRuns,
		bestArmId,
		bestObjective: mode === "autoresearch" ? bestObjective(series) : null,
		actualCostUsd,
		primaryMetricId,
	};
}

/**
 * Pure projection of the results registry into a ReportModel. Registry objects
 * in, ReportModel out — no store access, no clock, no randomness. The report
 * route and the panel both pass the same inputs and get the same model.
 */
export function buildReportModel(input: {
	def?: ExperimentDef;
	runs: RunRecord[];
	ledger?: LedgerEntry[];
	dashboard?: DashboardSpec | null;
	metrics?: MetricSelection[];
	stop?: StopAnnotation | null;
}): ReportModel {
	const runs = input.runs ?? [];
	const ledger = input.ledger ?? [];
	const mode: ExperimentMode = input.def?.mode ?? (ledger.length ? "autoresearch" : "ab");
	const metrics = resolveMetrics(input.def, runs, input.metrics);
	const dashboard = resolveDashboard(input.dashboard, mode);

	let aggregates: ArmAggregate[] = [];
	let comparisons: MetricComparison[] = [];
	let series: ObjectivePoint[] = [];
	let stop: StopAnnotation | null = input.stop ?? null;

	if (mode === "ab") {
		aggregates = aggregateAB(input.def, runs, metrics);
		comparisons = compareAll(aggregates, metrics);
	} else {
		const objectiveMetricId = input.def?.objective?.metricId ?? metrics.find((m) => m.primary)?.metricId;
		if (objectiveMetricId) {
			const direction = input.def?.objective?.direction ?? metricDirection(objectiveMetricId, metrics.find((m) => m.metricId === objectiveMetricId));
			series = buildObjectiveSeries(runs, { metricId: objectiveMetricId, direction, target: input.def?.objective?.target });
		}
		// Annotate a stop if not supplied: derive a plateau annotation from the ledger.
		if (!stop) {
			const cost = cumulativeCost(runs);
			const ledgerStop = stopFromLedger(ledger, input.def?.stop);
			stop = ledgerStop.stopped ? ledgerStop : { stopped: false, reason: "", iteration: undefined };
			// Cost cap (deterministic, from the registry) overrides if exceeded.
			if (input.def?.caps?.maxCostUsd !== undefined && cost >= input.def.caps.maxCostUsd) {
				stop = { stopped: true, reason: `budget: cost >= ${input.def.caps.maxCostUsd}`, iteration: series.length };
			}
		}
	}

	const summary = buildSummary({
		mode,
		runs,
		comparisons,
		series,
		metrics,
		objectiveMetricId: input.def?.objective?.metricId,
	});

	return {
		experimentId: input.def?.experimentId ?? runs[0]?.experimentId ?? "",
		title: input.def?.title ?? "Experiment",
		mode,
		metrics,
		dashboard,
		runs,
		aggregates,
		comparisons,
		series,
		ledger,
		stop: stop && stop.stopped ? stop : null,
		summary,
	};
}

/** Render one widget spec through the shared registry; unknown types degrade gracefully. */
export function renderWidget(model: ReportModel, spec: WidgetSpec): string {
	const renderer = getWidget(spec.type);
	if (!renderer) {
		return card(spec.title ?? spec.type, emptyNote(`Unknown widget type: ${spec.type}`));
	}
	try {
		return renderer.render({ model, spec });
	} catch (err) {
		return card(spec.title ?? spec.type, emptyNote(`Widget render error: ${(err as Error)?.message ?? err}`));
	}
}

/**
 * Assemble the full self-contained HTML document: iterate the resolved
 * DashboardSpec, render each WidgetSpec through the registry, and wrap them in a
 * theme-token shell. Standalone-openable; a future CLI emits this to a file.
 */
export function renderReportHtml(model: ReportModel): string {
	const widgets = model.dashboard.widgets.map((spec) => renderWidget(model, spec)).join("\n");
	const header =
		`<header style="margin:0 0 16px 0;">` +
		`<h1 style="font-size:18px;font-weight:700;color:var(--foreground);margin:0;">${escapeHtml(model.title)}</h1>` +
		`<div style="font-size:12px;color:var(--muted-foreground);">${escapeHtml(model.mode)} · ${escapeHtml(model.experimentId)}</div>` +
		`</header>`;
	const body =
		`<div class="er-report" style="background:var(--background);color:var(--foreground);padding:16px;` +
		`font-family:system-ui,-apple-system,sans-serif;max-width:980px;margin:0 auto;">${header}${widgets}</div>`;
	return (
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>${escapeHtml(model.title)}</title></head>` +
		`<body style="margin:0;background:var(--background);">${body}</body></html>`
	);
}
