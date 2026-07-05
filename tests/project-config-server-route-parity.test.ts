/**
 * Pinning test — STR-01 cohort 4
 * (src/server/routes/project-config-server-routes.ts and the
 * qa-testing-config addition to src/server/routes/projects-routes.ts).
 *
 * Unlike cohort 2's per-project config family and this cohort's own
 * pack-runtimes family, the server-scope `/api/project-config` trio gated on
 * `url.pathname === ... && req.method === ...` TOGETHER in the legacy code
 * (the cohort-1 shape) — an unmatched method on these literal paths always
 * fell straight through to the rest of the chain both before and after this
 * migration. This test pins the real routes AND documents (via the negative
 * assertions) that no legacy-fall-through-parity shim is needed here, unlike
 * its sibling cohort-4 module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "../src/server/routes/route-table.ts";
import type { CoreRouteCtx } from "../src/server/routes/core-route-ctx.ts";
import { registerServerProjectConfigRoutes } from "../src/server/routes/project-config-server-routes.ts";
import { registerProjectRoutes } from "../src/server/routes/projects-routes.ts";

function buildServerProjectConfigTable(): RouteTable<CoreRouteCtx> {
	const table = new RouteTable<CoreRouteCtx>();
	registerServerProjectConfigRoutes(table);
	return table;
}

describe("server-scope project-config trio (STR-01 cohort 4)", () => {
	it("routes the three real method/path combinations", () => {
		const table = buildServerProjectConfigTable();
		assert.ok(table.match("GET", "/api/project-config"));
		assert.ok(table.match("GET", "/api/project-config/defaults"));
		assert.ok(table.match("PUT", "/api/project-config"));
	});

	it("unmatched methods on these paths are NOT registered (no legacy fall-through-parity shim needed — see module header)", () => {
		const table = buildServerProjectConfigTable();
		for (const method of ["POST", "PATCH", "DELETE"] as const) {
			assert.equal(table.match(method, "/api/project-config"), null);
		}
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			assert.equal(table.match(method, "/api/project-config/defaults"), null);
		}
	});

	it("does not capture the per-project config family's paths (a different module/family)", () => {
		const table = buildServerProjectConfigTable();
		assert.equal(table.match("GET", "/api/projects/p1/config"), null);
	});
});

describe("qa-testing-config addition to the projects family (STR-01 cohort 4)", () => {
	it("routes GET /api/projects/:id/qa-testing-config", () => {
		const table = new RouteTable<CoreRouteCtx>();
		registerProjectRoutes(table);
		const m = table.match("GET", "/api/projects/p1/qa-testing-config");
		assert.ok(m);
		assert.equal(m.params.id, "p1");
		// Other methods on this path fall through unrouted, exactly as before
		// the migration (the legacy block gated on GET only).
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			assert.equal(table.match(method, "/api/projects/p1/qa-testing-config"), null);
		}
	});
});
