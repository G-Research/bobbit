/**
 * Unit tests for the client pack-entrypoint registry — launcher surfaces +
 * deep-linkable client routes + `host.ui.navigate` resolution (pack schema V1
 * §8.2; design pack-schema-v1-rationalisation.md). Pins the generation-guarded,
 * project-scoped, reload-safe registry (the entrypoint analogue of
 * pack-renderers/pack-panels-reconcile.spec.ts), using a THIRD-PARTY pack fixture
 * (not the litmus packs) so the surface is proven reusable, not hardcoded:
 *   - reconcile re-drives registration scoped to the active project (from
 *     /api/ext/contributions, NOT /api/tools); dedupes;
 *   - `navigate(RouteTarget)` maps a STRUCTURED target → #/ext/<routeId>?<params>
 *     (params filtered to declared paramKeys; the pack never bakes a hash string);
 *   - getRouteFromHash parses #/ext/<routeId> back to a structured ext route;
 *   - reload restoration: a deep-link → lookupPackRoute → openPackPanel (serves
 *     the pack-addressed bearer-only /panels/ endpoint);
 *   - uninstall reconcile drops the route + launchers (a later navigate no-ops);
 *   - duplicate routeId across packs is rejected (lookupPackRoute undefined);
 *   - NO auto-invoke on mount (reconcile alone touches no panel endpoint + no hash).
 *
 * Pattern mirrors pack-panels-reconcile.spec.ts: esbuild bundles the entry once, a
 * file:// fixture loads it, helpers are driven via window globals; window.fetch is
 * stubbed to record request URLs + serve fake metadata + a fake panel module.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/pack-entrypoints-reconcile.html");
const BUNDLE = path.resolve("tests/fixtures/pack-entrypoints-reconcile-bundle.js");
const ENTRY = path.resolve("tests/fixtures/pack-entrypoints-reconcile-entry.ts");
const PACK_SRC = path.resolve("src/app/pack-entrypoints.ts");
const ROUTING_SRC = path.resolve("src/app/routing.ts");
const PANELS_SRC = path.resolve("src/app/pack-panels.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(PACK_SRC).mtimeMs,
		fs.statSync(ROUTING_SRC).mtimeMs,
		fs.statSync(PANELS_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__clearHash());
}

test.describe("pack-entrypoints registry (pack schema V1 §8.2)", () => {
	test("reconcile scopes to the project + dedupes; NO auto-invoke on mount", async ({ page }) => {
		await gotoAndWait(page);

		// Reconcile for A fetches /api/ext/contributions scoped to A — and touches NO
		// /panels/ endpoint and sets NO hash (no auto-invoke/navigation on mount).
		const res = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return { calls: (window as any).__calls(), hash: (window as any).__hash() };
		});
		expect(res.calls.some((u: string) => /\/api\/ext\/contributions\?projectId=A$/.test(u))).toBe(true);
		expect(res.calls.some((u: string) => u.includes("/panels/"))).toBe(false);
		expect(res.hash).toBe("");

		// Redundant reconcile for the SAME project is deduped — no re-fetch.
		const again = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return (window as any).__calls();
		});
		expect(again.some((u: string) => u.includes("/api/ext/contributions"))).toBe(false);
	});

	test("lookupPackRoute resolves a third-party routeId after registration", async ({ page }) => {
		await gotoAndWait(page);
		const entry = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			return (window as any).__lookup("thirdparty.route");
		});
		expect(entry).not.toBeNull();
		expect(entry.targetPanelId).toBe("thirdparty.viewer");
		expect(entry.paramKeys).toEqual(["itemId"]);
		expect(entry.packId).toBe("thirdparty_pack");
	});

	test("navigate(RouteTarget) maps to #/ext/<routeId>?<params> (paramKeys-filtered; no baked URL) + getRouteFromHash parses it back", async ({ page }) => {
		await gotoAndWait(page);
		const out = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			// junk is NOT a declared paramKey — it must be filtered out.
			(window as any).__navigate("thirdparty.route", { itemId: "abc123", junk: "drop" });
			return { hash: (window as any).__hash(), route: (window as any).__route() };
		});
		expect(out.hash).toBe("#/ext/thirdparty.route?itemId=abc123");
		expect(out.route.view).toBe("ext");
		expect(out.route.extRouteId).toBe("thirdparty.route");
		expect(out.route.extParams).toEqual({ itemId: "abc123" });
	});

	test("reload restoration: a #/ext/<routeId> deep-link parses + resolves through the registry to its target panel", async ({ page }) => {
		await gotoAndWait(page);
		const out = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			// Simulate a cold-load deep-link hash and parse it (the routing layer).
			(window as any).__setHash("#/ext/thirdparty.route?itemId=xyz");
			const route = (window as any).__route();
			// The app route handler does: lookupPackRoute(route.extRouteId) → openPackPanel.
			const entry = (window as any).__lookup(route.extRouteId);
			return { view: route.view, extParams: route.extParams, targetPanelId: entry?.targetPanelId, paramKeys: entry?.paramKeys };
		});
		expect(out.view).toBe("ext");
		expect(out.extParams).toEqual({ itemId: "xyz" });
		expect(out.targetPanelId).toBe("thirdparty.viewer");
		expect(out.paramKeys).toEqual(["itemId"]);
	});

	test("launcher dispatch: a panel launcher opens the panel; a route launcher deep-links (user gesture only)", async ({ page }) => {
		await gotoAndWait(page);

		// Panel-target launcher → openPackPanel → /panels/ fetch (the panel is registered
		// in the separate pack-panel registry; the launcher's packId scopes the lookup).
		const panelCalls = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			(window as any).__registerPanel("A");
			(window as any).__clearCalls();
			(window as any).__runLauncher("tp.slash");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(panelCalls.some((u: string) => u.includes("/api/ext/packs/thirdparty_pack/panels/thirdparty.viewer"))).toBe(true);

		// Route-target launcher → navigate → #/ext hash.
		const hash = await page.evaluate(async () => {
			(window as any).__clearHash();
			(window as any).__runLauncher("tp.navlaunch");
			return (window as any).__hash();
		});
		expect(hash).toBe("#/ext/thirdparty.route");

		// All launcher kinds register + enumerate (composer-slash/git-widget/command-palette).
		const launchers = await page.evaluate(() => ({
			slash: (window as any).__launchers("composer-slash"),
			git: (window as any).__launchers("git-widget-button"),
			palette: (window as any).__launchers("command-palette"),
		}));
		expect(launchers.slash).toContain("tp.slash");
		expect(launchers.git).toContain("tp.gitbtn");
		expect(launchers.palette).toContain("tp.navlaunch");
	});

	test("uninstall reconcile drops the route + launchers (a later navigate no-ops; no hash, no panel fetch)", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(async () => { await (window as any).__reconcile("A"); });

		// Uninstall: fresh metadata for A declares no packs/entrypoints. Force a
		// re-fetch (A→D→A) so the dedupe guard does not skip the uninstall re-drive.
		await page.evaluate(async () => {
			(window as any).__setContributions([]);
			await (window as any).__reconcile("D");
			await (window as any).__reconcile("A");
		});

		const out = await page.evaluate(async () => {
			(window as any).__clearHash();
			(window as any).__clearCalls();
			const before = (window as any).__lookup("thirdparty.route");
			(window as any).__navigate("thirdparty.route", { itemId: "x" });
			await (window as any).__flush();
			return { before, hash: (window as any).__hash(), calls: (window as any).__calls(), launchers: (window as any).__launchers() };
		});
		expect(out.before).toBeNull();
		expect(out.hash).toBe("");
		expect(out.calls.some((u: string) => u.includes("/panels/"))).toBe(false);
		expect(out.launchers).toEqual([]);
	});

	test("two packs declaring the SAME launcher id are BOTH addressable by their compound key (no collision)", async ({ page }) => {
		await gotoAndWait(page);

		// pack_a + pack_b each declare a `command-palette` launcher with the SAME id
		// "open" targeting their OWN panel — panel/entrypoint ids are pack-local.
		const entries = await page.evaluate(async () => {
			(window as any).__setContributions([
				{ packId: "pack_a", packName: "pack_a", panels: [{ id: "viewer" }], routeNames: [], entrypoints: [{ id: "open", kind: "command-palette", label: "Open A", target: { panelId: "viewer" }, listName: "open" }] },
				{ packId: "pack_b", packName: "pack_b", panels: [{ id: "viewer" }], routeNames: [], entrypoints: [{ id: "open", kind: "command-palette", label: "Open B", target: { panelId: "viewer" }, listName: "open" }] },
			]);
			await (window as any).__reconcile("COLLIDE");
			// Register both packs' panels together so a panel-target launcher resolves +
			// fetches (registerPackPanels replaces the whole registry per call).
			(window as any).__registerPanels([
				{ packId: "pack_a", panelId: "viewer" },
				{ packId: "pack_b", panelId: "viewer" },
			], "COLLIDE");
			return (window as any).__launcherEntries("command-palette");
		});
		// BOTH launchers survive — neither overwrote the other.
		expect(entries.length).toBe(2);
		const keys = entries.map((e: any) => e.key).sort();
		const keyA = await page.evaluate(() => (window as any).__launcherKey("pack_a", "open"));
		const keyB = await page.evaluate(() => (window as any).__launcherKey("pack_b", "open"));
		expect(keys).toEqual([keyA, keyB].sort());

		// Running pack_a's launcher by its compound key opens pack_a's panel.
		const aCalls = await page.evaluate(async (key: string) => {
			(window as any).__clearCalls();
			(window as any).__runLauncher(key);
			await (window as any).__flush();
			return (window as any).__calls();
		}, keyA);
		expect(aCalls.some((u: string) => u.includes("/api/ext/packs/pack_a/panels/viewer"))).toBe(true);
		expect(aCalls.some((u: string) => u.includes("/api/ext/packs/pack_b/panels/viewer"))).toBe(false);

		// Running pack_b's launcher by its compound key opens pack_b's panel.
		const bCalls = await page.evaluate(async (key: string) => {
			(window as any).__clearCalls();
			(window as any).__runLauncher(key);
			await (window as any).__flush();
			return (window as any).__calls();
		}, keyB);
		expect(bCalls.some((u: string) => u.includes("/api/ext/packs/pack_b/panels/viewer"))).toBe(true);
		expect(bCalls.some((u: string) => u.includes("/api/ext/packs/pack_a/panels/viewer"))).toBe(false);
	});

	// ── T-1 / T-10 — SPAWN launcher dispatch (design pr-walkthrough-launch-ux.md §3). ──
	// A spawn launcher ({action:"spawn", route, panelId}) calls its pack `route` via the
	// launcher-bound Host API and, on ok:true, opens the returned child's panel
	// (auto-switching). It carries a `panelId` like a PanelTarget, so the `action`-first
	// detection must keep it OFF the openPackPanel path; the within-gesture guard must
	// suppress a re-entrant double-click.

	test("T-10 — a SpawnLaunchTarget survives registration + enumeration (registered as a launcher)", async ({ page }) => {
		await gotoAndWait(page);
		const ids = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			return (window as any).__launchers("git-widget-button");
		});
		// The spawn launcher is registered alongside the panel-target git-widget launcher.
		expect(ids).toContain("tp.spawn");
		expect(ids).toContain("tp.gitbtn");
	});

	test("T-1 — spawn launcher calls `run`, opens the panel in the returned child, mounts NO owner panel", async ({ page }) => {
		await gotoAndWait(page);
		const out = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			(window as any).__registerPanel("A"); // register thirdparty.viewer (the owner-mount fetch path)
			(window as any).__installLauncherHost("ok");
			(window as any).__clearCalls();
			const result = await (window as any).__runSpawn("tp.spawn");
			await (window as any).__flush();
			return {
				result,
				callRoute: (window as any).__callRouteCalls(),
				openPanel: (window as any).__openPanelCalls(),
				fetches: (window as any).__calls(),
			};
		});
		// `run` was called exactly once on the launcher's pack/contribution surface.
		expect(out.callRoute).toHaveLength(1);
		expect(out.callRoute[0].route).toBe("run");
		// On ok:true the panel is opened IN THE CHILD session (auto-switch), exactly once.
		expect(out.openPanel).toEqual([{ panelId: "thirdparty.viewer", sessionId: "c1" }]);
		expect(out.result).toEqual({ ok: true });
		// NO owner-session panel was mounted: openPackPanel (which fetches the pack-addressed
		// /panels/ module) was never reached — the spawn path uses host.ui.openPanel only.
		expect(out.fetches.some((u: string) => u.includes("/panels/"))).toBe(false);
	});

	test("T-1 — a NO_PR (ok:false) result flows back through onResult; no panel opens", async ({ page }) => {
		await gotoAndWait(page);
		const out = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			(window as any).__installLauncherHost("nopr");
			const result = await (window as any).__runSpawn("tp.spawn");
			await (window as any).__flush();
			return { result, openPanel: (window as any).__openPanelCalls() };
		});
		expect(out.result.ok).toBe(false);
		expect(out.result.code).toBe("NO_PR");
		expect(out.result.error).toMatch(/No open GitHub PR/i);
		// Nothing opened / no view switch on failure.
		expect(out.openPanel).toEqual([]);
	});

	test("T-1 — a throwing callRoute surfaces the error via onResult; no panel opens", async ({ page }) => {
		await gotoAndWait(page);
		const out = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			(window as any).__installLauncherHost("throw");
			const result = await (window as any).__runSpawn("tp.spawn");
			return { result, openPanel: (window as any).__openPanelCalls() };
		});
		expect(out.result.ok).toBe(false);
		expect(out.result.error).toMatch(/boom/);
		expect(out.openPanel).toEqual([]);
	});

	test("T-10 — the within-gesture guard suppresses a re-entrant second click (only one `run`)", async ({ page }) => {
		await gotoAndWait(page);
		const callRoute = await page.evaluate(async () => {
			await (window as any).__reconcile("A");
			// A never-resolving `run` keeps the first dispatch in-flight, so the guard for
			// the launcher key is still held when the second synchronous click fires.
			(window as any).__installLauncherHost("hang");
			(window as any).__runSpawnTwiceSync("tp.spawn");
			await (window as any).__flush();
			return (window as any).__callRouteCalls();
		});
		// Two synchronous clicks → exactly ONE callRoute (the second is the no-op guard).
		expect(callRoute).toHaveLength(1);
		expect(callRoute[0].route).toBe("run");
	});

	test("duplicate routeId across packs is rejected — registered by NEITHER (lookupPackRoute undefined)", async ({ page }) => {
		await gotoAndWait(page);
		const entry = await page.evaluate(async () => {
			(window as any).__setContributions([
				{ packId: "pack_a", packName: "pack_a", panels: [], routeNames: [], entrypoints: [{ id: "a.route", kind: "route", routeId: "dup.route", target: { panelId: "a.viewer" }, paramKeys: [], listName: "a-route" }] },
				{ packId: "pack_b", packName: "pack_b", panels: [], routeNames: [], entrypoints: [{ id: "b.route", kind: "route", routeId: "dup.route", target: { panelId: "b.viewer" }, paramKeys: [], listName: "b-route" }] },
			]);
			// Force a fresh project so the reconcile applies the new metadata.
			await (window as any).__reconcile("DUP");
			return (window as any).__lookup("dup.route");
		});
		expect(entry).toBeNull();
	});
});
