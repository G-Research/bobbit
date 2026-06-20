// Aggregation correctness — pins median / spread / same-completion-bar filtering
// and direction-aware winner/delta (docs/design/experiment-runner-reporting.md §9.1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	aggregateAB,
	aggregateArm,
	compareMetric,
	median,
	mean,
	percentile,
	reduceValues,
	spreadOf,
	filterByBar,
	metricDirection,
} from "../src/shared/experiment-report/aggregate.ts";
import type {
	ExperimentDef,
	MetricSelection,
	RunRecord,
} from "../src/shared/experiment-report/types.ts";
// The pack's metric registry — proves a code-registered custom metric's direction
// reaches the shared comparison (resolveSelection must surface it as directionOverride).
import { registerMetric, resolveSelection } from "../market-packs/experiment-runner/lib/metrics.mjs";

function run(partial: Partial<RunRecord> & Pick<RunRecord, "armId" | "runId">): RunRecord {
	return {
		experimentId: "exp1",
		runKey: partial.runId,
		status: "collected",
		completionBar: "passed",
		metrics: {},
		...partial,
	};
}

describe("aggregate: primitive reducers", () => {
	it("median handles odd/even/empty", () => {
		assert.equal(median([3, 1, 2]), 2);
		assert.equal(median([1, 2, 3, 4]), 2.5);
		assert.equal(median([]), null);
	});

	it("mean and percentile interpolate", () => {
		assert.equal(mean([2, 4]), 3);
		assert.equal(percentile([], 90), null);
		assert.equal(percentile([10], 90), 10);
		assert.equal(percentile([0, 10], 50), 5);
		assert.equal(percentile([1, 2, 3, 4], 75), 3.25);
	});

	it("reduceValues respects aggregation and count", () => {
		assert.equal(reduceValues([1, 2, 3], "median"), 2);
		assert.equal(reduceValues([1, 2, 3], "mean"), 2);
		assert.equal(reduceValues([1, 2, 3], "min"), 1);
		assert.equal(reduceValues([1, 2, 3], "max"), 3);
		assert.equal(reduceValues([], "count"), 0);
		assert.equal(reduceValues([], "median"), null);
	});

	it("spreadOf reports min/max/iqr", () => {
		const s = spreadOf([1, 2, 3, 4]);
		assert.ok(s);
		assert.equal(s?.min, 1);
		assert.equal(s?.max, 4);
		assert.equal(s?.iqr, (s?.p75 as number) - (s?.p25 as number));
		assert.equal(spreadOf([]), null);
	});
});

describe("aggregate: same-completion-bar filtering", () => {
	it("keeps only passed runs by default and counts droppedN", () => {
		const runs: RunRecord[] = [
			run({ runId: "r1", armId: "A", completionBar: "passed", metrics: { m: 10 } }),
			run({ runId: "r2", armId: "A", completionBar: "failed", metrics: { m: 999 } }),
			run({ runId: "r3", armId: "A", completionBar: "incomplete", metrics: { m: 999 } }),
			run({ runId: "r4", armId: "A", completionBar: "passed", metrics: { m: 20 } }),
		];
		const sel: MetricSelection = { metricId: "m" };
		const agg = aggregateArm(runs, "A", sel);
		assert.equal(agg.value, 15); // median(10,20)
		assert.equal(agg.n, 2);
		assert.equal(agg.droppedN, 2);
	});

	it("can target a non-passed bar", () => {
		const runs = [
			run({ runId: "r1", armId: "A", completionBar: "failed", metrics: { m: 5 } }),
			run({ runId: "r2", armId: "A", completionBar: "passed", metrics: { m: 50 } }),
		];
		const agg = aggregateArm(runs, "A", { metricId: "m", bar: "failed" });
		assert.equal(agg.value, 5);
		assert.equal(agg.n, 1);
		assert.equal(agg.droppedN, 1);
	});

	it("filterByBar default is passed", () => {
		const runs = [
			run({ runId: "r1", armId: "A", completionBar: "passed" }),
			run({ runId: "r2", armId: "A", completionBar: "failed" }),
		];
		assert.equal(filterByBar(runs).length, 1);
	});

	it("bar 'all' disables same-bar filtering (keeps every run)", () => {
		const runs = [
			run({ runId: "r1", armId: "A", completionBar: "passed", metrics: { m: 10 } }),
			run({ runId: "r2", armId: "A", completionBar: "failed", metrics: { m: 20 } }),
			run({ runId: "r3", armId: "A", completionBar: "incomplete", metrics: { m: 30 } }),
		];
		// filterByBar keeps all rows under 'all'.
		assert.equal(filterByBar(runs, "all").length, 3);
		// aggregateArm under 'all' aggregates across every bar (median 10,20,30 = 20),
		// with nothing dropped — vs the default 'passed' which keeps only r1.
		const all = aggregateArm(runs, "A", { metricId: "m", bar: "all" });
		assert.equal(all.value, 20);
		assert.equal(all.n, 3);
		assert.equal(all.droppedN, 0);
		const passed = aggregateArm(runs, "A", { metricId: "m" });
		assert.equal(passed.value, 10);
		assert.equal(passed.n, 1);
		assert.equal(passed.droppedN, 2);
	});
});

describe("aggregate: edge cases", () => {
	it("all-null metric yields null, not 0", () => {
		const runs = [
			run({ runId: "r1", armId: "A", metrics: { m: null } }),
			run({ runId: "r2", armId: "A", metrics: {} }),
		];
		const agg = aggregateArm(runs, "A", { metricId: "m" });
		assert.equal(agg.value, null);
		assert.equal(agg.n, 0);
		assert.equal(agg.spread, null);
	});

	it("single repeat returns that value", () => {
		const runs = [run({ runId: "r1", armId: "A", metrics: { m: 42 } })];
		assert.equal(aggregateArm(runs, "A", { metricId: "m" }).value, 42);
	});
});

describe("aggregate: direction-aware comparison", () => {
	const def: ExperimentDef = {
		experimentId: "exp1",
		title: "t",
		mode: "ab",
		parentGoalId: "g0",
		runnable: { kind: "agent" },
		variants: [
			{ armId: "A", label: "A", metadata: {} },
			{ armId: "B", label: "B", metadata: {} },
		],
		repeats: 2,
	};

	it("max metric: higher wins; delta vs baseline", () => {
		const runs = [
			run({ runId: "a1", armId: "A", metrics: { score: 10 } }),
			run({ runId: "a2", armId: "A", metrics: { score: 20 } }), // median 15
			run({ runId: "b1", armId: "B", metrics: { score: 30 } }),
			run({ runId: "b2", armId: "B", metrics: { score: 50 } }), // median 40
		];
		const sel: MetricSelection = { metricId: "score", directionOverride: "max" };
		const aggs = aggregateAB(def, runs, [sel]);
		const cmp = compareMetric(aggs, sel);
		assert.equal(cmp.winnerArmId, "B");
		assert.equal(cmp.baselineArmId, "A");
		const armB = cmp.arms.find((a) => a.armId === "B");
		assert.equal(armB?.delta, 25); // 40 - 15
		assert.equal(armB?.isWinner, true);
	});

	it("min metric (built-in cost.totalUsd): lower wins", () => {
		const runs = [
			run({ runId: "a1", armId: "A", metrics: { "cost.totalUsd": 9 } }),
			run({ runId: "b1", armId: "B", metrics: { "cost.totalUsd": 4 } }),
		];
		const sel: MetricSelection = { metricId: "cost.totalUsd" };
		assert.equal(metricDirection("cost.totalUsd"), "min");
		const aggs = aggregateAB(def, runs, [sel]);
		const cmp = compareMetric(aggs, sel);
		assert.equal(cmp.winnerArmId, "B");
	});

	it("ties: first-seen arm holds the winner slot", () => {
		const runs = [
			run({ runId: "a1", armId: "A", metrics: { m: 5 } }),
			run({ runId: "b1", armId: "B", metrics: { m: 5 } }),
		];
		const sel: MetricSelection = { metricId: "m", directionOverride: "max" };
		const aggs = aggregateAB(def, runs, [sel]);
		assert.equal(compareMetric(aggs, sel).winnerArmId, "A");
	});

	it("custom (code-registered) min-metric is compared by min via resolveSelection", () => {
		// A custom metric registered direction:'min' but absent from the built-in table.
		// metricDirection reads ONLY directionOverride or the built-in table, so unless
		// resolveSelection threads the registered direction into directionOverride, the
		// comparison defaults to 'max' and the WRONG (higher) arm wins.
		registerMetric({ id: "custom.latencyMs", label: "Latency", direction: "min", extract: (raw: any) => raw.latencyMs ?? null });
		const [resolved] = resolveSelection([{ metricId: "custom.latencyMs" }]) as MetricSelection[];
		assert.equal(resolved.directionOverride, "min");
		assert.equal(metricDirection("custom.latencyMs", resolved), "min");

		const runs = [
			run({ runId: "a1", armId: "A", metrics: { "custom.latencyMs": 200 } }),
			run({ runId: "b1", armId: "B", metrics: { "custom.latencyMs": 50 } }),
		];
		const aggs = aggregateAB(def, runs, [resolved]);
		// min wins → the lower-latency arm B, not the higher-value arm A.
		assert.equal(compareMetric(aggs, resolved).winnerArmId, "B");
	});
});
