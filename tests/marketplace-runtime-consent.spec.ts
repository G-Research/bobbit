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
				ports: [{ key: "HINDSIGHT_API_PORT", env: "HINDSIGHT_API_PORT", host: 41827, container: 8000 }, { key: "HINDSIGHT_WEB_PORT", env: "HINDSIGHT_WEB_PORT", host: 41828, container: 3000 }],
				volumePath: "/home/dev/.hindsight",
				dockerRequired: true,
			}) as string,
		);
		// Discloses what enabling does, BEFORE the runtime starts.
		expect(html).toContain("market-runtime-services");
		expect(html).toContain("api, web, db");
		// An allocated host port renders as a loopback URL.
		expect(html).toContain("127.0.0.1:41827");
		expect(html).toContain("/home/dev/.hindsight");
		// Memory/trust copy (no server-provided trust → static disclosure).
		const trust = await page.locator('[data-testid="market-runtime-trust"]').innerText();
		expect(trust.toLowerCase()).toContain("memory");
		// It must NOT be the external (no-Docker) card.
		await expect(page.locator('[data-testid="market-runtime-external-guidance"]')).toHaveCount(0);
	});

	test("unallocated host port shows 'allocated on enable', never a loopback URL on the container port", async ({ page }) => {
		// REGRESSION: the card previously fell back to `127.0.0.1:<container>` when no
		// host port was persisted, implying a loopback bind that does not exist yet. The
		// server only fills `host` once a stable port is allocated; `container` is
		// informational. With host absent, the card must disclose the host port is
		// allocated on enable — and must NOT render a loopback URL on the container port.
		await gotoAndWait(page);
		const ports = await page.evaluate(() => {
			(window as any).__renderCard("hindsight", {
				packId: "hindsight",
				runtimeId: "hindsight",
				mode: "managed-postgres",
				services: ["api", "web", "db"],
				ports: [{ key: "HINDSIGHT_API_PORT", env: "HINDSIGHT_API_PORT", container: 8000 }],
				dockerRequired: true,
			});
			return document.querySelector('[data-testid="market-runtime-ports"]')?.textContent ?? "";
		});
		expect(ports.toLowerCase()).toContain("allocated on enable");
		// The container port may be shown for context, but never as a loopback URL.
		expect(ports).not.toContain("127.0.0.1:8000");
		expect(ports).not.toContain("127.0.0.1:?");
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
		expect(html).toContain("api, db");
		expect(html).toContain("~/.hindsight");
		const trust = await page.locator('[data-testid="market-runtime-trust"]').innerText();
		expect(trust.toLowerCase()).toContain("memory");
	});

	test("capability fetch addresses the STRUCTURAL pack id, not the manifest name (finding #3)", async ({ page }) => {
		await gotoAndWait(page);
		const ids = await page.evaluate(() => ({
			// A built-in pack whose shipped directory (structural id) differs from its
			// manifest name: the runtime REST routes key by the structural id, so the UI
			// must send `packId`, not `packName`.
			divergent: (window as any).__restPackId({ packId: "hindsight-memory", packName: "Hindsight Memory" }),
			// Older server omits `packId` → fall back to `packName` (they coincide for
			// installed packs).
			fallback: (window as any).__restPackId({ packName: "hindsight" }),
		}));
		expect(ids.divergent).toBe("hindsight-memory");
		expect(ids.fallback).toBe("hindsight");
	});

	test("capability cache key includes the scoped projectId so a project-focus switch refetches (finding #2)", async ({ page }) => {
		await gotoAndWait(page);
		const keys = await page.evaluate(() => ({
			projA: (window as any).__capKey("project", "hindsight", "hindsight", "projA"),
			projB: (window as any).__capKey("project", "hindsight", "hindsight", "projB"),
			server: (window as any).__capKey("server", "hindsight", "hindsight", undefined),
			// The key tracks the STRUCTURAL pack id, matching what the fetch addressed.
			structural: (window as any).__capKey("server", "hindsight-memory", "hindsight", undefined),
		}));
		// Two project scopes ⇒ DISTINCT keys (no stale disclosure reuse across focus).
		expect(keys.projA).not.toBe(keys.projB);
		expect(keys.projA).toContain("projA");
		expect(keys.projB).toContain("projB");
		// Server scope carries an empty projectId segment.
		expect(keys.server.endsWith(":")).toBe(true);
		// Structural pack id participates in the key.
		expect(keys.structural).toContain("hindsight-memory");
	});

	test("consent disclosure refetches after the server deployment mode changes (finding #1: no stale consent before enable)", async ({ page }) => {
		// REGRESSION: the capability cache is keyed by scope/packId/runtimeId/projectId
		// but NOT by deployment mode/config revision. If the user changes the Hindsight
		// deployment mode (external → managed) in the panel and returns to the
		// marketplace, the stale `external` disclosure must NOT be shown right before the
		// enable toggle. A marketplace (re)load invalidates the cache so the consent card
		// refetches and shows the CURRENT (managed) disclosure.
		await gotoAndWait(page);

		// 1. Server is in external mode. Prime the cache and render the consent card:
		//    it must show the no-Docker external guidance.
		await page.evaluate(() => (window as any).__ensureCaps());
		await page.waitForFunction(() => ((window as any).__consentHtml() as string).includes("market-runtime-external-guidance"), null, { timeout: 5_000 });
		const fetchesAfterExternal = await page.evaluate(() => (window as any).__capabilityFetches() as number);
		expect(fetchesAfterExternal).toBeGreaterThanOrEqual(1);

		// 2. The user switches the deployment mode to managed elsewhere (panel writes the
		//    provider config). WITHOUT invalidation the cached external card would persist.
		await page.evaluate(() => (window as any).__setServerMode("managed"));
		const stillExternal = await page.evaluate(() => (window as any).__consentHtml() as string);
		expect(stillExternal).toContain("market-runtime-external-guidance");

		// 3. Returning to the marketplace invalidates the cache (loadMarketplaceData calls
		//    invalidateRuntimeCapabilities). The consent card now refetches and shows the
		//    managed Docker disclosure — matching current server config BEFORE enable.
		await page.evaluate(() => { (window as any).__invalidateCaps(); (window as any).__ensureCaps(); });
		// "api, web, db" only appears in the FETCHED managed disclosure — the static
		// cache-miss fallback uses "api, db", so this proves the refetched summary is
		// shown, not a fallback card.
		await page.waitForFunction(() => {
			const html = (window as any).__consentHtml() as string;
			return html.includes("api, web, db") && !html.includes("market-runtime-external-guidance");
		}, null, { timeout: 5_000 });
		const managedHtml = await page.evaluate(() => (window as any).__consentHtml() as string);
		expect(managedHtml).toContain("api, web, db");
		expect(managedHtml).toContain("/managed/data/path");
		// A genuine refetch happened (not stale-served): the fetch count advanced.
		const fetchesAfterManaged = await page.evaluate(() => (window as any).__capabilityFetches() as number);
		expect(fetchesAfterManaged).toBeGreaterThan(fetchesAfterExternal);
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

	test("runtime activation ROW renders the on-enable toggle + consent card together", async ({ page }) => {
		await gotoAndWait(page);
		const rowHtml = await page.evaluate(() => (window as any).__renderRuntimeRow("hindsight", true) as string);
		// The row wrapper, the explicit on-enable toggle, and the consent card must
		// all render from the ONE production path (renderRuntimeRow) — this is the
		// activation UI the Marketplace actually mounts, not just the card in
		// isolation.
		expect(rowHtml).toContain('data-testid="market-runtime-hindsight"');
		expect(rowHtml).toContain('data-testid="market-toggle-runtime-hindsight"');
		expect(rowHtml).toContain('data-testid="market-runtime-card-hindsight"');
		// Disabled state renders the off styling on the toggle label.
		const offHtml = await page.evaluate(() => (window as any).__renderRuntimeRow("hindsight", false) as string);
		expect(offHtml).toContain("market-activation-toggle--off");
	});

	test("master enable/disable-all payload covers the schema-v2 arrays (runtimes)", async ({ page }) => {
		await gotoAndWait(page);
		const payloads = await page.evaluate(() => {
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
				disabled: {},
			};
			return {
				off: (window as any).__masterToggle(activation, false) as Record<string, unknown>,
				on: (window as any).__masterToggle(activation, true) as Record<string, unknown>,
			};
		});
		// Master OFF must disable the managed runtime (and the other schema-v2
		// kinds) — otherwise the pack reads "Disabled" while Docker keeps running.
		expect(payloads.off.runtimes).toEqual(["hindsight"]);
		expect(payloads.off.providers).toEqual(["memory"]);
		expect(payloads.off.tools).toEqual(["recall"]);
		// hooks/workflows are never in the payload (finding EXT-03): neither is
		// activation-toggleable, so the master toggle must not resurrect them.
		expect(payloads.off.hooks).toBeUndefined();
		expect(payloads.off.workflows).toBeUndefined();
		// Master ON clears every kind back to default-enabled.
		expect(payloads.on.runtimes).toEqual([]);
		expect(payloads.on.providers).toEqual([]);
		expect(payloads.on.hooks).toBeUndefined();
		expect(payloads.on.workflows).toBeUndefined();
	});
});
