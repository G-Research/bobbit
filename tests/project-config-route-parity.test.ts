/**
 * Pinning test — STR-01 cohort 2 (src/server/routes/project-config-routes.ts).
 *
 * Pins the registered surface of the per-project config family and, most
 * importantly, the LEGACY FALL-THROUGH PARITY the migration had to
 * reproduce (see that module's header): the legacy chain's
 * `if (projectConfigMatch)` block matched the PATH for ANY method, resolved
 * the project (404 "Project not found" when missing) and only then branched
 * on method/suffix — unhandled combinations fell through to the chain's
 * terminal 404 "Not found". The registry reproduces this with explicit shim
 * registrations; this test pins that they exist for every representable
 * method on every pattern in the family, so no method/path combination that
 * used to be answered inside the legacy block can silently change behavior
 * by falling through to the (shrinking) legacy chain.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "../src/server/routes/route-table.ts";
import type { CoreRouteCtx } from "../src/server/routes/core-route-ctx.ts";
import { registerProjectConfigRoutes } from "../src/server/routes/project-config-routes.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PATTERN_PATHS = [
	"/api/projects/some-project/config",
	"/api/projects/some-project/config/defaults",
	"/api/projects/some-project/config/resolved",
];

function buildTable(): RouteTable<CoreRouteCtx> {
	const table = new RouteTable<CoreRouteCtx>();
	registerProjectConfigRoutes(table);
	return table;
}

describe("project-config route family (STR-01 cohort 2)", () => {
	it("routes the four real method/suffix combinations", () => {
		const table = buildTable();
		for (const [method, p] of [
			["GET", "/api/projects/p1/config"],
			["PUT", "/api/projects/p1/config"],
			["GET", "/api/projects/p1/config/defaults"],
			["GET", "/api/projects/p1/config/resolved"],
		] as const) {
			const m = table.match(method, p);
			assert.ok(m, `${method} ${p} must be routed`);
			assert.equal(m.params.id, "p1");
		}
	});

	it("EVERY representable method on EVERY family pattern is registered (legacy fall-through parity — nothing escapes to the legacy chain)", () => {
		// The legacy block answered ALL methods on these paths (via the
		// project-lookup-then-terminal-404 fall-through). If a future edit
		// drops a shim registration, that method/path silently starts falling
		// through to the legacy chain instead — this pins against that.
		const table = buildTable();
		for (const p of PATTERN_PATHS) {
			for (const method of METHODS) {
				assert.ok(table.match(method, p), `${method} ${p} must be registered (real handler or parity shim)`);
			}
		}
	});

	it("does NOT capture sibling /api/projects/:id/* paths outside the family", () => {
		const table = buildTable();
		// qa-testing-config shares the path shape but stays in the legacy
		// chain (deliberately not migrated in this cohort).
		assert.equal(table.match("GET", "/api/projects/p1/qa-testing-config"), null);
		// Deeper/other suffixes under /config are not part of the family.
		assert.equal(table.match("GET", "/api/projects/p1/config/other"), null);
		assert.equal(table.match("GET", "/api/projects/p1/config/defaults/extra"), null);
		// The bare project routes belong to cohort 1's module, not this one.
		assert.equal(table.match("GET", "/api/projects/p1"), null);
	});
});
