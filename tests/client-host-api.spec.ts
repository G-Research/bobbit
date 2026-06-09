/**
 * Unit tests for the Phase-1 CLIENT Host API `getHostApi` (src/app/host-api.ts)
 * under the durable v1 contract (design extension-host.md §3).
 *
 * Pins:
 *   - `host.capabilities` is the SINGLE SOURCE OF TRUTH: invokeAction +
 *     requestRender are true; the Phase-2 caps (callRoute/session/ui/store) are
 *     false; `has(name)` mirrors the flags.
 *   - `version`/`contractVersion` are the frozen consts.
 *   - There is NO `gateway` member (escape hatch removed in v1).
 *   - Every Phase-2 stub throws "reserved for Phase 2".
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

		// Phase-2 — frozen, not implemented.
		expect(caps.callRoute).toBe(false);
		expect(caps.session).toBe(false);
		expect(caps.ui).toBe(false);
		expect(caps.store).toBe(false);
		expect(caps.hasCallRoute).toBe(false);
		expect(caps.hasUnknown).toBe(false);

		// Escape hatch removed.
		expect(caps.hasGatewayMember).toBe(false);
	});

	test("every Phase-2 stub throws 'reserved for Phase 2'", async ({ page }) => {
		await gotoAndWait(page);
		// Slice B2 implemented session.readTranscript/readToolCall (own-session reads);
		// they are NO LONGER throwing stubs (the `session` capability flag still stays
		// false until C2 — capability-signaling convention). The remaining members are
		// still frozen-not-implemented and must throw.
		const stubs = [
			"callRoute",
			"session.postMessage",
			"session.subscribe",
			"ui.openPanel",
			"ui.navigate",
			"store.get",
			"store.put",
			"store.list",
		];
		for (const which of stubs) {
			const msg = await page.evaluate((w) => (window as any).__callStub(w), which);
			expect(msg, `${which} must throw`).toBeTruthy();
			expect(msg).toContain("reserved for Phase 2");
		}
	});
});
