/**
 * Unit — pack-scoped contribution loaders + registry + manifest validation
 * (pack-schema-v1-rationalisation §1, §5).
 *
 * Covers:
 *   - manifest validation: contents.entrypoints (string[]) + top-level
 *     routes:{module,names} accepted; contents.mcp rejected for schema 1 and accepted for schema 2; schema-v2 keys round-trip.
 *   - loadPackContributions: panels/*.yaml + entrypoints/*.yaml (filtered by
 *     contents.entrypoints[], carrying listName) + pack.yaml.routes → §5.1 shapes;
 *     malformed file warned + dropped.
 *   - path containment to PACK ROOT (renderer/entry/routes.module via
 *     isPackPathWithinRoot); escaping path rejected.
 *   - hard conflicts: dup panel id / dup entrypoint id / dup route name
 *     (loader throws PackContributionError); dup host-global routeId (registry
 *     registers NEITHER deep-link).
 *   - winning-pack collapse (§5.2.1): same packId at two scopes → ONE getPack.
 *   - activation filtering (§7): disabled entrypoints/providers are omitted.
 *   - a no-tools pack still registers panels/entrypoints/routes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "../src/server/agent/pack-manifest.ts";
import { loadPackContributions, packIdFromRoot, PackContributionError } from "../src/server/agent/pack-contributions.ts";
import { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { isPackPathWithinRoot } from "../src/server/extension-host/path-guard.ts";
import type { PackEntry, PackManifest } from "../src/server/agent/pack-types.ts";

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-contributions-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** Build a market-pack root under tmp/<scopeDir>/market-packs/<name> and return it. */
function packRoot(scopeDir: string, name: string): string {
	return path.join(tmp, scopeDir, "market-packs", name);
}

function entry(root: string, scope: PackEntry["scope"], manifest: PackManifest): PackEntry {
	return { id: `market:${scope}:${manifest.name}`, kind: "market", scope, path: root, readOnly: true, manifest, layout: "defaults-tree" };
}

// ── Manifest validation (§1) ──────────────────────────────────────

describe("validateManifest (§1.2)", () => {
	const ok = { name: "p", description: "d", version: "1", contents: { roles: [], tools: [], skills: [] } };
	it("accepts contents.entrypoints (string[]) and defaults it to [] when absent", () => {
		assert.deepEqual(validateManifest(ok)!.contents.entrypoints, []);
		const m = validateManifest({ ...ok, contents: { ...ok.contents, entrypoints: ["a", "b"] } });
		assert.deepEqual(m!.contents.entrypoints, ["a", "b"]);
	});
	it("rejects a non-string-array contents.entrypoints", () => {
		assert.equal(validateManifest({ ...ok, contents: { ...ok.contents, entrypoints: [1, 2] } }), null);
	});
	it("rejects unsafe (path-traversal) contents.entrypoints basenames", () => {
		for (const bad of ["../outside", "..", "a/b", "a\\b", "/abs", "C:\\drive", "with\0null", ""]) {
			const problems: string[] = [];
			assert.equal(
				validateManifest({ ...ok, contents: { ...ok.contents, entrypoints: [bad] } }, problems),
				null,
				`expected ${JSON.stringify(bad)} to be rejected`,
			);
			assert.match(problems.join("; "), /entrypoints entry/);
		}
		// A valid basename still passes.
		const good = validateManifest({ ...ok, contents: { ...ok.contents, entrypoints: ["artifacts-deeplink"] } });
		assert.deepEqual(good!.contents.entrypoints, ["artifacts-deeplink"]);
	});
	it("accepts top-level routes:{module,names}", () => {
		const m = validateManifest({ ...ok, routes: { module: "lib/routes.mjs", names: ["bundle", "publish"] } });
		assert.deepEqual(m!.routes, { module: "lib/routes.mjs", names: ["bundle", "publish"] });
	});
	it("still rejects contents.mcp at schema 1; carries no stores schema", () => {
		const problems: string[] = [];
		assert.equal(validateManifest({ ...ok, contents: { ...ok.contents, mcp: ["x"] } }, problems), null);
		assert.equal(problems[0], "pack.yaml: contents.mcp is not allowed (MCP installs are out of scope in MVP)");
		const m = validateManifest(ok)! as unknown as Record<string, unknown>;
		assert.equal((m.contents as Record<string, unknown>).stores, undefined);
	});

	it("schema 2 accepts and normalizes new contents keys plus capabilities", () => {
		const m = validateManifest({
			...ok,
			schema: 2,
			provides: ["memory-api"],
			requires: ["host-api"],
			contents: {
				...ok.contents,
				providers: ["memory"],
				hooks: ["turn"],
				mcp: ["local"],
				"pi-extensions": ["pi"],
				runtimes: ["node"],
				workflows: ["review"],
			},
		});
		assert.ok(m);
		assert.equal(m.schema, 2);
		assert.deepEqual(m.provides, ["memory-api"]);
		assert.deepEqual(m.requires, ["host-api"]);
		assert.deepEqual(m.contents.providers, ["memory"]);
		assert.deepEqual(m.contents.hooks, ["turn"]);
		assert.deepEqual(m.contents.mcp, ["local"]);
		assert.deepEqual(m.contents.piExtensions, ["pi"]);
		assert.deepEqual(m.contents.runtimes, ["node"]);
		assert.deepEqual(m.contents.workflows, ["review"]);
	});

	it("rejects bad capability names and warns on newer schemas without failing", () => {
		const badProblems: string[] = [];
		assert.equal(validateManifest({ ...ok, schema: 2, provides: ["Bad_Name"] }, badProblems), null);
		assert.equal(badProblems[0], 'pack.yaml: provides entry "Bad_Name" must match /^[a-z0-9][a-z0-9-]*$/');

		const problems: string[] = [];
		const m = validateManifest({ ...ok, schema: 3, contents: { ...ok.contents, providers: ["memory"] } }, problems);
		assert.ok(m);
		assert.equal(m.schema, 3);
		assert.deepEqual(m.contents.providers, ["memory"]);
		assert.deepEqual(problems, ["pack.yaml: schema 3 is newer than supported (2)"]);
	});
});

// ── loadPackContributions + path containment (§5.1, §2) ────────────

function manifest(name: string, opts: Partial<PackManifest["contents"]> & { routes?: PackManifest["routes"] } = {}): PackManifest {
	return {
		name, description: "d", version: "1",
		contents: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: opts.entrypoints ?? [],
			providers: opts.providers ?? [],
			hooks: opts.hooks ?? [],
			mcp: opts.mcp ?? [],
			piExtensions: opts.piExtensions ?? [],
			runtimes: opts.runtimes ?? [],
			workflows: opts.workflows ?? [],
		},
		...(opts.routes ? { routes: opts.routes } : {}),
	};
}

describe("loadPackContributions (§5.1) + pack-root containment (§2)", () => {
	it("parses panels + entrypoints (filtered by contents.entrypoints, listName carried) + routes", () => {
		const root = packRoot("s1", "artifacts");
		w(path.join(root, "pack.yaml"), "name: artifacts\n");
		w(path.join(root, "panels", "artifacts-viewer.yaml"), "id: artifacts.viewer\ntitle: Artifact\ninstanceMode: parameterized\ninstanceParam: artifactId\nentry: ../lib/Viewer.js\n");
		w(path.join(root, "entrypoints", "artifacts-deeplink.yaml"), "id: artifacts.deeplink\nkind: route\nrouteId: artifacts\ntarget:\n  panelId: artifacts.viewer\nparamKeys: [artifactId]\n");
		// An entrypoint file NOT listed in contents.entrypoints must be ignored.
		w(path.join(root, "entrypoints", "unlisted.yaml"), "id: unlisted\nkind: composer-slash\nlabel: X\ntarget:\n  panelId: artifacts.viewer\n");
		w(path.join(root, "lib", "Viewer.js"), "export default {};\n");
		w(path.join(root, "lib", "routes.mjs"), "export const routes = {};\n");

		const m = manifest("artifacts", { entrypoints: ["artifacts-deeplink"], routes: { module: "lib/routes.mjs", names: ["bundle", "publish"] } });
		const c = loadPackContributions(root, m);

		assert.equal(c.packId, "artifacts");
		assert.deepEqual(c.panels.map((p) => ({ id: p.id, title: p.title, entry: p.entry, instanceMode: p.instanceMode, instanceParam: p.instanceParam })), [{ id: "artifacts.viewer", title: "Artifact", entry: "../lib/Viewer.js", instanceMode: "parameterized", instanceParam: "artifactId" }]);
		assert.equal(c.panels[0].packRoot, root);
		assert.equal(c.entrypoints.length, 1);
		assert.equal(c.entrypoints[0].id, "artifacts.deeplink");
		assert.equal(c.entrypoints[0].listName, "artifacts-deeplink");
		assert.equal(c.entrypoints[0].routeId, "artifacts");
		assert.deepEqual(c.routes, { module: "lib/routes.mjs", names: ["bundle", "publish"], sourceFile: path.join(root, "pack.yaml"), packRoot: root });

		// Path containment: the panel entry + routes module resolve WITHIN the pack root.
		const panelAbs = path.resolve(path.dirname(c.panels[0].sourceFile), c.panels[0].entry);
		assert.equal(isPackPathWithinRoot(root, panelAbs), true);
		const routesAbs = path.resolve(path.dirname(c.routes!.sourceFile), c.routes!.module);
		assert.equal(isPackPathWithinRoot(root, routesAbs), true);
	});

	it("drops a malformed panel file (bad id / missing entry) without crashing the scan", () => {
		const root = packRoot("s1b", "p");
		w(path.join(root, "pack.yaml"), "name: p\n");
		w(path.join(root, "panels", "good.yaml"), "id: good.panel\nentry: lib/a.js\n");
		w(path.join(root, "panels", "noentry.yaml"), "id: bad.panel\n");
		w(path.join(root, "panels", "badid.yaml"), "id: '1 bad'\nentry: lib/b.js\n");
		const c = loadPackContributions(root, manifest("p"));
		assert.deepEqual(c.panels.map((p) => p.id), ["good.panel"]);
	});

	it("a path escaping the pack root fails isPackPathWithinRoot (containment, not parse)", () => {
		const root = packRoot("s1c", "p");
		const escaping = path.resolve(root, "..", "..", "evil.js");
		assert.equal(isPackPathWithinRoot(root, escaping), false);
	});

	it("an unsafe entrypoint listName does not read/register a file outside entrypoints/", () => {
		const root = packRoot("s1e", "evil");
		w(path.join(root, "pack.yaml"), "name: evil\n");
		// A well-formed entrypoint YAML planted OUTSIDE entrypoints/ (in the pack
		// root) that a `../outside`-style listName would otherwise reach.
		w(path.join(root, "outside.yaml"), "id: evil.escaped\nkind: composer-slash\nlabel: Escaped\ntarget:\n  panelId: x\n");
		// A legitimate, listed entrypoint to prove the safe path still loads.
		w(path.join(root, "entrypoints", "ok.yaml"), "id: evil.ok\nkind: composer-slash\nlabel: OK\ntarget:\n  panelId: x\n");
		// Bypass validateManifest (the primary guard) to exercise the loader's
		// defense-in-depth directly with an unsafe listName.
		const m = manifest("evil", { entrypoints: ["../outside", "ok"] });
		const c = loadPackContributions(root, m);
		assert.deepEqual(c.entrypoints.map((e) => e.id), ["evil.ok"]);
	});

	it("a no-tools pack still loads panels + entrypoints + routes", () => {
		const root = packRoot("s1d", "ui-only");
		w(path.join(root, "pack.yaml"), "name: ui-only\n");
		w(path.join(root, "panels", "main.yaml"), "id: ui.main\nentry: lib/panel.js\n");
		w(path.join(root, "entrypoints", "open.yaml"), "id: ui.open\nkind: composer-slash\nlabel: Open\ntarget:\n  panelId: ui.main\n");
		w(path.join(root, "lib", "panel.js"), "export default {};\n");
		w(path.join(root, "lib", "routes.mjs"), "export const routes = {};\n");
		const c = loadPackContributions(root, manifest("ui-only", { entrypoints: ["open"], routes: { module: "lib/routes.mjs", names: ["bundle"] } }));
		assert.equal(c.panels.length, 1);
		assert.equal(c.entrypoints.length, 1);
		assert.deepEqual(c.routes?.names, ["bundle"]);
	});
});

// ── Hard conflicts (§5.4) ──────────────────────────────────────────

describe("hard conflicts (§5.4)", () => {
	it("duplicate panel id within a pack → PackContributionError", () => {
		const root = packRoot("c1", "p");
		w(path.join(root, "pack.yaml"), "name: p\n");
		w(path.join(root, "panels", "a.yaml"), "id: dup\nentry: lib/a.js\n");
		w(path.join(root, "panels", "b.yaml"), "id: dup\nentry: lib/b.js\n");
		assert.throws(() => loadPackContributions(root, manifest("p")), (e) => e instanceof PackContributionError && /panel id "dup"/.test(e.message));
	});

	it("duplicate entrypoint id within a pack → PackContributionError", () => {
		const root = packRoot("c2", "p");
		w(path.join(root, "pack.yaml"), "name: p\n");
		w(path.join(root, "entrypoints", "x.yaml"), "id: dup\nkind: composer-slash\nlabel: X\ntarget:\n  panelId: a\n");
		w(path.join(root, "entrypoints", "y.yaml"), "id: dup\nkind: composer-slash\nlabel: Y\ntarget:\n  panelId: b\n");
		assert.throws(() => loadPackContributions(root, manifest("p", { entrypoints: ["x", "y"] })), (e) => e instanceof PackContributionError && /entrypoint id "dup"/.test(e.message));
	});

	it("duplicate route name within a pack → PackContributionError", () => {
		const root = packRoot("c3", "p");
		w(path.join(root, "pack.yaml"), "name: p\n");
		assert.throws(() => loadPackContributions(root, manifest("p", { routes: { module: "lib/r.mjs", names: ["bundle", "bundle"] } })), (e) => e instanceof PackContributionError && /route name "bundle"/.test(e.message));
	});

	it("duplicate host-global routeId across DISTINCT packs → registry registers NEITHER deep-link", () => {
		const rootA = packRoot("c4a", "packA");
		const rootB = packRoot("c4b", "packB");
		for (const [root, name] of [[rootA, "packA"], [rootB, "packB"]] as const) {
			w(path.join(root, "pack.yaml"), `name: ${name}\n`);
			w(path.join(root, "entrypoints", "dl.yaml"), "id: dl\nkind: route\nrouteId: shared\ntarget:\n  panelId: a\nparamKeys: []\n");
		}
		const reg = new PackContributionRegistry(() => [
			entry(rootA, "server", manifest("packA", { entrypoints: ["dl"] })),
			entry(rootB, "global-user", manifest("packB", { entrypoints: ["dl"] })),
		]);
		// Both packs drop the conflicting deep-link entrypoint.
		assert.equal(reg.getPack(undefined, "packA")!.entrypoints.length, 0);
		assert.equal(reg.getPack(undefined, "packB")!.entrypoints.length, 0);
	});
});

// ── Registry: precedence collapse + activation filtering + always-emit ──

describe("PackContributionRegistry (§5.2.1, §7)", () => {
	it("winning-pack collapse: same packId at two scopes → ONE getPack (the highest-precedence variant)", () => {
		const gRoot = packRoot("collapse-global", "artifacts");
		const pRoot = packRoot("collapse-project", "artifacts");
		w(path.join(gRoot, "pack.yaml"), "name: artifacts\n");
		w(path.join(gRoot, "panels", "g.yaml"), "id: global.panel\nentry: lib/g.js\n");
		w(path.join(pRoot, "pack.yaml"), "name: artifacts\n");
		w(path.join(pRoot, "panels", "p.yaml"), "id: project.panel\nentry: lib/p.js\n");
		assert.equal(packIdFromRoot(gRoot), "artifacts");
		assert.equal(packIdFromRoot(pRoot), "artifacts");
		// Enumerate low→high: global-user THEN project (project wins).
		const reg = new PackContributionRegistry(() => [
			entry(gRoot, "global-user", manifest("artifacts")),
			entry(pRoot, "project", manifest("artifacts")),
		]);
		const all = reg.list(undefined);
		assert.equal(all.filter((p) => p.packId === "artifacts").length, 1);
		const pack = reg.getPack(undefined, "artifacts")!;
		assert.deepEqual(pack.panels.map((p) => p.id), ["project.panel"]);
	});

	it("activation filtering: a disabled entrypoint is omitted; panels stay present", () => {
		const root = packRoot("act", "artifacts");
		w(path.join(root, "pack.yaml"), "name: artifacts\n");
		w(path.join(root, "panels", "v.yaml"), "id: artifacts.viewer\nentry: lib/v.js\n");
		w(path.join(root, "entrypoints", "artifacts-deeplink.yaml"), "id: artifacts.deeplink\nkind: route\nrouteId: artifacts\ntarget:\n  panelId: artifacts.viewer\nparamKeys: []\n");
		const m = manifest("artifacts", { entrypoints: ["artifacts-deeplink"] });
		// No activation override → entrypoint present.
		const enabled = new PackContributionRegistry(() => [entry(root, "server", m)]);
		assert.equal(enabled.getPack(undefined, "artifacts")!.entrypoints.length, 1);
		// Disable the entrypoint by listName → omitted; panel still present.
		const filtered = new PackContributionRegistry(
			() => [entry(root, "server", m)],
			(_scope, _pid, packName) => (packName === "artifacts" ? ["artifacts-deeplink"] : []),
		);
		const pack = filtered.getPack(undefined, "artifacts")!;
		assert.equal(pack.entrypoints.length, 0);
		assert.equal(pack.panels.length, 1);
	});

	it("activation filtering: a disabled provider is omitted and re-enabled by removing the ref", () => {
		const root = packRoot("act-provider", "memory-pack");
		w(path.join(root, "pack.yaml"), "name: memory-pack\n");
		w(path.join(root, "providers", "memory.yaml"), "id: memory\nmodule: ../lib/provider.js\nhooks: [beforePrompt]\n");
		w(path.join(root, "lib", "provider.js"), "export default {};\n");
		const m = manifest("memory-pack", { providers: ["memory"] });
		const enabled = new PackContributionRegistry(() => [entry(root, "server", m)]);
		assert.deepEqual(enabled.listProviders(undefined).map((p) => p.id), ["memory"]);

		const filtered = new PackContributionRegistry(
			() => [entry(root, "server", m)],
			undefined,
			(_scope, _pid, packName) => (packName === "memory-pack" ? ["memory"] : []),
		);
		assert.deepEqual(filtered.listProviders(undefined).map((p) => p.id), []);

		const restored = new PackContributionRegistry(() => [entry(root, "server", m)], undefined, () => []);
		assert.deepEqual(restored.listProviders(undefined).map((p) => p.id), ["memory"]);
		assert.equal(restored.getPack(undefined, "memory-pack")!.entrypoints.length, 0, "entrypoint filtering remains unchanged");
	});

	it("always-emit: an installed pack with no panels/entrypoints/routes still produces a list row", () => {
		const root = packRoot("empty", "bare");
		w(path.join(root, "pack.yaml"), "name: bare\n");
		const reg = new PackContributionRegistry(() => [entry(root, "server", manifest("bare"))]);
		const rows = reg.list(undefined);
		assert.equal(rows.length, 1);
		assert.deepEqual({ panels: rows[0].panels.length, entrypoints: rows[0].entrypoints.length, routes: rows[0].routes }, { panels: 0, entrypoints: 0, routes: undefined });
	});

	it("invalidate() drops the per-project cache", () => {
		const root = packRoot("inval", "p");
		w(path.join(root, "pack.yaml"), "name: p\n");
		let panels = true;
		if (panels) w(path.join(root, "panels", "a.yaml"), "id: a.panel\nentry: lib/a.js\n");
		const reg = new PackContributionRegistry(() => [entry(root, "server", manifest("p"))]);
		assert.equal(reg.getPack(undefined, "p")!.panels.length, 1);
		fs.rmSync(path.join(root, "panels", "a.yaml"));
		// Cached until invalidate().
		assert.equal(reg.getPack(undefined, "p")!.panels.length, 1);
		reg.invalidate();
		assert.equal(reg.getPack(undefined, "p")!.panels.length, 0);
	});
});
