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
import { test, expect, type Page } from "@playwright/test";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

async function renameWithRetry(src: string, dest: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			fs.renameSync(src, dest);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw lastErr;
}

const FIXTURE = path.resolve("tests/fixtures/marketplace-active-project.html");
const BUNDLE = path.resolve("tests/fixtures/marketplace-active-project-bundle.js");
const ENTRY = path.resolve("tests/fixtures/marketplace-active-project-entry.ts");
const PAGE_SRC = path.resolve("src/app/marketplace-page.ts");

test.setTimeout(30_000);

test.beforeAll(async () => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(PAGE_SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		// With fullyParallel enabled, both tests in this file may run in separate
		// workers and rebuild the shared fixture bundle at the same time. esbuild's
		// direct outfile write is not atomic, so a sibling page can load a partial
		// bundle and wait forever for `window.__ready`. Build to a unique temp path,
		// then atomically replace the shared bundle.
		const tmpDir = fs.mkdtempSync(path.join(path.dirname(BUNDLE), ".bundle-tmp-"));
		const tmpOut = path.join(tmpDir, path.basename(BUNDLE));
		try {
			await esbuild.build({
				entryPoints: [ENTRY],
				bundle: true,
				format: "iife",
				target: "es2022",
				outfile: tmpOut,
				tsconfig: "tsconfig.web.json",
				alias: { "pdfjs-dist": "./tests/fixtures/empty-shim" },
				define: { "import.meta.url": '"http://localhost/"' },
				loader: { ".ts": "ts" },
			});
			await renameWithRetry(tmpOut, BUNDLE);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
		}
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: Page) {
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
	page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));

	await page.goto(PAGE);
	try {
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 20_000 });
	} catch (err) {
		const diagnostics = await page.evaluate(() => ({
			ready: (window as any).__ready,
			bodyText: document.body?.innerText?.slice(0, 500) ?? "",
		})).catch((evalErr) => ({ ready: undefined, bodyText: `diagnostic evaluate failed: ${evalErr}` }));
		throw new Error([
			`Timed out waiting for marketplace fixture readiness: ${err}`,
			`window.__ready: ${String(diagnostics.ready)}`,
			`body: ${diagnostics.bodyText}`,
			`console: ${consoleMessages.slice(-20).join("\n") || "<none>"}`,
			`pageerror: ${pageErrors.slice(-20).join("\n") || "<none>"}`,
		].join("\n"));
	}
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
