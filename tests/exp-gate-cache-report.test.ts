import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideRecommendation, formatMarkdownSummary, summarizeArmRecords } from "../scripts/exp-gate-cache-report.mjs";

describe("EXP-001 gate-cache report metrics", () => {
	it("summarizes paired arm metrics and recommends content only when preregistered thresholds pass", () => {
		const records = [
			{
				scenarioId: "a",
				arm: "sha",
				cacheableSteps: 2,
				cacheHits: 0,
				hitKeyKinds: { sha: 0, content: 0 },
				falseHitRiskProxy: 0,
				estimatedWallClockMs: 100_000,
				decisionWallClockMs: 1,
			},
			{
				scenarioId: "a",
				arm: "content",
				cacheableSteps: 2,
				cacheHits: 1,
				hitKeyKinds: { sha: 0, content: 1 },
				falseHitRiskProxy: 0,
				estimatedWallClockMs: 50_000,
				decisionWallClockMs: 2,
			},
			{
				scenarioId: "b",
				arm: "sha",
				cacheableSteps: 2,
				cacheHits: 0,
				hitKeyKinds: { sha: 0, content: 0 },
				falseHitRiskProxy: 0,
				estimatedWallClockMs: 100_000,
				decisionWallClockMs: 1,
			},
			{
				scenarioId: "b",
				arm: "content",
				cacheableSteps: 2,
				cacheHits: 2,
				hitKeyKinds: { sha: 0, content: 2 },
				falseHitRiskProxy: 0,
				estimatedWallClockMs: 0,
				decisionWallClockMs: 2,
			},
		];

		const summary = summarizeArmRecords(records);

		assert.equal(summary.arms.sha.cacheHitRate, 0);
		assert.equal(summary.arms.content.cacheHitRate, 0.75);
		assert.equal(summary.effects.cacheHitRateDeltaPctPoints, 75);
		assert.equal(summary.effects.totalEstimatedWallClockSavingsMs, 150_000);
		assert.equal(summary.effects.medianEstimatedWallClockReductionPct, 0.75);
		assert.equal(summary.recommendation, "recommend-content-for-next-lane");
		assert.match(formatMarkdownSummary(summary), /Recommendation: `recommend-content-for-next-lane`/);
	});

	it("keeps sha when any arm reports a false-hit risk proxy", () => {
		const summary = summarizeArmRecords([
			{
				scenarioId: "a",
				arm: "sha",
				cacheableSteps: 1,
				cacheHits: 0,
				hitKeyKinds: { sha: 0, content: 0 },
				falseHitRiskProxy: 0,
				estimatedWallClockMs: 10_000,
				decisionWallClockMs: 1,
			},
			{
				scenarioId: "a",
				arm: "content",
				cacheableSteps: 1,
				cacheHits: 1,
				hitKeyKinds: { sha: 0, content: 1 },
				falseHitRiskProxy: 1,
				estimatedWallClockMs: 0,
				decisionWallClockMs: 1,
			},
		]);

		assert.equal(decideRecommendation(summary), "keep-sha");
		assert.equal(summary.recommendation, "keep-sha");
	});
});
