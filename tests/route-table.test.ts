/**
 * Unit tests for the STR-01 core route-registry mechanics
 * (src/server/routes/route-table.ts). See docs/design/route-registry.md.
 *
 * Covers: exact/param/prefix pattern compilation, the fixed
 * exact > param > prefix precedence (the explicit-specificity resolver the
 * STR-01 finding asked for, replacing the legacy chain's implicit
 * source-order precedence), 404-style fallthrough (`match()` returns null,
 * NOT a 405) when a path is registered but not for the requested method, and
 * duplicate-registration guards.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "../src/server/routes/route-table.ts";

type Ctx = { calls: string[] };

describe("RouteTable", () => {
	it("matches an exact literal pattern", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects", (ctx) => { ctx.calls.push("list"); });
		const m = table.match("GET", "/api/projects");
		assert.ok(m);
		assert.deepEqual(m.params, {});
	});

	it("does not match an exact pattern against a different path or method", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects", () => {});
		assert.equal(table.match("GET", "/api/projects/order"), null);
		assert.equal(table.match("POST", "/api/projects"), null);
	});

	it("extracts named params from a `:param` pattern", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:id/structured", () => {});
		const m = table.match("GET", "/api/projects/abc-123/structured");
		assert.ok(m);
		assert.deepEqual(m.params, { id: "abc-123" });
	});

	it("supports multiple named params in one pattern", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:projectId/goals/:goalId", () => {});
		const m = table.match("GET", "/api/projects/p1/goals/g2");
		assert.ok(m);
		assert.deepEqual(m.params, { projectId: "p1", goalId: "g2" });
	});

	it("a `:param` segment never crosses a `/` boundary", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:id", () => {});
		assert.equal(table.match("GET", "/api/projects/a/b"), null);
	});

	it("matches a `/*` prefix pattern on anything under it", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/marketplace/*", () => {});
		assert.ok(table.match("GET", "/api/marketplace/browse"));
		assert.ok(table.match("GET", "/api/marketplace/sources/abc/sync"));
		assert.equal(table.match("GET", "/api/marketplace"), null); // no trailing slash — not "under" the prefix
	});

	it("precedence: an exact match always wins over an overlapping `:param` pattern, regardless of registration order", () => {
		const table = new RouteTable<Ctx>();
		// Register the param route FIRST — if precedence were registration-order
		// (the legacy chain's bug class), the exact route below would be shadowed.
		table.register("GET", "/api/projects/:id", (ctx) => { ctx.calls.push("byId"); });
		table.register("GET", "/api/projects/order", (ctx) => { ctx.calls.push("order"); });
		const ctx: Ctx = { calls: [] };
		const m = table.match("GET", "/api/projects/order");
		assert.ok(m);
		m.handler(ctx, m.params);
		assert.deepEqual(ctx.calls, ["order"]);
	});

	it("precedence: `:param` beats `/*` prefix for an overlapping path", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/foo/*", (ctx) => { ctx.calls.push("prefix"); });
		table.register("GET", "/api/foo/:id", (ctx) => { ctx.calls.push("param"); });
		const ctx: Ctx = { calls: [] };
		const m = table.match("GET", "/api/foo/bar");
		assert.ok(m);
		m.handler(ctx, m.params);
		assert.deepEqual(ctx.calls, ["param"]);
	});

	it("a path registered for one method is NOT routed for a different method (falls through — 404, not 405)", () => {
		const table = new RouteTable<Ctx>();
		table.register("DELETE", "/api/projects/:id", () => {});
		assert.equal(table.match("GET", "/api/projects/abc"), null);
	});

	it("excludeParamValues rejects a specific literal value for the LAST :param segment (falls through, not routed)", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:id", (ctx) => { ctx.calls.push("byId"); }, {
			excludeParamValues: { id: ["order", "preflight"] },
		});
		assert.equal(table.match("GET", "/api/projects/order"), null);
		assert.equal(table.match("GET", "/api/projects/preflight"), null);
		assert.ok(table.match("GET", "/api/projects/some-real-id"));
	});

	it("excludeParamValues on a non-last segment throws at registration time", () => {
		const table = new RouteTable<Ctx>();
		assert.throws(() => table.register("GET", "/api/projects/:id/structured", () => {}, {
			excludeParamValues: { id: ["order"] },
		}));
	});

	it("an unregistered path returns null (caller falls through to the legacy chain)", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects", () => {});
		assert.equal(table.match("GET", "/api/totally-unregistered"), null);
	});

	it("throws at registration time on a duplicate exact (method, pattern)", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects", () => {});
		assert.throws(() => table.register("GET", "/api/projects", () => {}));
	});

	it("throws at registration time on a duplicate `:param` (method, pattern)", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:id", () => {});
		assert.throws(() => table.register("GET", "/api/projects/:id", () => {}));
	});

	it("throws at registration time on a duplicate `/*` prefix (method, pattern)", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/foo/*", () => {});
		assert.throws(() => table.register("GET", "/api/foo/*", () => {}));
	});

	it("does NOT throw when the same pattern is registered for a different method", () => {
		const table = new RouteTable<Ctx>();
		table.register("GET", "/api/projects/:id", () => {});
		assert.doesNotThrow(() => table.register("DELETE", "/api/projects/:id", () => {}));
	});

	it("a literal segment containing regex-special characters, alongside a `:param` segment, is matched literally not as a regex wildcard", () => {
		const table = new RouteTable<Ctx>();
		// The literal "foo.bar" segment sits alongside a ":id" param segment, so
		// this pattern compiles through the regex path (unlike a pure exact
		// pattern) — exercising the literal-segment escaping.
		table.register("GET", "/api/foo.bar/:id", (ctx) => { ctx.calls.push("hit"); });
		assert.ok(table.match("GET", "/api/foo.bar/123"));
		// "." must not act as a regex wildcard — "fooXbar" must NOT match.
		assert.equal(table.match("GET", "/api/fooXbar/123"), null);
	});
});
