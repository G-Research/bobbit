// Spec-driven rendering + extensibility (docs/design/experiment-runner-reporting.md
// §9.3): render each built-in widget, assert bound values appear and only theme
// tokens are used; prove a custom metric and a custom widget work (registration,
// not refactor).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BUILTIN_WIDGET_TYPES,
	buildReportModel,
	getWidget,
	listWidgets,
	registerWidget,
	renderReportHtml,
	renderWidget,
	unregisterWidget,
} from "../src/shared/experiment-report/index.ts";
import type {
	DashboardSpec,
	ExperimentDef,
	LedgerEntry,
	RunRecord,
} from "../src/shared/experiment-report/types.ts";

// No hardcoded colours: no #rrggbb, no rgb(/rgba(, no :root, no prefers-color-scheme.
function assertThemeTokensOnly(html: string): void {
	assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/, "must not contain hex colours");
	assert.doesNotMatch(html, /\brgba?\(/, "must not contain rgb()/rgba()");
	assert.doesNotMatch(html, /:root/, "must not define a :root palette");
	assert.doesNotMatch(html, /prefers-color-scheme/, "must not branch on prefers-color-scheme");
}

function abRun(armId: string, runId: string, value: number, bar: RunRecord["completionBar"] = "passed"): RunRecord {
	return {
		experimentId: "exp1",
		runId,
		armId,
		runKey: runId,
		status: "collected",
		completionBar: bar,
		metrics: { "gates.passRate": value },
		cost: { costUsd: 0.5 },
	};
}

const AB_DEF: ExperimentDef = {
	experimentId: "exp1",
	title: "My AB",
	mode: "ab",
	parentGoalId: "g0",
	runnable: { kind: "agent" },
	variants: [
		{ armId: "A", label: "Arm A", metadata: {} },
		{ armId: "B", label: "Arm B", metadata: {} },
	],
	repeats: 2,
};

describe("widgets: registry built-ins", () => {
	it("registers the six canonical widget types", () => {
		const types = listWidgets().map((w) => w.type);
		for (const t of ["comparison-table", "score-bars", "objective-curve", "ledger-table", "summary-cards", "raw-drilldown"]) {
			assert.ok(types.includes(t), `missing widget ${t}`);
		}
		assert.deepEqual(
			[...BUILTIN_WIDGET_TYPES].sort(),
			["comparison-table", "ledger-table", "objective-curve", "raw-drilldown", "score-bars", "summary-cards"],
		);
	});
});

describe("widgets: A/B rendering shows bound values + theme tokens only", () => {
	const model = buildReportModel({
		def: AB_DEF,
		runs: [abRun("A", "a1", 0.4), abRun("A", "a2", 0.6), abRun("B", "b1", 0.8), abRun("B", "b2", 0.9)],
		metrics: [{ metricId: "gates.passRate", primary: true }],
	});

	it("comparison-table shows arm ids and winner", () => {
		const html = renderWidget(model, { id: "c", type: "comparison-table", bind: {} });
		assert.match(html, />A<\/th>/);
		assert.match(html, />B<\/th>/);
		assert.match(html, /gates\.passRate/);
		assert.match(html, /0\.85/); // median of B (0.8,0.9)
		assertThemeTokensOnly(html);
	});

	it("score-bars renders bars per arm", () => {
		const html = renderWidget(model, { id: "s", type: "score-bars", bind: {} });
		assert.match(html, /var\(--chart-1\)|var\(--positive\)/);
		assertThemeTokensOnly(html);
	});

	it("summary-cards shows best arm B", () => {
		const html = renderWidget(model, { id: "sum", type: "summary-cards", bind: {} });
		assert.match(html, /Best arm/);
		assert.match(html, />B</);
		assertThemeTokensOnly(html);
	});
});

describe("widgets: autoresearch rendering", () => {
	const AR_DEF: ExperimentDef = {
		experimentId: "exp2",
		title: "My AR",
		mode: "autoresearch",
		parentGoalId: "g0",
		runnable: { kind: "agent" },
		objective: { metricId: "objective.value", direction: "max" },
		caps: { maxIterations: 5 },
		stop: { plateauK: 2 },
	};
	const runs: RunRecord[] = [0, 1, 2].map((i) => ({
		experimentId: "exp2",
		runId: `r${i}`,
		armId: `cand${i}`,
		runKey: `r${i}`,
		status: "collected",
		iteration: i,
		verified: true,
		completionBar: "passed",
		metrics: { "objective.value": 10 + i * 5 },
	}));
	const ledger: LedgerEntry[] = runs.map((r, i) => ({
		iteration: i,
		runId: r.runId,
		candidate: {},
		objective: 10 + i * 5,
		completionBar: "passed",
		decision: "accepted",
		bestObjectiveAfter: 10 + i * 5,
		reason: "improved & passed",
	}));

	const model = buildReportModel({ def: AR_DEF, runs, ledger });

	it("objective-curve shows best-so-far progression", () => {
		const html = renderWidget(model, { id: "o", type: "objective-curve", bind: { objective: true } });
		assert.match(html, /best 20/);
		assertThemeTokensOnly(html);
	});

	it("ledger-table lists iterations + decisions", () => {
		const html = renderWidget(model, { id: "l", type: "ledger-table", bind: {} });
		assert.match(html, /accepted/);
		assertThemeTokensOnly(html);
	});
});

describe("widgets: extensibility", () => {
	it("renders a custom metric id with no code change", () => {
		const model = buildReportModel({
			def: { ...AB_DEF, experimentId: "expX" },
			runs: [
				{ experimentId: "expX", runId: "a1", armId: "A", runKey: "a1", status: "collected", completionBar: "passed", metrics: { "user.bleu": 0.42 } },
				{ experimentId: "expX", runId: "b1", armId: "B", runKey: "b1", status: "collected", completionBar: "passed", metrics: { "user.bleu": 0.55 } },
			],
			metrics: [{ metricId: "user.bleu", primary: true }],
		});
		const html = renderWidget(model, { id: "c", type: "comparison-table", bind: { metricIds: ["user.bleu"] } });
		assert.match(html, /user\.bleu/);
		assert.match(html, /0\.55/);
	});

	it("a newly-registered widget type is resolved and used", () => {
		registerWidget({
			type: "custom-banner",
			descriptor: { label: "Custom banner", modes: ["ab"] },
			render: ({ model }) => `<div data-custom="1">runs=${model.runs.length}</div>`,
		});
		try {
			assert.ok(getWidget("custom-banner"));
			const model = buildReportModel({ def: AB_DEF, runs: [abRun("A", "a1", 0.5)] });
			const spec: DashboardSpec = { widgets: [{ id: "x", type: "custom-banner", bind: {} }] };
			const html = renderReportHtml({ ...model, dashboard: spec });
			assert.match(html, /data-custom="1"/);
			assert.match(html, /runs=1/);
		} finally {
			unregisterWidget("custom-banner");
		}
	});

	it("unknown widget type degrades gracefully", () => {
		const model = buildReportModel({ def: AB_DEF, runs: [abRun("A", "a1", 0.5)] });
		const html = renderWidget(model, { id: "z", type: "does-not-exist", bind: {} });
		assert.match(html, /Unknown widget type/);
	});
});

describe("widgets: full report document", () => {
	it("renderReportHtml produces a self-contained theme-token document", () => {
		const model = buildReportModel({
			def: AB_DEF,
			runs: [abRun("A", "a1", 0.4), abRun("B", "b1", 0.9)],
			metrics: [{ metricId: "gates.passRate", primary: true }],
		});
		const html = renderReportHtml(model);
		assert.match(html, /<!doctype html>/);
		assert.match(html, /My AB/);
		assertThemeTokensOnly(html);
	});
});
