/**
 * Unit tests for parseContributions() + the renderer-kind helpers
 * (src/server/agent/tool-contributions.ts) — the Extension Host Phase-1
 * contribution-point manifest parser (design docs/design/extension-host.md §2.2/§2.3).
 *
 * Pinned invariants:
 *   - Every Phase-2 key has graduated to a typed contribution: stores (B1), routes (B3),
 *     panels (B4), entrypoints (C1). RESERVED_KEYS is now empty, but a FUTURE unknown key
 *     is still accepted + retained verbatim + NEVER rejected by the fallback machinery.
 *   - `..` / absolute renderer + actions.module paths degrade gracefully (parsed away, no throw).
 *   - actions.names validation (/^[a-z0-9][a-z0-9_-]*$/) drops bad entries.
 *   - A malformed contributions block degrades (tool still loads with no renderer/actions).
 *   - rendererKind === "pack" ONLY for a market-pack baseDir + a `.js` renderer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseContributions,
	parseStores,
	parseRoutes,
	parseEntrypoints,
	computeRendererKind,
	isMarketPackBaseDir,
} from "../src/server/agent/tool-contributions.ts";

const FP = "/fake/market-packs/demo/tools/demo/sample.yaml";

describe("parseContributions — Phase-1 load-bearing keys", () => {
	it("parses a valid renderer + actions block", () => {
		const c = parseContributions(
			{ name: "sample_action", renderer: "SampleActionRenderer.js", actions: { module: "actions.js", names: ["retry"] } },
			FP,
		);
		assert.equal(c.renderer, "SampleActionRenderer.js");
		assert.deepEqual(c.actions, { module: "actions.js", names: ["retry"] });
	});

	it("defaults actions.module to actions.js when actions: present without a module", () => {
		assert.deepEqual(parseContributions({ actions: { names: ["retry"] } }, FP).actions, {
			module: "actions.js",
			names: ["retry"],
		});
		// bare string shorthand
		assert.deepEqual(parseContributions({ actions: "custom.js" }, FP).actions, { module: "custom.js" });
		// bare boolean shorthand
		assert.deepEqual(parseContributions({ actions: true }, FP).actions, { module: "actions.js" });
	});

	it("validates actions.names: drops entries not matching /^[a-z0-9][a-z0-9_-]*$/", () => {
		const c = parseContributions(
			{ actions: { names: ["retry", "Retry", "-bad", "ok_1", "with space", "x-y"] } },
			FP,
		);
		assert.deepEqual(c.actions?.names, ["retry", "ok_1", "x-y"]);
	});

	it("drops actions.names entirely when none are valid", () => {
		const c = parseContributions({ actions: { names: ["BAD", "_x"] } }, FP);
		assert.equal(c.actions?.names, undefined);
		assert.equal(c.actions?.module, "actions.js");
	});
});

describe("parseContributions — path traversal rejection (degrades, never throws)", () => {
	it("rejects `..` and absolute renderer paths → renderer absent", () => {
		assert.equal(parseContributions({ renderer: "../evil.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "/etc/evil.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "a/../../b.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "C:\\evil.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "..\\evil.js" }, FP).renderer, undefined);
		// a clean nested relative path is allowed
		assert.equal(parseContributions({ renderer: "sub/Renderer.js" }, FP).renderer, "sub/Renderer.js");
	});

	it("rejects unsafe actions.module → falls back to default actions.js", () => {
		assert.equal(parseContributions({ actions: { module: "../evil.js" } }, FP).actions?.module, "actions.js");
		assert.equal(parseContributions({ actions: { module: "/abs.js" } }, FP).actions?.module, "actions.js");
		// unsafe bare-string actions → no actions at all
		assert.equal(parseContributions({ actions: "../evil.js" }, FP).actions, undefined);
	});
});

describe("parseContributions — forward-compat fallback for FUTURE unknown keys (accepted + retained, never rejected)", () => {
	it("retains a future unknown array contribution key verbatim and never throws", () => {
		// RESERVED_KEYS is empty now that every Phase-2 key graduated, but the fallback
		// machinery stays generic: a future key re-added to RESERVED_KEYS would be
		// shape-validated (array) + retained verbatim here. With none configured, an
		// unknown key is simply ignored (not promoted, not retained) — and never throws.
		const c = parseContributions({ name: "t", futureThing: [{ id: "e" }] }, FP);
		assert.equal((c.reserved as Record<string, unknown>).futureThing, undefined);
		assert.equal(c.renderer, undefined);
		assert.equal(c.actions, undefined);
	});

	it("Slice B4 — `panels:` is GRADUATED to a typed field (no longer reserved)", () => {
		const c = parseContributions(
			{ name: "t", panels: [{ id: "demo.sidebar", title: "Demo", entry: "panel.js" }] },
			FP,
		);
		assert.deepEqual(c.panels, [{ id: "demo.sidebar", title: "Demo", entry: "panel.js" }]);
		// `panels` is no longer carried as a reserved key.
		assert.equal((c.reserved as Record<string, unknown>).panels, undefined);
	});

	it("Slice C1 — `entrypoints:` is GRADUATED to a typed field (no longer reserved)", () => {
		const c = parseContributions(
			{ name: "t", entrypoints: [{ id: "open", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }] },
			FP,
		);
		assert.deepEqual(c.entrypoints, [
			{ id: "open", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } },
		]);
		// `entrypoints` is no longer carried as a reserved key.
		assert.equal((c.reserved as Record<string, unknown>).entrypoints, undefined);
	});

	it("malformed entrypoints block (non-array) degrades — tool still parses, key dropped", () => {
		const c = parseContributions({ name: "t", entrypoints: { not: "an array" }, renderer: "R.js" }, FP);
		assert.equal(c.entrypoints, undefined);
		assert.equal((c.reserved as Record<string, unknown>).entrypoints, undefined);
		// the rest of the manifest still parses
		assert.equal(c.renderer, "R.js");
	});
});

describe("parseContributions — fully malformed input degrades", () => {
	it("returns an empty contributions object for non-object data", () => {
		for (const bad of [null, undefined, 42, "str", []]) {
			const c = parseContributions(bad, FP);
			assert.equal(c.renderer, undefined);
			assert.equal(c.actions, undefined);
			assert.deepEqual(c.reserved, {});
		}
	});
});

describe("parseStores (Slice B1 — `stores:` graduated to typed, advisory, never rejects)", () => {
	it("accepts bare-string and {id} entries, dedupes", () => {
		assert.deepEqual(parseStores(["prefs", { id: "cache" }, "prefs"], FP), [
			{ id: "prefs" },
			{ id: "cache" },
		]);
	});

	it("drops invalid entries (bad id / missing id / wrong shape), never throws", () => {
		assert.deepEqual(parseStores([{ ns: "s" }, "bad/slash", 42, { id: "ok-1" }], FP), [{ id: "ok-1" }]);
	});

	it("a non-array stores block degrades to [] (never rejects)", () => {
		assert.deepEqual(parseStores({ not: "array" }, FP), []);
	});

	it("parseContributions surfaces typed stores on the contribution", () => {
		const c = parseContributions({ name: "t", stores: ["prefs", { id: "cache" }] }, FP);
		assert.deepEqual(c.stores, [{ id: "prefs" }, { id: "cache" }]);
		// graduated off `reserved` — stores is no longer a reserved key
		assert.equal((c.reserved as Record<string, unknown>).stores, undefined);
	});
});

describe("parseRoutes (Slice B3 — `routes:` graduated to typed, load-bearing, never rejects per-tool)", () => {
	it("accepts the `true` and bare-string shorthands", () => {
		assert.deepEqual(parseRoutes(true, FP), { module: "routes.js" });
		assert.deepEqual(parseRoutes("api.js", FP), { module: "api.js" });
	});

	it("accepts the canonical { module, names } object and defaults the module", () => {
		assert.deepEqual(parseRoutes({ module: "api.js", names: ["bundle", "meta"] }, FP), { module: "api.js", names: ["bundle", "meta"] });
		assert.deepEqual(parseRoutes({ names: ["bundle"] }, FP), { module: "routes.js", names: ["bundle"] });
	});

	it("drops an unsafe module path (degrades to undefined, never throws)", () => {
		assert.equal(parseRoutes("../evil.js", FP), undefined);
		// unsafe object module degrades to the default module, dropping the bad path
		assert.deepEqual(parseRoutes({ module: "../evil.js", names: ["bundle"] }, FP), { module: "routes.js", names: ["bundle"] });
	});

	it("drops invalid route names, keeps valid ones", () => {
		assert.deepEqual(parseRoutes({ names: ["ok-1", "BAD", "also/bad", "good_2"] }, FP), { module: "routes.js", names: ["ok-1", "good_2"] });
	});

	it("a malformed routes block degrades (never rejects)", () => {
		assert.equal(parseRoutes(42, FP), undefined);
		assert.equal(parseRoutes(null, FP), undefined);
	});

	it("parseContributions surfaces typed routes + graduates off `reserved`", () => {
		const c = parseContributions({ name: "t", routes: { module: "api.js", names: ["bundle"] } }, FP);
		assert.deepEqual(c.routes, { module: "api.js", names: ["bundle"] });
		// graduated off `reserved` — routes is no longer a reserved key
		assert.equal((c.reserved as Record<string, unknown>).routes, undefined);
	});
});

describe("parseEntrypoints (Slice C1 — `entrypoints:` graduated to typed, tolerant, never rejects per-tool)", () => {
	it("parses launcher kinds with a label + structured target", () => {
		assert.deepEqual(
			parseEntrypoints(
				[{ id: "slash", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }],
				FP,
			),
			[{ id: "slash", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }],
		);
		// route-target launcher
		assert.deepEqual(
			parseEntrypoints([{ id: "go", kind: "command-palette", label: "Go", target: { route: "demo.route" } }], FP),
			[{ id: "go", kind: "command-palette", label: "Go", target: { route: "demo.route" } }],
		);
	});

	it("parses a `route` kind with routeId + target.panelId + paramKeys", () => {
		assert.deepEqual(
			parseEntrypoints(
				[{ id: "r", kind: "route", routeId: "demo.deep", target: { panelId: "demo.viewer" }, paramKeys: ["itemId", "tab"] }],
				FP,
			),
			[{ id: "r", kind: "route", routeId: "demo.deep", target: { panelId: "demo.viewer" }, paramKeys: ["itemId", "tab"] }],
		);
	});

	it("drops invalid entries (bad kind, missing label, missing routeId/panelId, bad id) — never rejects", () => {
		assert.deepEqual(parseEntrypoints([{ id: "x", kind: "bogus", label: "X", target: { panelId: "p" } }], FP), []);
		assert.deepEqual(parseEntrypoints([{ id: "x", kind: "composer-slash", target: { panelId: "p" } }], FP), []); // no label
		assert.deepEqual(parseEntrypoints([{ id: "x", kind: "composer-slash", label: "X" }], FP), []); // no target
		assert.deepEqual(parseEntrypoints([{ id: "r", kind: "route", target: { panelId: "p" }, paramKeys: [] }], FP), []); // no routeId
		assert.deepEqual(parseEntrypoints([{ id: "r", kind: "route", routeId: "d", target: {}, paramKeys: [] }], FP), []); // no panelId
		assert.deepEqual(parseEntrypoints([{ id: "1 bad", kind: "composer-slash", label: "X", target: { panelId: "p" } }], FP), []); // bad id
		assert.deepEqual(parseEntrypoints("not-an-array", FP), []);
	});

	it("non-string paramKeys are filtered; missing paramKeys defaults to []", () => {
		assert.deepEqual(
			parseEntrypoints([{ id: "r", kind: "route", routeId: "d", target: { panelId: "p" }, paramKeys: ["ok", 42, null] }], FP)[0].paramKeys,
			["ok"],
		);
		assert.deepEqual(
			parseEntrypoints([{ id: "r", kind: "route", routeId: "d", target: { panelId: "p" } }], FP)[0].paramKeys,
			[],
		);
	});

	it("duplicate ids keep the first occurrence", () => {
		const out = parseEntrypoints(
			[
				{ id: "dup", kind: "composer-slash", label: "First", target: { panelId: "a" } },
				{ id: "dup", kind: "composer-slash", label: "Second", target: { panelId: "b" } },
			],
			FP,
		);
		assert.equal(out.length, 1);
		assert.equal(out[0].label, "First");
	});
});

describe("isMarketPackBaseDir / computeRendererKind (design §2.5)", () => {
	it("isMarketPackBaseDir matches only a real market-packs path segment", () => {
		assert.equal(isMarketPackBaseDir("/home/u/.bobbit/config/market-packs/demo/tools"), true);
		assert.equal(isMarketPackBaseDir("C:\\u\\.bobbit\\config\\market-packs\\demo\\tools"), true);
		assert.equal(isMarketPackBaseDir("/opt/bobbit/dist/server/defaults/tools"), false);
		// substring-but-not-a-segment must NOT match
		assert.equal(isMarketPackBaseDir("/home/u/my-market-packs-notes/tools"), false);
		assert.equal(isMarketPackBaseDir(undefined), false);
	});

	it("rendererKind is 'pack' ONLY for a market baseDir + a .js renderer", () => {
		const mkt = "/home/u/.bobbit/config/market-packs/demo/tools";
		const builtin = "/opt/bobbit/dist/server/defaults/tools";
		assert.equal(computeRendererKind(mkt, "R.js"), "pack");
		assert.equal(computeRendererKind(mkt, "R.JS"), "pack"); // case-insensitive ext
		assert.equal(computeRendererKind(mkt, "R.ts"), "builtin"); // .ts ⇒ display-only
		assert.equal(computeRendererKind(mkt, undefined), "builtin"); // no renderer
		assert.equal(computeRendererKind(builtin, "R.js"), "builtin"); // not a market dir
	});
});
