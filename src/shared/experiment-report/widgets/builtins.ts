// Built-in widget renderers — the canonical core set (the seams, not a catalog).
// Canonical type ids (docs/design/experiment-runner-reporting.md §6.2):
//   comparison-table, score-bars, objective-curve, ledger-table,
//   summary-cards, raw-drilldown
// Each renderer is pure and emits theme-token-only HTML. Registered at module
// load via registerBuiltinWidgets(); index.ts calls it once.

import type { MetricComparison, ReportModel, WidgetSpec } from "../types.js";
import { registerWidget, type WidgetRenderer } from "./registry.js";
import {
	card,
	chartColor,
	deltaColor,
	emptyNote,
	escapeHtml,
	fmtDelta,
	fmtPct,
	fmtValue,
} from "./theme.js";

/** Metric ids the spec wants, else all comparison metrics in the model. */
function boundMetricIds(model: ReportModel, spec: WidgetSpec): string[] {
	if (spec.bind?.metricIds?.length) return spec.bind.metricIds;
	return model.comparisons.map((c) => c.metricId);
}

function comparisonsFor(model: ReportModel, ids: string[]): MetricComparison[] {
	return model.comparisons.filter((c) => ids.includes(c.metricId));
}

const comparisonTable: WidgetRenderer = {
	type: "comparison-table",
	descriptor: { label: "Comparison table", modes: ["ab"], description: "Arms × metrics grid with winner highlight + deltas" },
	render({ model, spec }) {
		const comps = comparisonsFor(model, boundMetricIds(model, spec));
		if (!comps.length) return card(spec.title ?? "Comparison", emptyNote());
		const armIds = comps[0].arms.map((a) => a.armId);
		const head =
			`<tr><th style="text-align:left;padding:4px 8px;color:var(--muted-foreground);border-bottom:1px solid var(--border);">Metric</th>` +
			armIds
				.map(
					(a) =>
						`<th data-testid="experiment-runner-comparison-arm" data-arm="${escapeHtml(a)}" style="text-align:right;padding:4px 8px;color:var(--muted-foreground);border-bottom:1px solid var(--border);">${escapeHtml(a)}</th>`,
				)
				.join("") +
			`</tr>`;
		const rows = comps
			.map((c) => {
				const cells = armIds
					.map((armId) => {
						const arm = c.arms.find((a) => a.armId === armId);
						const val = fmtValue(arm?.value ?? null);
						const win = arm?.isWinner
							? `font-weight:700;color:var(--positive);`
							: `color:var(--foreground);`;
						const delta =
							arm && arm.delta !== null && arm.armId !== c.baselineArmId
								? `<span style="color:${deltaColor(arm.delta, c.direction)};font-size:11px;"> (${escapeHtml(fmtDelta(arm.delta))}${arm.deltaPct !== null ? ", " + escapeHtml(fmtPct(arm.deltaPct)) : ""})</span>`
								: "";
						return `<td style="text-align:right;padding:4px 8px;${win}border-bottom:1px solid var(--border);">${escapeHtml(val)}${delta}</td>`;
					})
					.join("");
				return `<tr><td style="padding:4px 8px;color:var(--foreground);border-bottom:1px solid var(--border);">${escapeHtml(c.metricId)} <span style="color:var(--muted-foreground);font-size:11px;">(${escapeHtml(c.direction)})</span></td>${cells}</tr>`;
			})
			.join("");
		return card(
			spec.title ?? "Comparison",
			`<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead>${head}</thead><tbody>${rows}</tbody></table>`,
		);
	},
};

const scoreBars: WidgetRenderer = {
	type: "score-bars",
	descriptor: { label: "Score bars", modes: ["ab"], description: "Per-metric horizontal bars across arms" },
	render({ model, spec }) {
		const comps = comparisonsFor(model, boundMetricIds(model, spec));
		if (!comps.length) return card(spec.title ?? "Scores", emptyNote());
		const blocks = comps
			.map((c) => {
				const values = c.arms.map((a) => (a.value === null ? 0 : Math.abs(a.value)));
				const scaleMax = Math.max(1e-9, ...values);
				const bars = c.arms
					.map((a, i) => {
						const v = a.value === null ? 0 : Math.abs(a.value);
						const pct = Math.round((v / scaleMax) * 100);
						const color = a.isWinner ? "var(--positive)" : chartColor(i);
						return (
							`<div style="display:flex;align-items:center;gap:8px;margin:2px 0;font-size:12px;">` +
							`<span style="width:96px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.armId)}</span>` +
							`<span style="flex:1;background:color-mix(in oklch, var(--border) 60%, transparent);border-radius:4px;height:12px;position:relative;">` +
							`<span style="display:block;height:100%;width:${pct}%;background:${color};border-radius:4px;"></span></span>` +
							`<span style="width:72px;text-align:right;color:var(--foreground);">${escapeHtml(fmtValue(a.value))}</span></div>`
						);
					})
					.join("");
				return `<div style="margin-bottom:10px;"><div style="font-size:12px;color:var(--muted-foreground);margin-bottom:2px;">${escapeHtml(c.metricId)}</div>${bars}</div>`;
			})
			.join("");
		return card(spec.title ?? "Scores", blocks);
	},
};

const objectiveCurve: WidgetRenderer = {
	type: "objective-curve",
	descriptor: { label: "Objective curve", modes: ["autoresearch"], description: "Best-objective-vs-iteration with accept markers + stop point" },
	render({ model, spec }) {
		const series = model.series;
		if (!series.length) return card(spec.title ?? "Objective", emptyNote());
		const rows = series
			.map((p) => {
				const marker = p.accepted ? "●" : "○";
				const markColor = p.accepted ? "var(--positive)" : "var(--muted-foreground)";
				const verifiedNote = p.verified ? "" : ` <span style="color:var(--negative);">(unverified)</span>`;
				return (
					`<div style="display:flex;gap:8px;font-size:12px;padding:2px 0;color:var(--foreground);">` +
					`<span style="color:${markColor};">${marker}</span>` +
					`<span style="width:48px;color:var(--muted-foreground);">#${p.iteration}</span>` +
					`<span style="width:96px;">obj ${escapeHtml(fmtValue(p.objective))}</span>` +
					`<span style="color:var(--chart-1);">best ${escapeHtml(fmtValue(p.bestSoFar))}</span>${verifiedNote}</div>`
				);
			})
			.join("");
		const stop = model.stop?.stopped
			? `<div style="margin-top:8px;color:var(--warning);font-size:12px;">Stopped: ${escapeHtml(model.stop.reason)}</div>`
			: "";
		return card(spec.title ?? "Objective", rows + stop);
	},
};

const ledgerTable: WidgetRenderer = {
	type: "ledger-table",
	descriptor: { label: "Ledger", modes: ["autoresearch"], description: "Iteration / candidate / objective / accepted" },
	render({ model, spec }) {
		if (!model.ledger.length) return card(spec.title ?? "Ledger", emptyNote());
		const head =
			`<tr>${["#", "objective", "decision", "best", "reason"]
				.map((h) => `<th style="text-align:left;padding:4px 8px;color:var(--muted-foreground);border-bottom:1px solid var(--border);">${escapeHtml(h)}</th>`)
				.join("")}</tr>`;
		const rows = model.ledger
			.map((e) => {
				const color = e.decision === "accepted" ? "var(--positive)" : "var(--negative)";
				return (
					`<tr style="font-size:12px;">` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);">${e.iteration}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);">${escapeHtml(fmtValue(e.objective))}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);color:${color};">${escapeHtml(e.decision)}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);">${escapeHtml(fmtValue(e.bestObjectiveAfter))}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--muted-foreground);">${escapeHtml(e.reason)}</td></tr>`
				);
			})
			.join("");
		return card(
			spec.title ?? "Ledger",
			`<table style="width:100%;border-collapse:collapse;"><thead>${head}</thead><tbody>${rows}</tbody></table>`,
		);
	},
};

const summaryCards: WidgetRenderer = {
	type: "summary-cards",
	descriptor: { label: "Summary cards", modes: ["ab", "autoresearch"], description: "Headline numbers for either mode" },
	render({ model, spec }) {
		const s = model.summary;
		const cells: Array<[string, string]> = [
			["Mode", s.mode],
			["Runs", `${s.settledRuns}/${s.totalRuns}`],
			["Failed", String(s.failedRuns)],
		];
		if (s.mode === "ab") cells.push(["Best arm", s.bestArmId ?? "—"]);
		else cells.push(["Best objective", fmtValue(s.bestObjective)]);
		cells.push(["Cost (USD)", s.actualCostUsd === null ? "—" : fmtValue(s.actualCostUsd)]);
		const body =
			`<div style="display:flex;flex-wrap:wrap;gap:8px;">` +
			cells
				.map(
					([k, v]) =>
						`<div style="flex:1;min-width:96px;background:color-mix(in oklch, var(--card) 80%, var(--background));border:1px solid var(--border);border-radius:6px;padding:8px;">` +
						`<div style="font-size:11px;color:var(--muted-foreground);">${escapeHtml(k)}</div>` +
						`<div style="font-size:16px;font-weight:600;color:var(--foreground);">${escapeHtml(v)}</div></div>`,
				)
				.join("") +
			`</div>`;
		return card(spec.title ?? "Summary", body);
	},
};

const rawDrilldown: WidgetRenderer = {
	type: "raw-drilldown",
	descriptor: { label: "Raw drilldown", modes: ["ab", "autoresearch"], description: "Underlying rawOutcome data per run" },
	render({ model, spec }) {
		const armFilter = spec.bind?.armIds;
		const runs = model.runs.filter((r) => !armFilter?.length || armFilter.includes(r.armId));
		if (!runs.length) return card(spec.title ?? "Raw outcomes", emptyNote());
		const rows = runs
			.map((r) => {
				const raw = r.rawOutcome ?? {};
				const summary = [
					raw.costUsd !== undefined ? `cost ${fmtValue(raw.costUsd)}` : null,
					raw.taskCounts ? `tasks ${raw.taskCounts.complete}/${raw.taskCounts.total}` : null,
					r.completionBar ? `bar ${r.completionBar}` : null,
				]
					.filter(Boolean)
					.join(" · ");
				return (
					`<tr style="font-size:12px;">` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--foreground);">${escapeHtml(r.runId)}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--muted-foreground);">${escapeHtml(r.armId)}</td>` +
					`<td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--muted-foreground);">${escapeHtml(summary)}</td></tr>`
				);
			})
			.join("");
		return card(
			spec.title ?? "Raw outcomes",
			`<table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table>`,
		);
	},
};

/** All built-in renderers in canonical order. */
export const BUILTIN_WIDGETS: WidgetRenderer[] = [
	comparisonTable,
	scoreBars,
	objectiveCurve,
	ledgerTable,
	summaryCards,
	rawDrilldown,
];

/** Canonical built-in widget type ids (for tests/registry introspection). */
export const BUILTIN_WIDGET_TYPES = BUILTIN_WIDGETS.map((w) => w.type);

let registered = false;

/** Register all built-in widgets (idempotent). Called once by index.ts. */
export function registerBuiltinWidgets(): void {
	if (registered) return;
	for (const w of BUILTIN_WIDGETS) registerWidget(w);
	registered = true;
}
