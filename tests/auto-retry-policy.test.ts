/**
 * Unit tests for the auto-retry policy decisions invoked by
 * `SessionManager.maybeAutoRetryTransient()`.
 *
 * Strategy: rather than constructing a full SessionManager (which requires
 * RPC bridges, project stores, etc), we replicate the policy decision tree
 * here as a pure function `decideRetryPolicy()` that delegates classification
 * to the SAME exported helpers the manager uses
 * (`isTransientReviewError`, `isProviderBackoffError`, `nextBackoffDelay`).
 *
 * If the building blocks behave correctly, the manager is a thin scheduler
 * around them; this test pins the contract those building blocks must
 * satisfy for the manager to implement the design correctly.
 *
 * Behaviour pinned here:
 *   1. Provider overload / rate-limit errors → effectively unbounded retries,
 *      exponential backoff capped at 300_000 ms.
 *   2. Non-provider transient errors → bounded at 3 attempts (1s, 2s, 4s).
 *   3. Non-transient errors → no auto-retry.
 *
 * Runs via `npm run test:unit` (Node test runner).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	isTransientReviewError,
	isProviderBackoffError,
} from "../src/server/agent/verification-logic.ts";
import { nextBackoffDelay } from "../src/server/agent/session-setup.ts";

// ── Policy under test ──────────────────────────────────────────────────────

const PROVIDER_BACKOFF_MAX_MS = 300_000;
const TRANSIENT_MAX_ATTEMPTS = 3;

type RetryDecision =
	| { retry: false; reason: "non-transient" | "exhausted" }
	| { retry: true; delayMs: number; reason: "provider-backoff" | "transient-error"; attempt: number };

function decideRetryPolicy(
	errMsg: string,
	priorAttempts: number,
	opts?: { random?: () => number },
): RetryDecision {
	if (!errMsg || !isTransientReviewError(errMsg)) {
		return { retry: false, reason: "non-transient" };
	}
	const attempt = priorAttempts + 1;
	if (isProviderBackoffError(errMsg)) {
		const delayMs = nextBackoffDelay(attempt, {
			baseMs: 1000,
			maxMs: PROVIDER_BACKOFF_MAX_MS,
			jitterRatio: 0.2,
			random: opts?.random ?? (() => 0.5),
		});
		return { retry: true, delayMs, reason: "provider-backoff", attempt };
	}
	// Bounded path — current behaviour: 1s, 2s, 4s, stop.
	if (attempt > TRANSIENT_MAX_ATTEMPTS) {
		return { retry: false, reason: "exhausted" };
	}
	const delayMs = 1000 * Math.pow(2, attempt - 1);
	return { retry: true, delayMs, reason: "transient-error", attempt };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const OVERLOAD_JSON =
	'Error: {"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cb3PkGgaYHToky3UNLG2i"}';
const RATE_LIMIT_JSON = '{"type":"rate_limit_error","message":"Rate limited"}';
const JSON_GLITCH =
	"Error: Expected ',' or '}' after property value in JSON at position 320";
const NETWORK_BLIP = "Error: read ECONNRESET";

// ── Provider-backoff path: effectively unbounded ──────────────────────────

describe("decideRetryPolicy — provider overload / rate-limit", () => {
	it("schedules a retry for the overloaded_error JSON sample", () => {
		const r = decideRetryPolicy(OVERLOAD_JSON, 0);
		assert.equal(r.retry, true);
		assert.equal((r as any).reason, "provider-backoff");
		assert.equal((r as any).attempt, 1);
	});

	it("schedules a retry for rate_limit_error", () => {
		const r = decideRetryPolicy(RATE_LIMIT_JSON, 0);
		assert.equal(r.retry, true);
		assert.equal((r as any).reason, "provider-backoff");
	});

	it("schedules a retry for HTTP 429 / 529", () => {
		for (const msg of ["HTTP 429 Too Many Requests", "status 429", "HTTP 529", "statusCode: 529"]) {
			const r = decideRetryPolicy(msg, 0);
			assert.equal(r.retry, true, `expected retry for: ${msg}`);
			assert.equal((r as any).reason, "provider-backoff", `expected provider-backoff for: ${msg}`);
		}
	});

	it("does NOT stop at the 3-attempt bounded cap for overload errors", () => {
		// Attempts well past TRANSIENT_MAX_ATTEMPTS still retry.
		for (const prior of [3, 5, 10, 50, 100, 1000]) {
			const r = decideRetryPolicy(OVERLOAD_JSON, prior);
			assert.equal(r.retry, true, `expected retry at priorAttempts=${prior}`);
			assert.equal((r as any).reason, "provider-backoff");
		}
	});

	it("backoff grows 1s → 2s → 4s → 8s with no jitter (random=0.5)", () => {
		const delays = [0, 1, 2, 3].map(prior => {
			const r = decideRetryPolicy(OVERLOAD_JSON, prior, { random: () => 0.5 });
			assert.equal(r.retry, true);
			return (r as any).delayMs as number;
		});
		assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
	});

	it("caps delay at 300_000 ms (5 minutes) for large attempt numbers", () => {
		// random=0.5 → multiplier=1.0 → raw_capped = min(2^(n-1)*1000, 300_000)
		for (const prior of [9, 10, 20, 100]) {
			const r = decideRetryPolicy(OVERLOAD_JSON, prior, { random: () => 0.5 });
			const delayMs = (r as any).delayMs as number;
			assert.ok(delayMs <= PROVIDER_BACKOFF_MAX_MS, `cap violated at prior=${prior}: ${delayMs}`);
		}
		// Specifically: prior=9 → attempt=10 → raw=512_000 → capped to 300_000.
		const r10 = decideRetryPolicy(OVERLOAD_JSON, 9, { random: () => 0.5 });
		assert.equal((r10 as any).delayMs, 300_000);
	});

	it("applies ±20% jitter (random=0 → 0.8x, random→1 → 1.2x, bounded by cap)", () => {
		const low = decideRetryPolicy(OVERLOAD_JSON, 0, { random: () => 0 });
		assert.equal((low as any).delayMs, 800);

		const high = decideRetryPolicy(OVERLOAD_JSON, 0, { random: () => 0.999999 });
		const hd = (high as any).delayMs as number;
		assert.ok(hd > 1190 && hd <= 1200, `expected ~1200, got ${hd}`);

		// Jitter applied at the cap must still respect the cap.
		const capHigh = decideRetryPolicy(OVERLOAD_JSON, 20, { random: () => 0.999999 });
		assert.ok((capHigh as any).delayMs <= PROVIDER_BACKOFF_MAX_MS);
	});
});

// ── Bounded path: existing behaviour preserved ────────────────────────────

describe("decideRetryPolicy — non-provider transient (bounded)", () => {
	it("schedules a retry for JSON parse glitches with 1s/2s/4s delays", () => {
		const delays = [0, 1, 2].map(prior => {
			const r = decideRetryPolicy(JSON_GLITCH, prior);
			assert.equal(r.retry, true);
			assert.equal((r as any).reason, "transient-error");
			return (r as any).delayMs as number;
		});
		assert.deepEqual(delays, [1000, 2000, 4000]);
	});

	it("schedules a retry for ECONNRESET (network blip) — bounded", () => {
		const r = decideRetryPolicy(NETWORK_BLIP, 0);
		assert.equal(r.retry, true);
		assert.equal((r as any).reason, "transient-error");
	});

	it("STOPS after 3 attempts for non-provider transient errors", () => {
		const r3 = decideRetryPolicy(JSON_GLITCH, 2); // attempt 3
		assert.equal(r3.retry, true);

		const r4 = decideRetryPolicy(JSON_GLITCH, 3); // attempt 4 → exhausted
		assert.equal(r4.retry, false);
		assert.equal((r4 as any).reason, "exhausted");

		const rN = decideRetryPolicy(NETWORK_BLIP, 10);
		assert.equal(rN.retry, false);
		assert.equal((rN as any).reason, "exhausted");
	});

	it("Validation-failed-for-tool errors follow the bounded path", () => {
		const r = decideRetryPolicy(
			'Validation failed for tool "verification_result": ...',
			0,
		);
		assert.equal(r.retry, true);
		assert.equal((r as any).reason, "transient-error");
	});
});

// ── Non-transient: no retry ───────────────────────────────────────────────

describe("decideRetryPolicy — non-transient", () => {
	it("does not retry on empty error message", () => {
		const r = decideRetryPolicy("", 0);
		assert.equal(r.retry, false);
		assert.equal((r as any).reason, "non-transient");
	});

	it("does not retry on TypeError / generic JS error", () => {
		const r = decideRetryPolicy(
			"TypeError: cannot read properties of null",
			0,
		);
		assert.equal(r.retry, false);
		assert.equal((r as any).reason, "non-transient");
	});

	it("does not retry on a real review failure", () => {
		const r = decideRetryPolicy(
			"LLM review failed: 'reviewer' role not found in role store.",
			0,
		);
		assert.equal(r.retry, false);
	});
});
