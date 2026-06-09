/**
 * Unit tests for the Phase-1 CLIENT Host API `getHostApi` (src/app/host-api.ts)
 * under the durable v1 contract (design extension-host.md §3).
 *
 * Pins:
 *   - `host.capabilities` is the SINGLE SOURCE OF TRUTH: invokeAction +
 *     requestRender are true; `store` (B1) + `callRoute` (B3) are implemented +
 *     true; `session`/`ui` stay false until their namespaces flip live;
 *     `has(name)` mirrors the flags.
 *   - `version`/`contractVersion` are the frozen consts.
 *   - There is NO `gateway` member (escape hatch removed in v1).
 *   - The still-frozen Phase-2 stub (ui.navigate, until C1) throws "reserved for Phase 2".
 *
 * Pattern mirrors pack-renderers-reconcile.spec.ts: esbuild bundles the entry
 * once, a file:// fixture loads it, and we drive the helpers via window globals.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/client-host-api.html");
const BUNDLE = path.resolve("tests/fixtures/client-host-api-bundle.js");
const ENTRY = path.resolve("tests/fixtures/client-host-api-entry.ts");
const HOST_SRC = path.resolve("src/app/host-api.ts");
const SHARED_SRC = path.resolve("src/shared/extension-host/host-api.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(HOST_SRC).mtimeMs,
		fs.statSync(SHARED_SRC).mtimeMs,
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

test.describe("getHostApi — durable v1 capabilities (extension-host §3)", () => {
	test("capabilities reports Phase-1 caps true, Phase-2 caps false; no gateway member", async ({ page }) => {
		await gotoAndWait(page);
		const caps = await page.evaluate(() => (window as any).__caps());

		expect(caps.version).toBe(1);
		expect(caps.contractVersion).toBe(1);

		// Phase-1 — implemented.
		expect(caps.invokeAction).toBe(true);
		expect(caps.requestRender).toBe(true);
		expect(caps.hasInvokeAction).toBe(true);

		// Phase-2 — store (B1) + callRoute (B3) + session (B2 reads + C2 writes)
		// implemented; ui still frozen until C1.
		expect(caps.callRoute).toBe(true);
		expect(caps.session).toBe(true);
		expect(caps.ui).toBe(false);
		expect(caps.store).toBe(true);
		expect(caps.hasCallRoute).toBe(true);
		expect(caps.hasUnknown).toBe(false);

		// Escape hatch removed.
		expect(caps.hasGatewayMember).toBe(false);
	});

	test("every Phase-2 stub throws 'reserved for Phase 2'", async ({ page }) => {
		await gotoAndWait(page);
		// Slices B1/B2/B3 implemented store.* / session.read* / callRoute respectively
		// (they are NO LONGER "reserved for Phase 2" throwing stubs — store/callRoute
		// instead require a pack-served renderer context, and the `session` capability
		// flag stays false until C2 adds writes — capability-signaling convention). The
		// remaining members below are still frozen-not-implemented and must throw.
		const stubs = [
			"ui.navigate",
		];
		for (const which of stubs) {
			const msg = await page.evaluate((w) => (window as any).__callStub(w), which);
			expect(msg, `${which} must throw`).toBeTruthy();
			expect(msg).toContain("reserved for Phase 2");
		}
	});
});
