import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveContextMeter } from "../../src/shared/context-meter.ts";

const dualLimits = { contextWindow: 400, modelCapacity: 1_000 };

describe("resolveContextMeter", () => {
	it("scales primary usage below 75% of the target against capacity", () => {
		assert.deepEqual(resolveContextMeter({ usage: 200, ...dualLimits }), {
			mode: "dual",
			target: 400,
			capacity: 1_000,
			scale: 1_000,
			percentage: 20,
			markerPct: 40,
			primaryPct: 20,
			warningPct: 0,
			negativePct: 0,
		});
	});

	it("starts the warning segment at exactly 75% of the target", () => {
		const atBoundary = resolveContextMeter({ usage: 300, ...dualLimits });
		assert.equal(atBoundary.primaryPct, 30);
		assert.equal(atBoundary.warningPct, 0);
		assert.equal(atBoundary.negativePct, 0);

		const aboveBoundary = resolveContextMeter({ usage: 350, ...dualLimits });
		assert.equal(aboveBoundary.primaryPct, 30);
		assert.equal(aboveBoundary.warningPct, 5);
		assert.equal(aboveBoundary.negativePct, 0);
	});

	it("does not start the negative segment until usage exceeds the target", () => {
		const atTarget = resolveContextMeter({ usage: 400, ...dualLimits });
		assert.equal(atTarget.percentage, 40);
		assert.equal(atTarget.primaryPct, 30);
		assert.equal(atTarget.warningPct, 10);
		assert.equal(atTarget.negativePct, 0);

		const beyondTarget = resolveContextMeter({ usage: 401, ...dualLimits });
		assert.equal(beyondTarget.negativePct, 0.1);
	});

	it("keeps numeric percentage unclamped while clamping geometry to capacity", () => {
		const nearCapacity = resolveContextMeter({ usage: 900, ...dualLimits });
		assert.equal(nearCapacity.percentage, 90);
		assert.equal(nearCapacity.primaryPct + nearCapacity.warningPct + nearCapacity.negativePct, 90);

		const beyondCapacity = resolveContextMeter({ usage: 1_200, ...dualLimits });
		assert.equal(beyondCapacity.percentage, 120);
		assert.equal(beyondCapacity.primaryPct, 30);
		assert.equal(beyondCapacity.warningPct, 10);
		assert.equal(beyondCapacity.negativePct, 60);
	});

	it("collapses equal target and capacity to one target limit", () => {
		assert.deepEqual(resolveContextMeter({
			usage: 300,
			contextWindow: 400,
			modelCapacity: 400,
		}), {
			mode: "target-only",
			target: 400,
			scale: 400,
			percentage: 75,
			primaryPct: 75,
			warningPct: 0,
			negativePct: 0,
		});
	});

	it("fails closed to the target when capacity is below it", () => {
		assert.deepEqual(resolveContextMeter({
			usage: 400,
			contextWindow: 400,
			modelCapacity: 300,
		}), {
			mode: "target-only",
			target: 400,
			scale: 400,
			percentage: 100,
			primaryPct: 75,
			warningPct: 25,
			negativePct: 0,
		});
	});

	it("leaves target-only numeric percentages above 100 unclamped", () => {
		const result = resolveContextMeter({ usage: 500, contextWindow: 400 });
		assert.equal(result.mode, "target-only");
		assert.equal(result.percentage, 125);
		assert.equal(result.primaryPct, 75);
		assert.equal(result.warningPct, 25);
		assert.equal(result.negativePct, 0);
		assert.equal(result.markerPct, undefined);
	});

	it("scales capacity-only usage without fabricating target zones", () => {
		assert.deepEqual(resolveContextMeter({ usage: 500, modelCapacity: 1_000 }), {
			mode: "capacity-only",
			capacity: 1_000,
			scale: 1_000,
			percentage: 50,
			primaryPct: 50,
			warningPct: 0,
			negativePct: 0,
		});
	});

	it("returns unknown geometry when neither limit is valid", () => {
		for (const limits of [
			{},
			{ contextWindow: 0, modelCapacity: -1 },
			{ contextWindow: Number.NaN, modelCapacity: Number.POSITIVE_INFINITY },
		]) {
			assert.deepEqual(resolveContextMeter({ usage: 100, ...limits }), {
				mode: "unknown",
				primaryPct: 0,
				warningPct: 0,
				negativePct: 0,
			});
		}
	});

	it("uses whichever single positive finite limit remains", () => {
		assert.equal(resolveContextMeter({
			usage: 50,
			contextWindow: Number.NaN,
			modelCapacity: 100,
		}).mode, "capacity-only");
		assert.equal(resolveContextMeter({
			usage: 50,
			contextWindow: 100,
			modelCapacity: Number.NaN,
		}).mode, "target-only");
	});

	it("omits usage percentage and fill for invalid usage", () => {
		for (const usage of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = resolveContextMeter({ usage, ...dualLimits });
			assert.equal(result.percentage, undefined);
			assert.equal(result.primaryPct, 0);
			assert.equal(result.warningPct, 0);
			assert.equal(result.negativePct, 0);
			assert.equal(result.markerPct, 40);
		}
	});
});
