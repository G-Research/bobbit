/**
 * Pins the goal-dashboard hash route's id charset (QA-SPOT 2026-07-05
 * FINDING 2, part B — see docs cross-ref in src/app/routing.ts).
 *
 * Root cause: `getRouteFromHash()`'s `#/goal/:id` regex previously only
 * accepted `[a-f0-9-]+` (hex + dash), unlike every sibling id-based route
 * in this file (`session`, `role-edit`, `tool-edit`, `workflow-edit`, all
 * `[a-zA-Z0-9_-]+`). Production goal ids are always `crypto.randomUUID()`
 * (goal-manager.ts's `createGoal()`), a strict subset of both charsets, so
 * this never broke a real created goal — but it silently (no console
 * error, no thrown exception) fails to match ANY id containing a letter
 * outside a-f, such as scripts/qa-seed/seed.mjs's human-readable fixture
 * id `"qa-seed-goal-0001-0001-0001-000000000001"`. A hash that fails the
 * regex falls through to `{ view: "landing" }`, which is exactly the
 * "direct #/goal/:id navigation renders the generic empty state" bug QA
 * reproduced three independent ways against the seeded goal.
 *
 * This is a plain node:test against a faked `window.location` — mirrors
 * tests/session-path-routing.test.ts's pattern — no browser/gateway
 * needed, so it runs in the fast unit phase.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getRouteFromHash } from "../src/app/routing.ts";

type FakeLocation = {
	pathname: string;
	search?: string;
	hash?: string;
};

function routeWithLocation(location: FakeLocation): ReturnType<typeof getRouteFromHash> {
	const originalWindow = (globalThis as any).window;
	(globalThis as any).window = {
		location: {
			pathname: location.pathname,
			search: location.search ?? "",
			hash: location.hash ?? "",
		},
	};
	try {
		return getRouteFromHash();
	} finally {
		if (originalWindow === undefined) {
			delete (globalThis as any).window;
		} else {
			(globalThis as any).window = originalWindow;
		}
	}
}

test("a real production goal id (crypto.randomUUID shape) parses as goal-dashboard", () => {
	const goalId = "a1b2c3d4-e5f6-4789-a123-0123456789ab";
	const route = routeWithLocation({ pathname: "/", hash: `#/goal/${goalId}` });
	assert.deepEqual(
		route,
		{ view: "goal-dashboard", goalId, dashboardTab: undefined, focusGateId: undefined, focusSignalId: undefined },
		`ROUTE_MISMATCH: #/goal/${goalId} should parse as goal-dashboard, got ${JSON.stringify(route)}`,
	);
});

test("the QA seed script's human-readable goal id parses as goal-dashboard, not landing", () => {
	// This exact id is scripts/qa-seed/seed.mjs's GOAL_ID constant.
	const goalId = "qa-seed-goal-0001-0001-0001-000000000001";
	const route = routeWithLocation({ pathname: "/", hash: `#/goal/${goalId}` });
	assert.deepEqual(
		route,
		{ view: "goal-dashboard", goalId, dashboardTab: undefined, focusGateId: undefined, focusSignalId: undefined },
		`ROUTE_MISMATCH: #/goal/${goalId} should parse as goal-dashboard (not silently fall back to landing), got ${JSON.stringify(route)}`,
	);
});

test("goal-dashboard route with a non-hex id still parses query params (tab/gate/signal)", () => {
	const goalId = "qa-seed-goal-0001-0001-0001-000000000001";
	const route = routeWithLocation({ pathname: "/", hash: `#/goal/${goalId}?tab=gates&gate=design-doc&signal=sig-1` });
	assert.deepEqual(
		route,
		{ view: "goal-dashboard", goalId, dashboardTab: "gates", focusGateId: "design-doc", focusSignalId: "sig-1" },
		`ROUTE_MISMATCH: got ${JSON.stringify(route)}`,
	);
});

test("an id containing characters outside the id charset (e.g. a slash) still falls back to landing", () => {
	// Guards against over-widening: this must not become a catch-all that
	// swallows unrelated hashes.
	const route = routeWithLocation({ pathname: "/", hash: "#/goal/not/a/goal/id" });
	assert.deepEqual(route, { view: "landing" }, `ROUTE_MISMATCH: got ${JSON.stringify(route)}`);
});
