/**
 * Unit tests for the pure `nextBackoffDelay` helper used by
 * `maybeAutoRetryTransient` to schedule provider-overload / rate-limit
 * retries.
 *
 * Contract (see docs/design + goal spec):
 *   nextBackoffDelay(attempt, {
 *     baseMs?:      number;  // default 1000
 *     maxMs?:       number;  // default Infinity
 *     jitterRatio?: number;  // default 0 (no jitter)
 *     random?:      () => number;  // default Math.random
 *   }): number
 *
 *   - `attempt` is 1-based.
 *   - Raw delay = baseMs * 2 ** (attempt - 1), capped at maxMs BEFORE jitter.
 *   - Symmetric jitter multiplier ∈ [1 - jitterRatio, 1 + jitterRatio].
 *   - Final delay clamped to maxMs so jitter never exceeds the cap.
 *
 * Runs via `npm run test:unit` (Node test runner).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nextBackoffDelay } from "../src/server/agent/session-setup.ts";

describe("nextBackoffDelay", () => {
	// ── Base sequence (no jitter) ──────────────────────────────────────

	it("produces 1s, 2s, 4s for attempts 1, 2, 3 with defaults", () => {
		assert.equal(nextBackoffDelay(1), 1000);
		assert.equal(nextBackoffDelay(2), 2000);
		assert.equal(nextBackoffDelay(3), 4000);
	});

	it("doubles each attempt without jitter (1s → 2s → 4s → 8s → 16s → 32s)", () => {
		const seq = [1, 2, 3, 4, 5, 6].map(a => nextBackoffDelay(a, { baseMs: 1000 }));
		assert.deepEqual(seq, [1000, 2000, 4000, 8000, 16000, 32000]);
	});

	it("respects a custom baseMs", () => {
		assert.equal(nextBackoffDelay(1, { baseMs: 500 }), 500);
		assert.equal(nextBackoffDelay(4, { baseMs: 500 }), 4000);
	});

	// ── Cap enforcement ────────────────────────────────────────────────

	it("caps at maxMs = 300_000 for large attempts", () => {
		// 2 ** (10 - 1) * 1000 = 512_000 → capped at 300_000
		assert.equal(nextBackoffDelay(10, { maxMs: 300_000 }), 300_000);
		assert.equal(nextBackoffDelay(20, { maxMs: 300_000 }), 300_000);
		// Even attempts that wouldn't overflow as numbers stay at the cap.
		assert.equal(nextBackoffDelay(50, { maxMs: 300_000 }), 300_000);
	});

	it("does not cap below maxMs", () => {
		assert.equal(nextBackoffDelay(1, { maxMs: 300_000 }), 1000);
		assert.equal(nextBackoffDelay(8, { maxMs: 300_000 }), 128_000);
		// Attempt 9 would be 256_000 < 300_000 → uncapped.
		assert.equal(nextBackoffDelay(9, { maxMs: 300_000 }), 256_000);
	});

	// ── Jitter with deterministic random ──────────────────────────────

	it("applies symmetric ±20% jitter with deterministic random()", () => {
		// random() == 0 → multiplier = (1 - jitterRatio) = 0.8
		assert.equal(
			nextBackoffDelay(1, { baseMs: 1000, jitterRatio: 0.2, random: () => 0 }),
			800,
		);
		// random() == 0.5 → multiplier = 1.0 (centre of band)
		assert.equal(
			nextBackoffDelay(1, { baseMs: 1000, jitterRatio: 0.2, random: () => 0.5 }),
			1000,
		);
		// random() → ~1 (just under) → multiplier ≈ 1.2
		const upper = nextBackoffDelay(1, {
			baseMs: 1000,
			jitterRatio: 0.2,
			random: () => 0.999999,
		});
		assert.ok(upper > 1190 && upper <= 1200, `expected ~1200, got ${upper}`);
	});

	it("jitter stays within ±20% across a sweep of random() outputs", () => {
		const attempt = 4; // raw delay = 8000
		const raw = 8000;
		const ratio = 0.2;
		for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999]) {
			const d = nextBackoffDelay(attempt, {
				baseMs: 1000,
				jitterRatio: ratio,
				random: () => r,
			});
			assert.ok(
				d >= raw * (1 - ratio) - 1e-6 && d <= raw * (1 + ratio) + 1e-6,
				`attempt=${attempt} r=${r} → ${d} outside [${raw * 0.8}, ${raw * 1.2}]`,
			);
		}
	});

	it("clamps jittered delay to maxMs even when jitter would push above the cap", () => {
		// Raw delay BEFORE jitter is capped at maxMs (300_000). If jitter then
		// multiplies up to 1.2 the contract still clamps the FINAL value to maxMs.
		const d = nextBackoffDelay(20, {
			baseMs: 1000,
			maxMs: 300_000,
			jitterRatio: 0.2,
			random: () => 0.999999, // push toward 1.2x
		});
		assert.ok(d <= 300_000, `expected ≤ 300_000, got ${d}`);
		// And the lower-bound side stays positive (jitter never negative).
		const d2 = nextBackoffDelay(20, {
			baseMs: 1000,
			maxMs: 300_000,
			jitterRatio: 0.2,
			random: () => 0,
		});
		assert.ok(d2 > 0 && d2 <= 300_000);
		// At random=0 we're at lower bound: 300_000 * 0.8 = 240_000.
		assert.equal(d2, 240_000);
	});

	it("returns a finite non-negative number for very large attempts", () => {
		// Defends against 2 ** N overflow becoming Infinity/NaN.
		const d = nextBackoffDelay(1000, {
			baseMs: 1000,
			maxMs: 300_000,
			jitterRatio: 0.2,
			random: () => 0.5,
		});
		assert.ok(Number.isFinite(d), "delay must be finite");
		assert.ok(d >= 0 && d <= 300_000);
	});

	// ── Defaults ───────────────────────────────────────────────────────

	it("with no opts: baseMs=1000, no cap, no jitter", () => {
		assert.equal(nextBackoffDelay(1), 1000);
		assert.equal(nextBackoffDelay(5), 16_000);
		// No cap by default → keeps doubling.
		assert.equal(nextBackoffDelay(10), 512_000);
	});
});
