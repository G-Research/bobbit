/**
 * Regression test for the sidebar "Loading…" flash.
 *
 * Symptom: the left sidebar (projects, goals, sessions) momentarily blanks to a
 * centered "Loading…" placeholder and repopulates — most visible on first load,
 * but for some users it recurs every ~5s while idle.
 *
 * Root cause: `refreshSessions()` (src/app/api.ts) decided "this is an initial
 * load → show the spinner" using `state.gatewaySessions.length === 0 &&
 * !state.sessionsError`. List length is the wrong proxy for "never fetched":
 * any user whose `gatewaySessions` is legitimately empty (projects/goals but no
 * *live* sessions, or no projects at all) keeps `length === 0` true forever, so
 * every 5s poll tick re-enters "initial load" and re-blanks the sidebar.
 *
 * Correct contract: initial-load must be keyed off whether a fetch has ever
 * COMPLETED — `state.sessionsGeneration` is -1 until the first successful fetch
 * and >= 0 thereafter — while still suppressing the spinner when an error is on
 * screen (so background poll retries stay silent under the error/Retry UI).
 *
 * The decision lives in the dependency-free helper `isInitialSessionsLoad`
 * (src/app/session-load-state.ts) so it can be pinned here directly in node,
 * without the DOM-bound app-shell graph. This test asserts the CORRECT post-fix
 * contract; it FAILS against the old list-length logic on the second-poll-tick
 * row (`generation:0` → expected `false`, old logic returns `true`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInitialSessionsLoad } from "../src/app/session-load-state.ts";

describe("isInitialSessionsLoad — sidebar loading-flash contract", () => {
	it("shows the spinner once on a genuine first load (never fetched, no error)", () => {
		assert.equal(
			isInitialSessionsLoad({ gatewaySessionsLength: 0, sessionsGeneration: -1, sessionsError: "" }),
			true,
		);
	});

	it("does NOT re-show the spinner on a later poll tick once a fetch completed, even with an empty list", () => {
		// This is the reproduction: empty list + already-fetched (generation 0)
		// must NOT be treated as an initial load. The old list-length logic
		// returns true here, which is the 5s flash bug.
		assert.equal(
			isInitialSessionsLoad({ gatewaySessionsLength: 0, sessionsGeneration: 0, sessionsError: "" }),
			false,
		);
	});

	it("does NOT re-show the spinner on any later poll tick with an empty list", () => {
		assert.equal(
			isInitialSessionsLoad({ gatewaySessionsLength: 0, sessionsGeneration: 5, sessionsError: "" }),
			false,
		);
	});

	it("does NOT show the spinner while an initial fetch error is on screen (polls retry silently)", () => {
		assert.equal(
			isInitialSessionsLoad({ gatewaySessionsLength: 0, sessionsGeneration: -1, sessionsError: "boom" }),
			false,
		);
	});

	it("shows the spinner again on Retry after an initial error is cleared (never loaded, error cleared)", () => {
		assert.equal(
			isInitialSessionsLoad({ gatewaySessionsLength: 0, sessionsGeneration: -1, sessionsError: "" }),
			true,
		);
	});
});
