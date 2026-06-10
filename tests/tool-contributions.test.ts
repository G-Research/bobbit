/**
 * Unit tests for parseContributions() + parseEntrypoints() + the renderer-kind
 * helpers (src/server/agent/tool-contributions.ts) after the pack-schema-v1
 * rationalisation (§1.3, §2.1).
 *
 * Pinned invariants:
 *   - A tool YAML parses ONLY `renderer` + `actions`. The OLD per-tool pack-scoped
 *     keys (`panels`/`routes`/`stores`/`entrypoints`) are treated AS IF THEY NEVER
 *     EXISTED — ignored like any unknown key, with NO diagnostic (the §1.3
 *     MAINTAINER DECISION). The §1.3 pin asserts NON-registration only.
 *   - `isSafeRelativePath` is RELAXED to ALLOW `..` segments (shared lib/ modules):
 *     a `../../lib/X.js` renderer/actions path parses through. Absolute /
 *     drive-absolute / leading-separator / null-byte paths are still rejected.
 *   - actions.names validation (/^[a-z0-9][a-z0-9_-]*$/) drops bad entries.
 *   - rendererKind === "pack" ONLY for a market-pack baseDir + a `.js` renderer.
 *   - parseEntrypoints (reused by the pack-level loader) validates the union shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseContributions,
	parseEntrypoints,
	isSafeRelativePath,
	computeRendererKind,
	isMarketPackBaseDir,
} from "../src/server/agent/tool-contributions.ts";

const FP = "/fake/market-packs/demo/tools/demo/sample.yaml";

describe("parseContributions — tool-scoped keys (renderer + actions only)", () => {
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
		assert.deepEqual(parseContributions({ actions: "custom.js" }, FP).actions, { module: "custom.js" });
		assert.deepEqual(parseContributions({ actions: true }, FP).actions, { module: "actions.js" });
	});

	it("validates actions.names: drops entries not matching /^[a-z0-9][a-z0-9_-]*$/", () => {
		const c = parseContributions(
			{ actions: { names: ["retry", "Retry", "-bad", "ok_1", "with space", "x-y"] } },
			FP,
		);
		assert.deepEqual(c.actions?.names, ["retry", "ok_1", "x-y"]);
	});

	it("allows a `../../lib/X.js` renderer/actions path (§2.1 — shared lib modules)", () => {
		assert.equal(parseContributions({ renderer: "../../lib/SharedRenderer.js" }, FP).renderer, "../../lib/SharedRenderer.js");
		assert.equal(parseContributions({ actions: { module: "../actions.mjs" } }, FP).actions?.module, "../actions.mjs");
		assert.equal(parseContributions({ renderer: "sub/Renderer.js" }, FP).renderer, "sub/Renderer.js");
	});

	it("rejects structurally-unsafe paths (absolute / drive-absolute / leading sep) → dropped", () => {
		assert.equal(parseContributions({ renderer: "/etc/evil.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "C:\\evil.js" }, FP).renderer, undefined);
		assert.equal(parseContributions({ renderer: "\\evil.js" }, FP).renderer, undefined);
		// unsafe actions.module → falls back to default actions.js
		assert.equal(parseContributions({ actions: { module: "/abs.js" } }, FP).actions?.module, "actions.js");
		// unsafe bare-string actions → no actions at all
		assert.equal(parseContributions({ actions: "/abs.js" }, FP).actions, undefined);
	});
});

describe("isSafeRelativePath (§2.1 relaxed: `..` allowed, absolute/drive/leading-sep/null rejected)", () => {
	it("allows relative paths including `..` segments", () => {
		assert.equal(isSafeRelativePath("../../lib/X.js"), true);
		assert.equal(isSafeRelativePath("../X.js"), true);
		assert.equal(isSafeRelativePath("sub/X.js"), true);
		assert.equal(isSafeRelativePath("X.js"), true);
	});
	it("rejects absolute, drive-absolute, leading-separator, null-byte", () => {
		assert.equal(isSafeRelativePath("/abs.js"), false);
		assert.equal(isSafeRelativePath("\\abs.js"), false);
		assert.equal(isSafeRelativePath("C:/abs.js"), false);
		assert.equal(isSafeRelativePath("C:\\abs.js"), false);
		assert.equal(isSafeRelativePath("a\0b.js"), false);
		assert.equal(isSafeRelativePath(""), false);
	});
});

describe("§1.3 pin — old per-tool pack-scoped keys are treated as if they never existed", () => {
	it("a tool YAML carrying panels/routes/stores/entrypoints parses to NO such contributions (no diagnostic)", () => {
		const c = parseContributions(
			{
				name: "legacy",
				renderer: "R.js",
				actions: { names: ["retry"] },
				// old pack-scoped keys — must be IGNORED like any unknown key:
				panels: [{ id: "demo.viewer", entry: "panel.js" }],
				routes: { module: "routes.js", names: ["bundle"] },
				stores: ["prefs"],
				entrypoints: [{ id: "open", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }],
			},
			FP,
		);
		// ONLY renderer + actions survive.
		assert.equal(c.renderer, "R.js");
		assert.deepEqual(c.actions, { module: "actions.js", names: ["retry"] });
		// The old keys produce NO contribution fields (those fields no longer exist on
		// the type) and are NOT retained on `reserved` — non-registration only, no
		// old-schema-specific diagnostic path.
		const asAny = c as unknown as Record<string, unknown>;
		assert.equal(asAny.panels, undefined);
		assert.equal(asAny.routes, undefined);
		assert.equal(asAny.stores, undefined);
		assert.equal(asAny.entrypoints, undefined);
		assert.equal((c.reserved as Record<string, unknown>).panels, undefined);
		assert.equal((c.reserved as Record<string, unknown>).routes, undefined);
		assert.equal((c.reserved as Record<string, unknown>).stores, undefined);
		assert.equal((c.reserved as Record<string, unknown>).entrypoints, undefined);
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

describe("parseEntrypoints (reused by the pack-level loader; tolerant, never rejects)", () => {
	it("parses launcher kinds with a label + structured target", () => {
		assert.deepEqual(
			parseEntrypoints(
				[{ id: "slash", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }],
				FP,
			),
			[{ id: "slash", kind: "composer-slash", label: "Open", target: { panelId: "demo.viewer" } }],
		);
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
});

describe("isMarketPackBaseDir / computeRendererKind (design §2.5)", () => {
	it("isMarketPackBaseDir matches only a real market-packs path segment", () => {
		assert.equal(isMarketPackBaseDir("/home/u/.bobbit/config/market-packs/demo/tools"), true);
		assert.equal(isMarketPackBaseDir("C:\\u\\.bobbit\\config\\market-packs\\demo\\tools"), true);
		assert.equal(isMarketPackBaseDir("/opt/bobbit/dist/server/defaults/tools"), false);
		assert.equal(isMarketPackBaseDir("/home/u/my-market-packs-notes/tools"), false);
		assert.equal(isMarketPackBaseDir(undefined), false);
	});

	it("rendererKind is 'pack' ONLY for a market baseDir + a .js renderer", () => {
		const mkt = "/home/u/.bobbit/config/market-packs/demo/tools";
		const builtin = "/opt/bobbit/dist/server/defaults/tools";
		assert.equal(computeRendererKind(mkt, "R.js"), "pack");
		assert.equal(computeRendererKind(mkt, "R.JS"), "pack");
		assert.equal(computeRendererKind(mkt, "R.ts"), "builtin");
		assert.equal(computeRendererKind(mkt, undefined), "builtin");
		assert.equal(computeRendererKind(builtin, "R.js"), "builtin");
	});
});
