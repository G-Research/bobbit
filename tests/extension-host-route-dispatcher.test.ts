/**
 * Unit tests for the SERVER extension host's RouteDispatcher + pack-level
 * RouteRegistry (src/server/extension-host/route-dispatcher.ts) after the
 * pack-schema-v1 rationalisation (§5.3).
 *
 * Routes are now declared at the PACK LEVEL (pack.yaml.routes), so:
 *   - RouteDispatcher.dispatch is keyed by a RESOLVED { modulePath, packRoot }
 *     (no carrier tool); it loads the module, runs the handler under blast-radius
 *     controls, and confines imports to the pack root.
 *   - RouteRegistry resolves (packId, routeName, projectId) → { modulePath,
 *     packRoot } from the pack's pack-level RouteContribution via the
 *     PackContributionResolver. Cross-pack lookups miss; the allowlist gates names.
 *
 * Fixtures are written under a temp dir (file:// ESM imports) and removed after.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	RouteDispatcher,
	RouteRegistry,
	type RouteHandlerCtx,
} from "../src/server/extension-host/route-dispatcher.ts";
import { ActionError } from "../src/server/extension-host/action-dispatcher.ts";
import type { PackContributions } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionResolver } from "../src/server/extension-host/pack-contribution-registry.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

let tmp: string;

const ctx = (): RouteHandlerCtx => ({
	host: {} as RouteHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "",
	tool: "route:bundle",
});

/** Write a routes module under <packRoot>/<rel> and return its abs path + packRoot. */
function writeRoutesModule(root: string, packName: string, rel: string, src: string): { modulePath: string; packRoot: string } {
	const packRoot = path.join(root, "market-packs", packName);
	const abs = path.join(packRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, src);
	return { modulePath: abs, packRoot };
}

before(() => { tmp = makeTmpDir("ext-host-route-"); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("RouteDispatcher — resolution + happy path (pack-level module)", () => {
	it("loads the resolved module path and passes the request through", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "happy"), "p", "lib/routes.mjs",
			`export const routes = { bundle: async (ctx, req) => ({ ok: true, method: req.method, q: req.query, tool: ctx.tool }) };`);
		const d = new RouteDispatcher({ rate: null });
		const result = await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET", query: { id: "7" } });
		assert.deepEqual(result, { ok: true, method: "GET", q: { id: "7" }, tool: "route:bundle" });
	});

	it("supports a default-exported routes module", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "default-export"), "p", "lib/routes.mjs",
			`export default { routes: { bundle: async () => ({ via: "default" }) } };`);
		const d = new RouteDispatcher({ rate: null });
		assert.deepEqual(await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), { via: "default" });
	});
});

describe("RouteDispatcher — error isolation + blast-radius", () => {
	it("missing module file → 404", async () => {
		const packRoot = path.join(tmp, "missing", "market-packs", "p");
		fs.mkdirSync(packRoot, { recursive: true });
		const d = new RouteDispatcher({ rate: null });
		await assert.rejects(() => d.dispatch(path.join(packRoot, "lib", "routes.mjs"), packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404);
	});

	it("a module path escaping the pack root → 400", async () => {
		const { packRoot } = writeRoutesModule(path.join(tmp, "escape"), "p", "lib/routes.mjs", `export const routes = {};`);
		const outside = path.join(tmp, "escape", "evil.mjs");
		fs.writeFileSync(outside, `export const routes = {};`);
		const d = new RouteDispatcher({ rate: null });
		await assert.rejects(() => d.dispatch(outside, packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 400);
	});

	it("unknown route name → 404 (incl. inherited prototype members)", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "unknown-route"), "p", "lib/routes.mjs", `export const routes = { bundle: async () => ({}) };`);
		const d = new RouteDispatcher({ rate: null });
		await assert.rejects(() => d.dispatch(modulePath, packRoot, "missing", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404);
		for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			await assert.rejects(() => d.dispatch(modulePath, packRoot, evil, ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 404, `expected ${evil} rejected`);
		}
	});

	it("module without a routes export → 500", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "no-export"), "p", "lib/routes.mjs", `export const notRoutes = {};`);
		const d = new RouteDispatcher({ rate: null });
		await assert.rejects(() => d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 500);
	});

	it("handler throw → 500 and the dispatcher survives", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "throw"), "p", "lib/routes.mjs", `export const routes = { bundle: async () => { throw new Error("boom"); } };`);
		const d = new RouteDispatcher({ rate: null });
		await assert.rejects(() => d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 500 && /boom/.test(e.message));
	});

	it("handler exceeding the per-call timeout → 504", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "timeout"), "p", "lib/routes.mjs", `export const routes = { bundle: () => new Promise(() => {}) };`);
		const d = new RouteDispatcher({ rate: null, timeoutMs: 40 });
		await assert.rejects(() => d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 504);
	});

	it("per-session rate limit → 429 once the bucket drains", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "rate"), "p", "lib/routes.mjs", `export const routes = { bundle: async () => ({ ok: 1 }) };`);
		const d = new RouteDispatcher({ rate: { capacity: 2, refillPerSec: 0 } });
		assert.deepEqual(await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), { ok: 1 });
		assert.deepEqual(await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), { ok: 1 });
		await assert.rejects(() => d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), (e) => e instanceof ActionError && e.status === 429);
	});

	it("invalidate() picks up updated handler source", async () => {
		const { modulePath, packRoot } = writeRoutesModule(path.join(tmp, "invalidate"), "p", "lib/routes.mjs", `export const routes = { bundle: async () => ({ v: 1 }) };`);
		const d = new RouteDispatcher({ rate: null });
		assert.deepEqual(await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), { v: 1 });
		fs.writeFileSync(modulePath, `export const routes = { bundle: async () => ({ v: 2 }) };`);
		d.invalidate();
		assert.deepEqual(await d.dispatch(modulePath, packRoot, "bundle", ctx(), { method: "GET" }), { v: 2 });
	});
});

// ── RouteRegistry over the pack-contribution resolver (§5.3) ──

/** A PackContributionResolver stub serving a fixed set of packs by packId. */
function contribResolver(packs: PackContributions[]): PackContributionResolver {
	const byId = new Map(packs.map((p) => [p.packId, p]));
	return {
		list: () => packs,
		getPack: (_pid, packId) => byId.get(packId),
		getPanel: (_pid, packId, panelId) => byId.get(packId)?.panels.find((p) => p.id === panelId),
		getEntrypoint: (_pid, packId, id) => byId.get(packId)?.entrypoints.find((e) => e.id === id),
		listProviders: () => packs.flatMap((p) => p.providers),
		hasRoute: (_pid, packId, name) => !!byId.get(packId)?.routes?.names.includes(name),
	};
}

function packWithRoutes(packId: string, packRoot: string, module: string, names: string[]): PackContributions {
	return {
		packId, packName: packId, packRoot,
		panels: [], entrypoints: [], providers: [],
		routes: { module, names, sourceFile: path.join(packRoot, "pack.yaml"), packRoot },
	};
}

describe("RouteRegistry — pack-level resolution + allowlist + namespacing", () => {
	it("resolves a route name in the allowlist to { modulePath, packRoot } relative to pack.yaml", () => {
		const packRoot = path.join(tmp, "reg", "market-packs", "mypack");
		const reg = new RouteRegistry(contribResolver([packWithRoutes("mypack", packRoot, "lib/routes.mjs", ["bundle", "publish"])]));
		const r = reg.resolve("mypack", "bundle", undefined);
		assert.ok(r);
		assert.equal(r!.modulePath, path.resolve(packRoot, "lib/routes.mjs"));
		assert.equal(r!.packRoot, packRoot);
	});

	it("a route name NOT in the allowlist → undefined", () => {
		const packRoot = path.join(tmp, "reg2", "market-packs", "mypack");
		const reg = new RouteRegistry(contribResolver([packWithRoutes("mypack", packRoot, "lib/routes.mjs", ["bundle"])]));
		assert.equal(reg.resolve("mypack", "nope", undefined), undefined);
	});

	it("namespacing: a pack reaches ONLY its own routes (cross-pack misses)", () => {
		const rootA = path.join(tmp, "ns", "market-packs", "packA");
		const rootB = path.join(tmp, "ns", "market-packs", "packB");
		const reg = new RouteRegistry(contribResolver([
			packWithRoutes("packA", rootA, "lib/routes.mjs", ["bundle"]),
			packWithRoutes("packB", rootB, "lib/routes.mjs", ["other"]),
		]));
		assert.ok(reg.resolve("packA", "bundle", undefined));
		assert.equal(reg.resolve("packB", "bundle", undefined), undefined);
		assert.ok(reg.resolve("packB", "other", undefined));
		assert.equal(reg.resolve("packA", "other", undefined), undefined);
	});

	it("a pack with no routes ref → undefined; empty/unknown packId → undefined", () => {
		const packRoot = path.join(tmp, "noroutes", "market-packs", "mypack");
		const reg = new RouteRegistry(contribResolver([
			{ packId: "mypack", packName: "mypack", packRoot, panels: [], entrypoints: [], providers: [] },
		]));
		assert.equal(reg.resolve("mypack", "bundle", undefined), undefined);
		assert.equal(reg.resolve("", "bundle", undefined), undefined);
		assert.equal(reg.resolve("ghost", "bundle", undefined), undefined);
	});
});
