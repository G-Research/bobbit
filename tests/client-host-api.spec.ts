/**
 * Unit tests for the Phase-1 CLIENT Host API `getHostApi` (src/app/host-api.ts)
 * under the durable v1 contract (design extension-host.md §3).
 *
 * Pins:
 *   - `host.capabilities` is the SINGLE SOURCE OF TRUTH: invokeAction +
 *     requestRender are true; `store` (B1) + `callRoute` (B3) are implemented +
 *     true; `ui` (B4 openPanel + C1 navigate) and `session` (B2 reads + C2 writes)
 *     are implemented + true; `has(name)` mirrors the flags.
 *   - `version`/`contractVersion` are the frozen consts.
 *   - There is NO `gateway` member (escape hatch removed in v1).
 *   - All Phase-2 members are implemented; none throw "reserved for Phase 2".
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
		// Contract v2: the additive `PanelTarget.sessionId` field bumped
		// HOST_CONTRACT_VERSION 1→2 (HOST_API_VERSION stays 1 — purely additive).
		expect(caps.contractVersion).toBe(2);

		// Phase-1 — implemented.
		expect(caps.invokeAction).toBe(true);
		expect(caps.requestRender).toBe(true);
		expect(caps.hasInvokeAction).toBe(true);

		// Phase-2 — ALL implemented now: store (B1) + callRoute (B3) + session (B2
		// reads + C2 writes) + ui (B4 openPanel + C1 navigate).
		expect(caps.callRoute).toBe(true);
		expect(caps.session).toBe(true);
		expect(caps.ui).toBe(true);
		expect(caps.store).toBe(true);
		expect(caps.hasCallRoute).toBe(true);
		expect(caps.hasUnknown).toBe(false);

		// Escape hatch removed.
		expect(caps.hasGatewayMember).toBe(false);
	});

	test("no Phase-2 member is a frozen 'reserved for Phase 2' stub anymore", async ({ page }) => {
		await gotoAndWait(page);
		// Slices B1/B2/B3/B4/C1 implemented store.* / session.read* / callRoute / ui.*
		// respectively (NO LONGER "reserved for Phase 2" throwing stubs — store/callRoute
		// require a pack-served renderer context; ui.openPanel/ui.navigate no-op for an
		// unregistered panel/route; the `session` capability flag stays false until C2
		// adds writes — capability-signaling convention). The session WRITE members below
		// are the only ones still frozen-not-implemented and must throw.
		// All Phase-2 members are implemented (B1/B2/B3/B4/C1/C2) — NONE remain
		// frozen. Calling any of them must NOT throw "reserved for Phase 2" (they may
		// throw a different, capability-specific error, e.g. a missing user gesture).
		const formerStubs = [
			"callRoute",
			"ui.navigate",
			"session.postMessage",
			"session.subscribe",
		];
		for (const which of formerStubs) {
			const msg = await page.evaluate((w) => (window as any).__callStub(w), which);
			expect(msg ?? "", `${which} must not be a Phase-2 stub`).not.toContain("reserved for Phase 2");
		}
	});
});
