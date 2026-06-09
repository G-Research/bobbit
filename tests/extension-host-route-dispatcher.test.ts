/**
 * Unit tests for the SERVER extension host's RouteDispatcher + pack-level
 * RouteRegistry (src/server/extension-host/route-dispatcher.ts) — Slice B3,
 * design docs/design/extension-host-phase2.md §5.
 *
 * Pinned invariants:
 *   - RouteDispatcher mirrors ActionDispatcher: loads routes.js from the WINNING
 *     provider's {baseDir, groupDir}; honors a custom routes.module; unknown
 *     route / missing module → 404; handler throw → 500; timeout → 504;
 *     epoch-cache invalidate() picks up updated source.
 *   - RouteRegistry is PACK-scoped + opener-INDEPENDENT: a route declared on
 *     tool Y is resolved + dispatched for an opener tool X in the SAME pack.
 *   - Duplicate route names within a pack are REJECTED at registry-build (409).
 *   - Namespace-by-construction: the index is keyed by packId, so a pack reaches
 *     ONLY its own routes (cross-pack lookups miss).
 *
 * Fixtures are written under a temp dir (file:// ESM imports) and removed after.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	RouteDispatcher,
	RouteRegistry,
	type RouteHandlerCtx,
	type RouteToolEnumerator,
	type RouteToolLocation,
	type RouteToolLocationResolver,
} from "../src/server/extension-host/route-dispatcher.ts";
import { ActionError } from "../src/server/extension-host/action-dispatcher.ts";

let tmp: string;

const ctx = (): RouteHandlerCtx => ({
	host: {} as RouteHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "",
	tool: "demo_tool",
});

/** A market-pack-style baseDir so resolvePackIdentity derives `<packName>`. */
function packBase(root: string, packName: string): string {
	return path.join(root, "market-packs", packName, "tools-root");
}

/** Write a routes module (default routes.js) under baseDir/groupDir. */
function writeRoutes(baseDir: string, groupDir: string, src: string, moduleName = "routes.js"): void {
	const dir = path.join(baseDir, groupDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, moduleName), src);
}

/** Stub resolver for a single declaring tool (dispatcher-only). */
function resolver(loc: RouteToolLocation, tool = "demo_tool"): RouteToolLocationResolver {
	return { resolveToolLocation: (name) => (name === tool ? loc : undefined) };
}

/** Stub enumerator over a map of tool → location (registry + dispatcher). */
function enumerator(tools: Record<string, RouteToolLocation>): RouteToolEnumerator {
	return {
		getAllToolNames: () => Object.keys(tools),
		resolveToolLocation: (name) => tools[name],
	};
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-route-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("RouteDispatcher — resolution + happy path", () => {
	it("loads routes.js from the winning provider dir and passes the request through", async () => {
		const base = packBase(path.join(tmp, "happy"), "p");
		writeRoutes(
			base,
			"demo",
			`export const routes = { bundle: async (ctx, req) => ({ ok: true, method: req.method, q: req.query, tool: ctx.tool }) };`,
		);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		const result = await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET", query: { id: "7" } });
		assert.deepEqual(result, { ok: true, method: "GET", q: { id: "7" }, tool: "demo_tool" });
	});

	it("honors a custom routes.module path", async () => {
		const base = packBase(path.join(tmp, "custom"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: async () => ({ from: "handlers.js" }) };`, "handlers.js");
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo", routesModule: "handlers.js" }), { rate: null });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { from: "handlers.js" });
	});

	it("supports a default-exported routes module", async () => {
		const base = packBase(path.join(tmp, "default-export"), "p");
		writeRoutes(base, "demo", `export default { routes: { bundle: async () => ({ via: "default" }) } };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { via: "default" });
	});

	it("loads from whatever (winning) provider dir it is handed (pack shadows builtin)", async () => {
		const builtin = path.join(tmp, "precedence", "builtin");
		const pack = packBase(path.join(tmp, "precedence"), "p");
		writeRoutes(builtin, "demo", `export const routes = { bundle: async () => ({ from: "builtin" }) };`);
		writeRoutes(pack, "demo", `export const routes = { bundle: async () => ({ from: "pack" }) };`);
		// The resolver returns the PACK baseDir (the winner), so the pack module loads.
		const d = new RouteDispatcher(resolver({ baseDir: pack, groupDir: "demo" }), { rate: null });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { from: "pack" });
	});
});

describe("RouteDispatcher — error isolation + blast-radius", () => {
	it("unknown tool provider → 404", async () => {
		const d = new RouteDispatcher({ resolveToolLocation: () => undefined }, { rate: null });
		await assert.rejects(() => d.dispatch("nope", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404);
	});

	it("missing routes module file → 404", async () => {
		const base = packBase(path.join(tmp, "missing"), "p");
		fs.mkdirSync(path.join(base, "demo"), { recursive: true }); // dir but no routes.js
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404);
	});

	it("unknown route name → 404 (incl. inherited prototype members)", async () => {
		const base = packBase(path.join(tmp, "unknown-route"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: async () => ({}) };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		await assert.rejects(() => d.dispatch("demo_tool", "missing", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404);
		for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			await assert.rejects(
				() => d.dispatch("demo_tool", evil, ctx(), { method: "GET" }),
				(e) => e instanceof ActionError && e.status === 404,
				`expected ${evil} to be rejected as unknown route`,
			);
		}
	});

	it("module without a routes export → 500", async () => {
		const base = packBase(path.join(tmp, "no-export"), "p");
		writeRoutes(base, "demo", `export const notRoutes = {};`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 500);
	});

	it("handler throw → 500 and the dispatcher survives", async () => {
		const base = packBase(path.join(tmp, "throw"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: async () => { throw new Error("boom"); } };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 500 && /boom/.test(e.message));
	});

	it("handler exceeding the per-call timeout → 504", async () => {
		const base = packBase(path.join(tmp, "timeout"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: () => new Promise(() => {}) };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null, timeoutMs: 40 });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 504);
	});

	it("global concurrency cap → 429 for the over-cap call", async () => {
		const base = packBase(path.join(tmp, "concurrency"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 80)) };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: null, maxConcurrent: 1 });
		const first = d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 429);
		assert.deepEqual(await first, { ok: 1 });
	});

	it("per-session rate limit → 429 once the bucket drains", async () => {
		const base = packBase(path.join(tmp, "rate"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: async () => ({ ok: 1 }) };`);
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo" }), { rate: { capacity: 2, refillPerSec: 0 } });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { ok: 1 });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { ok: 1 });
		await assert.rejects(() => d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 429);
	});
});

describe("RouteDispatcher — cache + invalidation", () => {
	it("reuses a hot module, and invalidate() picks up updated handler source", async () => {
		// `.mjs` so the native ESM loader honors the mtime+epoch query cache-bust
		// under the tsx test runner (tsx caches transpiled `.js` by path).
		const base = packBase(path.join(tmp, "invalidate"), "p");
		writeRoutes(base, "demo", `export const routes = { bundle: async () => ({ v: 1 }) };`, "routes.mjs");
		const d = new RouteDispatcher(resolver({ baseDir: base, groupDir: "demo", routesModule: "routes.mjs" }), { rate: null });
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { v: 1 });

		fs.writeFileSync(path.join(base, "demo", "routes.mjs"), `export const routes = { bundle: async () => ({ v: 2 }) };`);
		d.invalidate();
		assert.deepEqual(await d.dispatch("demo_tool", "bundle", ctx(), { method: "GET" }), { v: 2 });
	});
});

describe("RouteRegistry — pack-scoped, opener-independent resolution", () => {
	it("resolves a route to its declaring tool + module path within the pack", () => {
		const root = path.join(tmp, "reg-basic");
		const base = packBase(root, "mypack");
		const tools = enumerator({
			tool_y: { baseDir: base, groupDir: "y", routeNames: ["bundle", "meta"] },
		});
		const reg = new RouteRegistry(tools);
		const r = reg.resolve("mypack", "bundle");
		assert.ok(r, "expected bundle to resolve");
		assert.equal(r!.declaringTool, "tool_y");
		assert.equal(r!.modulePath, path.resolve(path.join(base, "y"), "routes.js"));
		// honors a custom routes.module
		const tools2 = enumerator({ tool_z: { baseDir: base, groupDir: "z", routesModule: "api.js", routeNames: ["bundle"] } });
		const reg2 = new RouteRegistry(tools2);
		assert.equal(reg2.resolve("mypack", "bundle")!.modulePath, path.resolve(path.join(base, "z"), "api.js"));
	});

	it("opener tool X reaches a route DECLARED by a different tool Y in the SAME pack, and dispatches Y's module", async () => {
		// THE acceptance proof: pack-scoped, opener-independent (§5 B3.1). The
		// registry indexes every routes-bearing tool in the pack; resolution is by
		// packId, not the opener tool — so a surface opened from tool X (which has no
		// routes) reaches tool Y's "bundle" route and runs Y's module.
		const root = path.join(tmp, "opener-independent");
		const base = packBase(root, "mypack");
		writeRoutes(base, "y", `export const routes = { bundle: async (ctx, req) => ({ from: "Y", q: req.query }) };`);
		const tools = enumerator({
			tool_x: { baseDir: base, groupDir: "x" },                       // opener — no routes
			tool_y: { baseDir: base, groupDir: "y", routeNames: ["bundle"] }, // declares the route
		});
		const reg = new RouteRegistry(tools);
		// The opener is X, but the route resolves to Y (its declaring tool).
		const resolved = reg.resolve("mypack", "bundle");
		assert.ok(resolved);
		assert.equal(resolved!.declaringTool, "tool_y");

		// Dispatch the registry's declaring tool — runs Y's module regardless of X.
		const d = new RouteDispatcher(tools, { rate: null });
		const result = await d.dispatch(resolved!.declaringTool, "bundle", ctx(), { method: "GET", query: { id: "1" } }, tools);
		assert.deepEqual(result, { from: "Y", q: { id: "1" } });
	});

	it("rejects DUPLICATE route names declared on two tools in the same pack (registry-build, 409)", () => {
		const root = path.join(tmp, "dup");
		const base = packBase(root, "mypack");
		const tools = enumerator({
			tool_a: { baseDir: base, groupDir: "a", routeNames: ["bundle"] },
			tool_b: { baseDir: base, groupDir: "b", routeNames: ["bundle"] },
		});
		const reg = new RouteRegistry(tools);
		assert.throws(
			() => reg.resolve("mypack", "bundle"),
			(e) => e instanceof ActionError && e.status === 409 && /bundle/.test(e.message) && /tool_a/.test(e.message) && /tool_b/.test(e.message),
		);
	});

	it("namespace-by-construction: the index is keyed by packId — a pack reaches ONLY its own routes", () => {
		const root = path.join(tmp, "namespace");
		const baseA = packBase(root, "packA");
		const baseB = packBase(root, "packB");
		const tools = enumerator({
			a_tool: { baseDir: baseA, groupDir: "g", routeNames: ["bundle"] },
			b_tool: { baseDir: baseB, groupDir: "g", routeNames: ["other"] },
		});
		const reg = new RouteRegistry(tools);
		// packA owns "bundle"; packB does NOT (cross-pack lookup misses).
		assert.ok(reg.resolve("packA", "bundle"));
		assert.equal(reg.resolve("packB", "bundle"), undefined);
		// packB owns "other"; packA does NOT.
		assert.ok(reg.resolve("packB", "other"));
		assert.equal(reg.resolve("packA", "other"), undefined);
	});

	it("unknown route / unknown pack → undefined", () => {
		const base = packBase(path.join(tmp, "unknown"), "mypack");
		const tools = enumerator({ tool_y: { baseDir: base, groupDir: "y", routeNames: ["bundle"] } });
		const reg = new RouteRegistry(tools);
		assert.equal(reg.resolve("mypack", "nope"), undefined);
		assert.equal(reg.resolve("otherpack", "bundle"), undefined);
		assert.equal(reg.resolve("", "bundle"), undefined);
	});

	it("a non-pack tool (no market-packs segment) contributes no routes", () => {
		const base = path.join(tmp, "nonpack", "defaults", "tools");
		const tools = enumerator({ builtin_tool: { baseDir: base, groupDir: "g", routeNames: ["bundle"] } });
		const reg = new RouteRegistry(tools);
		// derivePackId("") for a non-market path; resolve under any packId misses.
		assert.equal(reg.resolve("", "bundle"), undefined);
		assert.equal(reg.resolve("nonpack", "bundle"), undefined);
	});

	it("a routes-bearing tool with NO declared names is not indexed (names drive the index)", () => {
		const base = packBase(path.join(tmp, "no-names"), "mypack");
		const tools = enumerator({ tool_y: { baseDir: base, groupDir: "y" /* no routeNames */ } });
		const reg = new RouteRegistry(tools);
		assert.equal(reg.resolve("mypack", "bundle"), undefined);
	});

	it("invalidate() rebuilds the cached index", () => {
		const base = packBase(path.join(tmp, "reg-invalidate"), "mypack");
		let names = ["bundle"];
		const tools: RouteToolEnumerator = {
			getAllToolNames: () => ["tool_y"],
			resolveToolLocation: (name) => (name === "tool_y" ? { baseDir: base, groupDir: "y", routeNames: names } : undefined),
		};
		const reg = new RouteRegistry(tools);
		assert.ok(reg.resolve("mypack", "bundle"));
		// Change the declared names; cached map still serves the old index ...
		names = ["meta"];
		assert.ok(reg.resolve("mypack", "bundle"), "cached index still resolves the old name");
		// ... until invalidate() drops the cache.
		reg.invalidate();
		assert.equal(reg.resolve("mypack", "bundle"), undefined);
		assert.ok(reg.resolve("mypack", "meta"));
	});

	it("resolve honors a per-call enumerator over the constructor one (project-scope precedence)", () => {
		const serverBase = packBase(path.join(tmp, "percall", "server"), "mypack");
		const projectBase = packBase(path.join(tmp, "percall", "project"), "mypack");
		const server = enumerator({ s_tool: { baseDir: serverBase, groupDir: "g", routeNames: ["bundle"] } });
		const project = enumerator({ p_tool: { baseDir: projectBase, groupDir: "g", routeNames: ["bundle"] } });
		const reg = new RouteRegistry(server);
		assert.equal(reg.resolve("mypack", "bundle")!.declaringTool, "s_tool");
		assert.equal(reg.resolve("mypack", "bundle", project)!.declaringTool, "p_tool");
	});
});
