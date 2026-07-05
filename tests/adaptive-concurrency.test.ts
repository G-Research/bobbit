/**
 * Pinning test for the loadavg-scaled unit-phase concurrency calculation
 * (scripts/lib/adaptive-concurrency.mjs, wired into scripts/run-unit.mjs).
 *
 * Exercises the pure `computeAdaptiveConcurrency` seam directly so the
 * formula is verified without spawning the full unit phase or depending on
 * the actual machine's live load average.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdaptiveConcurrency } from "../scripts/lib/adaptive-concurrency.mjs";

test("idle box (load1 = 0) never scales down", () => {
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 18, load1: 0 }), 6);
	assert.equal(computeAdaptiveConcurrency({ base: 1, cores: 4, load1: 0 }), 1);
});

test("load1 == cores halves the base concurrency", () => {
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 18, load1: 18 }), 3);
	assert.equal(computeAdaptiveConcurrency({ base: 4, cores: 8, load1: 8 }), 2);
});

test("heavy contention floors at 2, never serializes to 1", () => {
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 18, load1: 1000 }), 2);
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 4, load1: 40 }), 2);
});

test("a base below 2 (single-core-ish box) is never pushed above its own base", () => {
	assert.equal(computeAdaptiveConcurrency({ base: 1, cores: 4, load1: 1000 }), 1);
});

test("result is always a whole number between the lower bound and base, inclusive", () => {
	for (const load1 of [0, 0.5, 1, 5, 17.9, 18, 39.6, 100, 1000]) {
		const result = computeAdaptiveConcurrency({ base: 6, cores: 18, load1 });
		assert.ok(Number.isInteger(result), `expected an integer for load1=${load1}, got ${result}`);
		assert.ok(result >= 2 && result <= 6, `expected 2 <= result <= 6 for load1=${load1}, got ${result}`);
	}
});

test("monotonically non-increasing in load1", () => {
	let prev = computeAdaptiveConcurrency({ base: 6, cores: 18, load1: 0 });
	for (const load1 of [1, 5, 10, 18, 30, 50, 100]) {
		const result = computeAdaptiveConcurrency({ base: 6, cores: 18, load1 });
		assert.ok(result <= prev, `expected concurrency to not increase as load1 grows (load1=${load1})`);
		prev = result;
	}
});

test("rejects non-positive or non-finite base/cores", () => {
	assert.throws(() => computeAdaptiveConcurrency({ base: 0, cores: 8, load1: 0 }), RangeError);
	assert.throws(() => computeAdaptiveConcurrency({ base: 6, cores: 0, load1: 0 }), RangeError);
	assert.throws(() => computeAdaptiveConcurrency({ base: NaN, cores: 8, load1: 0 }), RangeError);
	assert.throws(() => computeAdaptiveConcurrency({ base: 6, cores: Infinity, load1: 0 }), RangeError);
});

test("treats a negative or non-finite load1 as 0 (no scale-down)", () => {
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 18, load1: -5 }), 6);
	assert.equal(computeAdaptiveConcurrency({ base: 6, cores: 18, load1: NaN }), 6);
});
