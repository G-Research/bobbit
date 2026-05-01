/**
 * Pinned regression: when a gate signal's verification lock is held by
 * a stuck (or just slow) verification, the team-lead has no escape
 * hatch short of restarting the gateway. From PR #409 live integration
 * test (BUG-9): "Verification already in progress for this commit"
 * 409 was returned forever after a route-handler crash that left an
 * `activeVerifications` entry in place.
 *
 * Three escape hatches are now in place at the route's lock check:
 *   1. existing zombie-session sweep (`areVerificationSessionsAlive`)
 *   2. NEW age-based threshold: any active verification older than 60
 *      minutes is treated as stale regardless of its session state
 *   3. NEW explicit `?force=1` query param: caller takes responsibility
 *      for blowing away the lock
 *
 * The 409 response body now carries `ageMs`, `startedAt`, and a `hint`
 * field describing the `?force=1` escape so the team-lead can self-
 * diagnose without curl-tracing.
 *
 * This test pins the predicate logic the route uses; the end-to-end
 * route behaviour is covered by tests/e2e/gates-api.spec.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ActiveLike {
	gateId: string;
	overallStatus: string;
	startedAt: number;
}

/**
 * Replicates the production decision rule in `server.ts` gate-signal
 * route. Pure / no I/O — tests this rule in isolation. If you change
 * either, change both.
 */
function shouldClearStaleLock(opts: {
	alive: boolean;
	ageMs: number;
	force: boolean;
	staleAgeMs?: number;
}): { clear: boolean; reason: string } {
	const STALE_AGE_MS = opts.staleAgeMs ?? 60 * 60 * 1000;
	const staleByAge = opts.ageMs > STALE_AGE_MS;
	if (!opts.alive) return { clear: true, reason: "zombie session" };
	if (staleByAge) return { clear: true, reason: `age ${Math.floor(opts.ageMs / 60000)}min > ${Math.floor(STALE_AGE_MS / 60000)}min threshold` };
	if (opts.force) return { clear: true, reason: "force=1" };
	return { clear: false, reason: "verification in progress" };
}

describe("gate-signal stale lock escape hatches", () => {
	it("clears the lock when the session is dead (zombie)", () => {
		const decision = shouldClearStaleLock({ alive: false, ageMs: 30_000, force: false });
		assert.equal(decision.clear, true);
		assert.match(decision.reason, /zombie/);
	});

	it("clears the lock when the verification is older than 60 minutes (default threshold)", () => {
		const decision = shouldClearStaleLock({ alive: true, ageMs: 61 * 60 * 1000, force: false });
		assert.equal(decision.clear, true);
		assert.match(decision.reason, /age/);
	});

	it("does NOT clear the lock when verification is under 60 minutes and session is alive", () => {
		const decision = shouldClearStaleLock({ alive: true, ageMs: 30 * 60 * 1000, force: false });
		assert.equal(decision.clear, false);
	});

	it("clears the lock when force=1 is passed (caller-takes-responsibility escape)", () => {
		const decision = shouldClearStaleLock({ alive: true, ageMs: 30_000, force: true });
		assert.equal(decision.clear, true);
		assert.equal(decision.reason, "force=1");
	});

	it("force=1 wins over a young, alive verification", () => {
		// Even a fresh verification (10 seconds old, session still alive)
		// gets cleared if the team-lead explicitly forces it.
		const decision = shouldClearStaleLock({ alive: true, ageMs: 10_000, force: true });
		assert.equal(decision.clear, true);
	});

	it("staleByAge takes precedence over force=1 in the reason field", () => {
		// If both age-based stale AND force=1 fire, age wins as the
		// reason (it triggered first in the logic). This is an
		// implementation detail we pin to keep the audit log readable.
		const decision = shouldClearStaleLock({ alive: true, ageMs: 70 * 60 * 1000, force: true });
		assert.equal(decision.clear, true);
		assert.match(decision.reason, /age/);
	});

	it("custom threshold can be passed (test-only knob, not exposed at runtime)", () => {
		const decision = shouldClearStaleLock({ alive: true, ageMs: 11_000, force: false, staleAgeMs: 10_000 });
		assert.equal(decision.clear, true);
		assert.match(decision.reason, /age/);
	});

	it("zombie wins over force=1 in the reason (zombie short-circuits earliest)", () => {
		const decision = shouldClearStaleLock({ alive: false, ageMs: 30_000, force: true });
		assert.equal(decision.clear, true);
		assert.match(decision.reason, /zombie/);
	});
});
