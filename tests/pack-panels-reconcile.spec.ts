/**
 * Unit tests for `reconcilePackPanelsForProject` + `openPackPanel`'s lazy panel
 * loader URL (pack schema V1 §8.1 — pack-scoped panels keyed by {packId, panelId}
 * + `host.ui.openPanel`; design pack-schema-v1-rationalisation.md). Pins the
 * generation-guarded, project-scoped, reload-safe pack-panel registry — the panel
 * analogue of pack-renderers-reconcile.spec.ts:
 *   - reconcile re-drives registration scoped to the active project (from
 *     /api/ext/contributions, NOT /api/tools); dedupes unchanged; swaps the panel
 *     loader's project scope on a project change;
 *   - an out-of-order late reconcile(A) response does NOT clobber B's registry;
 *   - an uninstall reconcile (empty packs) drops the panel so a later open
 *     no-ops (reconcile-on-uninstall, generation-guarded — no stale apply);
 *   - the loader serves the pack-addressed bearer-only
 *     GET /api/ext/packs/:packId/panels/:panelId endpoint via the host toolkit
 *     factory (no bare lit import).
 *
 * Pattern mirrors pack-renderers-reconcile.spec.ts: esbuild bundles the entry
 * once, a file:// fixture loads it, and we drive the helpers via window globals.
 * `window.fetch` is stubbed to record request URLs + serve fake metadata + a
 * fake panel module.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/pack-panels-reconcile.html");
const BUNDLE = path.resolve("tests/fixtures/pack-panels-reconcile-bundle.js");
const ENTRY = path.resolve("tests/fixtures/pack-panels-reconcile-entry.ts");
const PACK_SRC = path.resolve("src/app/pack-panels.ts");
const WORKSPACE_SRC = path.resolve("src/app/panel-workspace.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(PACK_SRC).mtimeMs,
		fs.statSync(WORKSPACE_SRC).mtimeMs,
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
}

test.describe("reconcilePackPanelsForProject (pack schema V1 §8.1)", () => {
	test("re-drives registration scoped to the active project; dedupes unchanged; swaps the loader on project change", async ({ page }) => {
		await gotoAndWait(page);

		// 1) Reconcile for project A → fetches /api/ext/contributions scoped to A.
		const callsA = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return (window as any).__calls();
		});
		expect(callsA.some((u: string) => /\/api\/ext\/contributions\?projectId=A$/.test(u))).toBe(true);

		// 2) A redundant reconcile for the SAME project is deduped — no re-fetch.
		const callsAgain = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return (window as any).__calls();
		});
		expect(callsAgain.some((u: string) => u.includes("/api/ext/contributions"))).toBe(false);

		// 3) Opening the panel serves the A-scoped pack-addressed bearer-only endpoint.
		const loadCallsA = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__open("demo.panel");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCallsA.some((u: string) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=A"))).toBe(true);

		// 4) Reconcile for a NEW project B → re-fetches metadata scoped to B.
		const callsB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("B");
			return (window as any).__calls();
		});
		expect(callsB.some((u: string) => /\/api\/ext\/contributions\?projectId=B$/.test(u))).toBe(true);

		// 5) The loader was invalidated on the project change — opening now fetches
		//    the B-scoped panel URL (the cached A module is dropped).
		const loadCallsB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__open("demo.panel");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCallsB.some((u: string) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=B"))).toBe(true);
		expect(loadCallsB.some((u: string) => u.includes("projectId=A"))).toBe(false);
	});

	test("out-of-order completion: a late reconcile(A) response does NOT clobber the registry already applied for B", async ({ page }) => {
		await gotoAndWait(page);

		const result = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__setContribDelay("A", 120);
			(window as any).__setContribDelay("B", 0);
			const pA = (window as any).__startReconcile("A"); // slow fetch
			const pB = (window as any).__startReconcile("B"); // fast fetch, resolves first
			await pB;
			await pA; // let the stale A response settle (must be a no-op)
			return true;
		});
		expect(result).toBe(true);

		// The panel loader must serve B's URL — A's late apply was dropped.
		const loadCalls = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__open("demo.panel");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCalls.some((u: string) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=B"))).toBe(true);
		expect(loadCalls.some((u: string) => u.includes("projectId=A"))).toBe(false);

		// dedupe is correct: a later reconcile(B) is skipped, but a NEW project C applies.
		const callsDedupeB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("B");
			return (window as any).__calls();
		});
		expect(callsDedupeB.some((u: string) => u.includes("/api/ext/contributions"))).toBe(false);

		const callsC = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("C");
			return (window as any).__calls();
		});
		expect(callsC.some((u: string) => /\/api\/ext\/contributions\?projectId=C$/.test(u))).toBe(true);
	});

	test("uninstall reconcile drops the panel — a later openPackPanel no-ops (no stale fetch)", async ({ page }) => {
		await gotoAndWait(page);

		// Install: reconcile for project A registers demo.panel.
		await page.evaluate(async () => { await (window as any).__reconcile("A"); });

		// Uninstall: the fresh metadata for A no longer declares any packs/panels. The
		// reconcile must drop demo.panel from the registry.
		await page.evaluate(async () => {
			(window as any).__setContributions([]);
			// Force a re-fetch for the SAME project by going A → D → A so the dedupe
			// guard does not skip the uninstall re-drive.
			await (window as any).__reconcile("D");
			await (window as any).__reconcile("A");
		});

		// Opening the now-uninstalled panel must NOT hit the panel endpoint.
		const calls = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__open("demo.panel");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(calls.some((u: string) => u.includes("/panels/"))).toBe(false);
	});
});
