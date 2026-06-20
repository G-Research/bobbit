// Series / accept-stop rules — pins the best-so-far curve (correctness-gated) and
// the plateau/target/budget predicates the loop AND the dashboard share
// (docs/design/experiment-runner-reporting.md §9.2). Synthetic series only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildObjectiveSeries,
	bestObjective,
	decideCandidate,
	evaluateStop,
	exceedsCaps,
	hitTarget,
	isOverBudget,
	isPlateau,
	isRunVerified,
} from "../src/shared/experiment-report/series.ts";
import type { ObjectiveSpec, RunRecord } from "../src/shared/experiment-report/types.ts";

function arRun(iteration: number, objective: number | null, opts: Partial<RunRecord> = {}): RunRecord {
	return {
		experimentId: "exp1",
		runId: `r${iteration}`,
		armId: `cand${iteration}`,
		runKey: `r${iteration}`,
		status: "collected",
		iteration,
		verified: true,
		completionBar: "passed",
		metrics: { "objective.value": objective },
		...opts,
	};
}

const OBJ: ObjectiveSpec = { metricId: "objective.value", direction: "max" };

describe("series: best-so-far curve (correctness gate)", () => {
	it("keeps only verified improving candidates", () => {
		const runs = [
			arRun(0, 10),
			arRun(1, 20),
			arRun(2, 15), // regression, not accepted
			arRun(3, 30),
		];
		const series = buildObjectiveSeries(runs, OBJ);
		assert.deepEqual(series.map((p) => p.bestSoFar), [10, 20, 20, 30]);
		assert.deepEqual(series.map((p) => p.accepted), [true, true, false, true]);
		assert.equal(bestObjective(series), 30);
	});

	it("a higher-objective but unverified run does NOT raise the best", () => {
		const runs = [
			arRun(0, 10),
			arRun(1, 99, { verified: false, completionBar: "failed" }),
			arRun(2, 12),
		];
		const series = buildObjectiveSeries(runs, OBJ);
		assert.deepEqual(series.map((p) => p.bestSoFar), [10, 10, 12]);
		assert.equal(series[1].accepted, false);
		assert.equal(series[1].verified, false);
	});

	it("min objective: lower is better", () => {
		const runs = [arRun(0, 10), arRun(1, 8), arRun(2, 9)];
		const series = buildObjectiveSeries(runs, { metricId: "objective.value", direction: "min" });
		assert.deepEqual(series.map((p) => p.bestSoFar), [10, 8, 8]);
	});
});

describe("series: isRunVerified", () => {
	it("requires passed bar and verified !== false", () => {
		assert.equal(isRunVerified(arRun(0, 1)), true);
		assert.equal(isRunVerified(arRun(0, 1, { verified: false })), false);
		assert.equal(isRunVerified(arRun(0, 1, { completionBar: "incomplete" })), false);
	});
});

describe("series: decideCandidate (deterministic accept/reject)", () => {
	it("rejects on failed correctness gate even if objective improves", () => {
		const d = decideCandidate({ objective: 100, verified: false, best: 10, direction: "max" });
		assert.equal(d.decision, "rejected");
		assert.equal(d.reason, "failed-correctness-gate");
	});

	it("accepts first verified candidate, rejects regression", () => {
		assert.equal(decideCandidate({ objective: 10, verified: true, best: null, direction: "max" }).decision, "accepted");
		assert.equal(decideCandidate({ objective: 5, verified: true, best: 10, direction: "max" }).decision, "rejected");
	});

	it("eps gates marginal improvements", () => {
		assert.equal(
			decideCandidate({ objective: 10.001, verified: true, best: 10, direction: "max", eps: 0.01 }).decision,
			"rejected",
		);
		assert.equal(
			decideCandidate({ objective: 10.5, verified: true, best: 10, direction: "max", eps: 0.01 }).decision,
			"accepted",
		);
	});
});

describe("series: stop predicates", () => {
	it("isPlateau true when no accepted improvement over last K", () => {
		const runs = [arRun(0, 10), arRun(1, 20), arRun(2, 15), arRun(3, 12)];
		const series = buildObjectiveSeries(runs, OBJ);
		assert.equal(isPlateau(series, 2), true); // last 2 not accepted
		assert.equal(isPlateau(series, 3), false); // iter1 was accepted
		assert.equal(isPlateau(series, 0), false);
	});

	it("hitTarget direction-aware", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 25)], OBJ);
		assert.equal(hitTarget(series, 20, "max"), true);
		assert.equal(hitTarget(series, 30, "max"), false);
		const minSeries = buildObjectiveSeries([arRun(0, 10), arRun(1, 5)], { metricId: "objective.value", direction: "min" });
		assert.equal(hitTarget(minSeries, 6, "min"), true);
	});

	it("exceedsCaps fires on iterations/cost/wallclock", () => {
		assert.equal(exceedsCaps({ caps: { maxIterations: 3 }, iterations: 3, cumulativeCostUsd: 0, elapsedMs: 0 }).exceeded, true);
		assert.equal(exceedsCaps({ caps: { maxCostUsd: 5 }, iterations: 0, cumulativeCostUsd: 5, elapsedMs: 0 }).exceeded, true);
		assert.equal(exceedsCaps({ caps: { maxWallClockMs: 100 }, iterations: 0, cumulativeCostUsd: 0, elapsedMs: 100 }).exceeded, true);
		assert.equal(exceedsCaps({ caps: { maxIterations: 3 }, iterations: 2, cumulativeCostUsd: 0, elapsedMs: 0 }).exceeded, false);
	});

	it("exceedsCaps enforces maxCostUsd PRE-SPAWN via projectedNextCostUsd", () => {
		// Cumulative is under the cap, but cumulative + projected next-run cost goes over → stop.
		const over = exceedsCaps({ caps: { maxCostUsd: 5 }, iterations: 0, cumulativeCostUsd: 4, elapsedMs: 0, projectedNextCostUsd: 2 });
		assert.equal(over.exceeded, true);
		assert.match(over.reason as string, /budget/);
		// Cumulative + projected exactly at the cap is NOT over (strict >).
		assert.equal(exceedsCaps({ caps: { maxCostUsd: 5 }, iterations: 0, cumulativeCostUsd: 3, elapsedMs: 0, projectedNextCostUsd: 2 }).exceeded, false);
		// No projection (default 0) ⇒ only the already-over check applies.
		assert.equal(exceedsCaps({ caps: { maxCostUsd: 5 }, iterations: 0, cumulativeCostUsd: 4, elapsedMs: 0 }).exceeded, false);
	});

	it("isOverBudget compares per-run cost", () => {
		assert.equal(isOverBudget(arRun(0, 1, { cost: { costUsd: 6 } }), 5), true);
		assert.equal(isOverBudget(arRun(0, 1, { cost: { costUsd: 4 } }), 5), false);
		assert.equal(isOverBudget(arRun(0, 1), undefined), false);
	});
});

describe("series: evaluateStop chooses the right reason at the right iteration", () => {
	it("budget cap dominates", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 20), arRun(2, 30)], OBJ);
		const stop = evaluateStop({ series, objective: OBJ, caps: { maxIterations: 3 }, cumulativeCostUsd: 0, elapsedMs: 0 });
		assert.equal(stop.stopped, true);
		assert.match(stop.reason, /iterations >= 3/);
	});

	it("target stop when reached", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 50)], OBJ);
		const stop = evaluateStop({ series, objective: OBJ, stop: { target: 40 }, cumulativeCostUsd: 0, elapsedMs: 0 });
		assert.equal(stop.stopped, true);
		assert.match(stop.reason, /target/);
	});

	it("plateau stop after K rejections", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 20), arRun(2, 15), arRun(3, 12)], OBJ);
		const stop = evaluateStop({ series, objective: OBJ, stop: { plateauK: 2 }, cumulativeCostUsd: 0, elapsedMs: 0 });
		assert.equal(stop.stopped, true);
		assert.match(stop.reason, /plateau over K=2/);
	});

	it("does not stop when no condition holds", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 20)], OBJ);
		const stop = evaluateStop({ series, objective: OBJ, caps: { maxIterations: 10 }, stop: { plateauK: 5 }, cumulativeCostUsd: 0, elapsedMs: 0 });
		assert.equal(stop.stopped, false);
	});

	it("stops PRE-SPAWN with a budget reason when cumulative+projected exceeds maxCostUsd", () => {
		const series = buildObjectiveSeries([arRun(0, 10), arRun(1, 20)], OBJ);
		// cumulative 4 is under the cap 5, but +perRunBudget(2) would overshoot → stop before spawning.
		const stop = evaluateStop({
			series,
			objective: OBJ,
			caps: { maxCostUsd: 5, maxIterations: 100 },
			stop: { plateauK: 50 },
			cumulativeCostUsd: 4,
			elapsedMs: 0,
			projectedNextCostUsd: 2,
		});
		assert.equal(stop.stopped, true);
		assert.match(stop.reason, /budget/);
		// Without the projection the same state keeps running (cumulative still under cap).
		const keepGoing = evaluateStop({
			series,
			objective: OBJ,
			caps: { maxCostUsd: 5, maxIterations: 100 },
			stop: { plateauK: 50 },
			cumulativeCostUsd: 4,
			elapsedMs: 0,
		});
		assert.equal(keepGoing.stopped, false);
	});
});
