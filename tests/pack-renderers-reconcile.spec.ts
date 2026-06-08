/**
 * Unit tests for `reconcilePackRenderersForProject` + the per-tool renderer
 * loader URL (extension-host §4a/§4c — pack-renderer registration follows the
 * ACTIVE session's project).
 *
 * Pins the Wave-8 [HIGH] fix: a reload / deep-link / session-switch into a
 * session whose project differs from the boot active/default must re-drive
 * pack-renderer registration for THAT project, and the lazy loader (which closes
 * over `projectId`) must be swapped so it serves the NEW project's renderer.
 *
 * Pattern mirrors lazy-renderer-placeholder.spec.ts: esbuild bundles the entry
 * once, a file:// fixture loads it, and we drive the helpers via window globals.
 * `window.fetch` is stubbed to record request URLs + serve fake metadata.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/pack-renderers-reconcile.html");
const BUNDLE = path.resolve("tests/fixtures/pack-renderers-reconcile-bundle.js");
const ENTRY = path.resolve("tests/fixtures/pack-renderers-reconcile-entry.ts");
const PACK_SRC = path.resolve("src/app/pack-renderers.ts");
const REGISTRY_SRC = path.resolve("src/ui/tools/renderer-registry.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(PACK_SRC).mtimeMs,
		fs.statSync(REGISTRY_SRC).mtimeMs,
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

test.describe("reconcilePackRenderersForProject (extension-host §4a/§4c)", () => {
	test("re-drives registration scoped to the active session's project; dedupes unchanged; swaps the loader on project change", async ({ page }) => {
		await gotoAndWait(page);

		// 1) Reconcile for project A → fetches /api/tools scoped to A.
		const callsA = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return (window as any).__calls();
		});
		expect(callsA.some((u: string) => /\/api\/tools\?projectId=A$/.test(u))).toBe(true);

		// 2) A redundant reconcile for the SAME project is deduped — no re-fetch.
		const callsAgain = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("A");
			return (window as any).__calls();
		});
		expect(callsAgain.some((u: string) => u.includes("/api/tools"))).toBe(false);

		// 3) The loader for project A serves the A-scoped renderer URL.
		const loadCallsA = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__triggerLoad("demo_pack_tool");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCallsA.some((u: string) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=A"))).toBe(true);

		// 4) Reconcile for a NEW project B → re-fetches metadata scoped to B.
		const callsB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("B");
			return (window as any).__calls();
		});
		expect(callsB.some((u: string) => /\/api\/tools\?projectId=B$/.test(u))).toBe(true);

		// 5) The loader was SWAPPED — triggering a load now fetches the B-scoped
		//    renderer URL (the loader no longer closes over the stale project A).
		const loadCallsB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__triggerLoad("demo_pack_tool");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCallsB.some((u: string) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=B"))).toBe(true);
		expect(loadCallsB.some((u: string) => u.includes("projectId=A"))).toBe(false);
	});

	test("out-of-order completion: a late reconcile(A) response does NOT clobber the registry already applied for B", async ({ page }) => {
		await gotoAndWait(page);

		// reconcile(A) has a SLOW metadata fetch; reconcile(B) is fast. Start A
		// first, then B; B's response lands first and applies, then A's late
		// response must be DROPPED (superseded by the newer generation) — the
		// registry must end on B's loaders, not A's.
		const result = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__setToolsDelay("A", 120);
			(window as any).__setToolsDelay("B", 0);
			const pA = (window as any).__startReconcile("A"); // slow fetch
			const pB = (window as any).__startReconcile("B"); // fast fetch, resolves first
			await pB;
			await pA; // let the stale A response settle (must be a no-op)
			return true;
		});
		expect(result).toBe(true);

		// The active loader must serve B's renderer — A's late apply was dropped.
		const loadCalls = await page.evaluate(async () => {
			(window as any).__clearCalls();
			(window as any).__triggerLoad("demo_pack_tool");
			await (window as any).__flush();
			return (window as any).__calls();
		});
		expect(loadCalls.some((u: string) => u.includes("/api/tools/demo_pack_tool/renderer?projectId=B"))).toBe(true);
		expect(loadCalls.some((u: string) => u.includes("projectId=A"))).toBe(false);

		// dedupe is correct: a later reconcile(B) is skipped (B successfully
		// applied), but a reconcile to a NEW project C still applies.
		const callsDedupeB = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("B");
			return (window as any).__calls();
		});
		expect(callsDedupeB.some((u: string) => u.includes("/api/tools"))).toBe(false);

		const callsC = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile("C");
			return (window as any).__calls();
		});
		expect(callsC.some((u: string) => /\/api\/tools\?projectId=C$/.test(u))).toBe(true);
	});
});
