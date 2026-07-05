/**
 * Pinning test — the generic `/api/projects/:id` route must never swallow a
 * reserved collection-level/other-verb literal segment (`preflight`,
 * `archive-bobbit`, `detect`, `scan`, `order`).
 *
 * Originally pinned by grepping src/server/server.ts for a hand-written
 * negative-lookahead regex (`projectGetMatch`). STR-01 (docs/design/
 * route-registry.md) migrated this route family into the core route
 * registry (src/server/routes/projects-routes.ts) — the regex no longer
 * exists in server.ts, replaced by `RouteTable`'s `excludeParamValues`
 * option (src/server/routes/route-table.ts). This test now asserts the same
 * behavioral invariant directly against the live registry rather than
 * against a specific regex literal in server.ts's source text, so it
 * survives the refactor while still catching the original regression class:
 * a stray method on a reserved literal path must fall through (unrouted),
 * NOT be routed to the generic :id handler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "../src/server/routes/route-table.ts";
import type { CoreRouteCtx } from "../src/server/routes/core-route-ctx.ts";
import { registerProjectRoutes } from "../src/server/routes/projects-routes.ts";

function buildTable(): RouteTable<CoreRouteCtx> {
	const table = new RouteTable<CoreRouteCtx>();
	registerProjectRoutes(table);
	return table;
}

test("generic project id route excludes reserved project order endpoint", () => {
	const table = buildTable();

	// A regular project id is routed to the generic :id handler.
	assert.ok(table.match("GET", "/api/projects/regular-project"));

	// The reserved "order" segment must NOT be captured as a generic project
	// id on a method that has no exact registration for it (DELETE/GET —
	// only PUT /api/projects/order is registered). It must fall through
	// (unrouted) rather than being swallowed by GET/PUT/DELETE :id.
	assert.equal(table.match("DELETE", "/api/projects/order"), null);
	assert.equal(table.match("GET", "/api/projects/order"), null);
});

test("every reserved literal segment is excluded from the generic :id route on GET/PUT/DELETE, except where it has its own exact registration", () => {
	const table = buildTable();
	// GET /api/projects/preflight and PUT /api/projects/order are real,
	// separately-registered exact routes — those two (method, segment)
	// combinations SHOULD match (via the exact route, not the generic :id
	// handler; see the next test). Every other combination has no exact
	// registration and must fall through unrouted.
	const hasExactRoute = (method: string, segment: string): boolean =>
		(method === "GET" && segment === "preflight") || (method === "PUT" && segment === "order");
	for (const segment of ["preflight", "archive-bobbit", "detect", "scan", "order"]) {
		for (const method of ["GET", "PUT", "DELETE"] as const) {
			if (hasExactRoute(method, segment)) continue;
			assert.equal(
				table.match(method, `/api/projects/${segment}`),
				null,
				`${method} /api/projects/${segment} must not be routed to the generic :id handler`,
			);
		}
	}
});

test("reserved literal segments still resolve on the method they actually have an exact registration for", () => {
	const table = buildTable();
	assert.ok(table.match("GET", "/api/projects/preflight"), "GET /api/projects/preflight");
	assert.ok(table.match("POST", "/api/projects/archive-bobbit"), "POST /api/projects/archive-bobbit");
	assert.ok(table.match("POST", "/api/projects/detect"), "POST /api/projects/detect");
	assert.ok(table.match("POST", "/api/projects/scan"), "POST /api/projects/scan");
	assert.ok(table.match("PUT", "/api/projects/order"), "PUT /api/projects/order");
});
