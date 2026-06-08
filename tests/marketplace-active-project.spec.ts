/**
 * Unit test for the Wave-9B finding #2 fix: a marketplace mutation
 * (install/update/uninstall/reorder) re-drives pack-renderer registration scoped
 * to the ACTIVE CHAT SESSION's project (extension-host §4c) — NOT the
 * marketplace's focused/active *project* used for the install scope segment.
 *
 * The renderer registry is GLOBAL, so refreshing it for the marketplace's
 * focused project would clobber the renderers the still-active session uses, and
 * never reconcile back. This pins that `reconcileRenderersForActiveSession()`
 * fetches `/api/tools` scoped to the active session's project.
 *
 * Pattern mirrors pack-renderers-reconcile.spec.ts: esbuild bundles the entry
 * once, a file:// fixture loads it, and we drive the helper via window globals
 * with `window.fetch` stubbed to record request URLs.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/marketplace-active-project.html");
const BUNDLE = path.resolve("tests/fixtures/marketplace-active-project-bundle.js");
const ENTRY = path.resolve("tests/fixtures/marketplace-active-project-entry.ts");
const PAGE_SRC = path.resolve("src/app/marketplace-page.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(PAGE_SRC).mtimeMs);
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

test.describe("marketplace refresh scopes renderers to the active session (extension-host §4c)", () => {
	test("refresh fetches /api/tools for the ACTIVE SESSION's project, not the marketplace-focused/active project", async ({ page }) => {
		await gotoAndWait(page);

		// Active session is in project "sessionproj"; the active *project* (which a
		// project-scope install/uninstall would target) is a DIFFERENT "otherproj".
		const calls = await page.evaluate(async () => {
			(window as any).__setup({ sessionId: "s1", sessionProjectId: "sessionproj", activeProjectId: "otherproj" });
			(window as any).__clearCalls();
			await (window as any).__refresh();
			return { calls: (window as any).__calls(), pid: (window as any).__activeSessionProjectId() };
		});
		expect(calls.pid).toBe("sessionproj");
		expect(calls.calls.some((u: string) => /\/api\/tools\?projectId=sessionproj$/.test(u))).toBe(true);
		// Must NOT have refreshed for the marketplace's active/focused project.
		expect(calls.calls.some((u: string) => u.includes("projectId=otherproj"))).toBe(false);
	});

	test("falls back to the active project when there is no active session", async ({ page }) => {
		await gotoAndWait(page);

		const calls = await page.evaluate(async () => {
			(window as any).__setup({ sessionId: undefined, sessionProjectId: undefined, activeProjectId: "fallbackproj" });
			(window as any).__clearCalls();
			await (window as any).__refresh();
			return { calls: (window as any).__calls(), pid: (window as any).__activeSessionProjectId() };
		});
		expect(calls.pid).toBe("fallbackproj");
		expect(calls.calls.some((u: string) => /\/api\/tools\?projectId=fallbackproj$/.test(u))).toBe(true);
	});
});
