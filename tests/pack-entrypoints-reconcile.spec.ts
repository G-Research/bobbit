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
