/**
 * Focused render test for the P3 managed-runtime consent enable-card (modes/
 * consent design §8) and the master-toggle counting that must include the
 * schema-v2 activation arrays.
 *
 * Proves, in isolation (no server / no Docker / no module state):
 *   (1) managed mode discloses services, loopback ports, the data/volume path and
 *       the memory/trust copy BEFORE enabling;
 *   (2) external mode shows the no-Docker setup guidance (never a Docker card);
 *   (3) with no capability summary the card still renders static fallback copy
 *       (services/ports/volume defaults + the memory disclosure);
 *   (4) the activation total/enabled counts include `runtimes` (+ the other
 *       schema-v2 arrays) so the master toggle reflects a managed runtime, and a
 *       disabled runtime drops the enabled count.
 *
 * Pattern mirrors tests/marketplace-active-project.spec.ts: esbuild bundles the
 * entry once, a file:// fixture loads it, assertions run via window globals.
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

const FIXTURE = path.resolve("tests/fixtures/marketplace-runtime-consent.html");
const BUNDLE = path.resolve("tests/fixtures/marketplace-runtime-consent-bundle.js");
const ENTRY = path.resolve("tests/fixtures/marketplace-runtime-consent-entry.ts");
const PAGE_SRC = path.resolve("src/app/marketplace-page.ts");

test.setTimeout(30_000);

test.beforeAll(async () => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(PAGE_SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
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
			`Timed out waiting for runtime-consent fixture readiness: ${err}`,
			`window.__ready: ${String(diagnostics.ready)}`,
			`body: ${diagnostics.bodyText}`,
			`console: ${consoleMessages.slice(-20).join("\n") || "<none>"}`,
			`pageerror: ${pageErrors.slice(-20).join("\n") || "<none>"}`,
		].join("\n"));
	}
}

test.describe("managed-runtime consent enable-card (P3 design §8)", () => {
	test("managed mode discloses services, ports, volume path and memory/trust copy", async ({ page }) => {
		await gotoAndWait(page);
		const html = await page.evaluate(() =>
			(window as any).__renderCard("hindsight", {
				packId: "hindsight",
				runtimeId: "hindsight",
				mode: "managed-postgres",
				services: ["api", "web", "db"],
				ports: [{ label: "API", host: 41827, container: 8000 }, { label: "Web", host: 41828, container: 3000 }],
				volumePath: "/home/dev/.hindsight",
				dockerRequired: true,
			}) as string,
		);
		// Discloses what enabling does, BEFORE the runtime starts.
		expect(html).toContain("market-runtime-services");
		expect(html).toContain("api, web, db");
		expect(html).toContain("127.0.0.1:41827");
		expect(html).toContain("/home/dev/.hindsight");
		// Memory/trust copy (no server-provided trust → static disclosure).
		const trust = await page.locator('[data-testid="market-runtime-trust"]').innerText();
		expect(trust.toLowerCase()).toContain("memory");
		// It must NOT be the external (no-Docker) card.
		await expect(page.locator('[data-testid="market-runtime-external-guidance"]')).toHaveCount(0);
	});

	test("external mode shows no-Docker setup guidance, not a Docker disclosure", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() =>
			(window as any).__renderCard("hindsight", {
				packId: "hindsight",
				runtimeId: "hindsight",
				mode: "external",
				services: [],
				ports: [],
				dockerRequired: false,
			}),
		);
		const guidance = page.locator('[data-testid="market-runtime-external-guidance"]');
		await expect(guidance).toHaveCount(1);
		expect((await guidance.innerText()).toLowerCase()).toContain("does not run docker");
		// No Docker services/ports disclosure in external mode.
		await expect(page.locator('[data-testid="market-runtime-services"]')).toHaveCount(0);
	});

	test("missing capability summary falls back to static disclosure copy", async ({ page }) => {
		await gotoAndWait(page);
		const html = await page.evaluate(() => (window as any).__renderCard("hindsight", null) as string);
		// Defaults so the consent surface is never blank.
		expect(html).toContain("api, web, db");
		expect(html).toContain("~/.hindsight");
		const trust = await page.locator('[data-testid="market-runtime-trust"]').innerText();
		expect(trust.toLowerCase()).toContain("memory");
	});

	test("master-toggle counts include the schema-v2 arrays (runtimes)", async ({ page }) => {
		await gotoAndWait(page);
		const counts = await page.evaluate(() => {
			const activation = {
				scope: "server",
				packName: "hindsight",
				catalogue: {
					roles: [],
					tools: ["recall"],
					skills: [],
					entrypoints: [],
					providers: ["memory"],
					runtimes: ["hindsight"],
				},
				disabled: { runtimes: ["hindsight"] },
			};
			return { total: (window as any).__total(activation), enabled: (window as any).__enabled(activation) };
		});
		// tool + provider + runtime = 3 toggleable entities.
		expect(counts.total).toBe(3);
		// The runtime is disabled → only the tool + provider remain enabled.
		expect(counts.enabled).toBe(2);
	});
});
