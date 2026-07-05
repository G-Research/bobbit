/**
 * Pinning test — STR-01 cohort 4 (src/server/routes/pack-runtimes-routes.ts).
 *
 * Pins the registered surface of the `/api/pack-runtimes*` family and, most
 * importantly, the LEGACY FALL-THROUGH PARITY the migration had to
 * reproduce (see that module's header): each of the five sub-routes
 * (capabilities, down, start, stop, restart, logs) matched the PATH first
 * (a bare regex test, no upfront method gate) and only THEN checked
 * `req.method`, answering a mismatched method with an immediate
 * `405 "method not allowed"` — it never fell through past its own block for
 * ANY method. The registry reproduces this with explicit
 * `handleMethodNotAllowed` shim registrations; this test pins that they
 * exist for every representable method on every one of those five path
 * patterns, so no method/path combination that used to be answered inside
 * the legacy block can silently change behavior by falling through to the
 * (shrinking) legacy chain.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "../src/server/routes/route-table.ts";
import type { CoreRouteCtx } from "../src/server/routes/core-route-ctx.ts";
import { registerPackRuntimesRoutes } from "../src/server/routes/pack-runtimes-routes.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
// The five `:id`-scoped sub-routes — each answers ALL methods (real handler
// or 405 shim), unlike the bare `/api/pack-runtimes` list route below.
const ID_SCOPED_PATTERN_PATHS = [
	"/api/pack-runtimes/some-id/capabilities",
	"/api/pack-runtimes/some-id/down",
	"/api/pack-runtimes/some-id/start",
	"/api/pack-runtimes/some-id/stop",
	"/api/pack-runtimes/some-id/restart",
	"/api/pack-runtimes/some-id/logs",
];

function buildTable(): RouteTable<CoreRouteCtx> {
	const table = new RouteTable<CoreRouteCtx>();
	registerPackRuntimesRoutes(table);
	return table;
}

describe("pack-runtimes route family (STR-01 cohort 4)", () => {
	it("routes the real method/suffix combinations", () => {
		const table = buildTable();
		const cases: Array<[typeof METHODS[number], string]> = [
			["GET", "/api/pack-runtimes"],
			["GET", "/api/pack-runtimes/rt-id/capabilities"],
			["POST", "/api/pack-runtimes/rt-id/down"],
			["POST", "/api/pack-runtimes/rt-id/start"],
			["POST", "/api/pack-runtimes/rt-id/stop"],
			["POST", "/api/pack-runtimes/rt-id/restart"],
			["GET", "/api/pack-runtimes/rt-id/logs"],
		];
		for (const [method, p] of cases) {
			const m = table.match(method, p);
			assert.ok(m, `${method} ${p} must be routed`);
		}
		// `:id` capture sanity — the param is extracted for the id-scoped routes.
		const capMatch = table.match("GET", "/api/pack-runtimes/rt-id/capabilities");
		assert.equal(capMatch?.params.id, "rt-id");
		const startMatch = table.match("POST", "/api/pack-runtimes/rt-id/start");
		assert.equal(startMatch?.params.id, "rt-id");
	});

	it("EVERY representable method on EVERY id-scoped family pattern is registered (legacy fall-through parity — nothing escapes to the legacy chain)", () => {
		// The legacy block answered ALL methods on these five paths (real
		// handler for the supported method, an immediate 405 for every other
		// method). If a future edit drops a shim registration, that
		// method/path silently starts falling through to the legacy chain
		// instead — this pins against that.
		const table = buildTable();
		for (const p of ID_SCOPED_PATTERN_PATHS) {
			for (const method of METHODS) {
				assert.ok(table.match(method, p), `${method} ${p} must be registered (real handler or 405 parity shim)`);
			}
		}
	});

	it("the bare list route only registers GET (mismatched methods fall through to the legacy chain, exactly like before the migration)", () => {
		const table = buildTable();
		assert.ok(table.match("GET", "/api/pack-runtimes"));
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			assert.equal(table.match(method, "/api/pack-runtimes"), null);
		}
	});

	it("does NOT capture sibling /api/pack-runtimes/:id paths outside the family", () => {
		const table = buildTable();
		assert.equal(table.match("GET", "/api/pack-runtimes/rt-id"), null);
		assert.equal(table.match("GET", "/api/pack-runtimes/rt-id/other"), null);
		assert.equal(table.match("DELETE", "/api/pack-runtimes/rt-id"), null);
	});
});
