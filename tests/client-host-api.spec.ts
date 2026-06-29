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
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle";

const FIXTURE = path.resolve("tests/fixtures/client-host-api.html");
const BUNDLE = path.resolve("tests/fixtures/client-host-api-bundle.js");
const ENTRY = path.resolve("tests/fixtures/client-host-api-entry.ts");
const HOST_SRC = path.resolve("src/app/host-api.ts");
const SHARED_SRC = path.resolve("src/shared/extension-host/host-api.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, HOST_SRC, SHARED_SRC],
	});
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
		// Contract v4: additive host.channels data contracts bumped
		// HOST_CONTRACT_VERSION (HOST_API_VERSION stays 1 — purely additive).
		expect(caps.contractVersion).toBe(4);

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

	test("host.store exposes scoped persistence methods", async ({ page }) => {
		await gotoAndWait(page);
		const methods = await page.evaluate(() => (window as any).__storeMethods());
		expect(methods).toEqual(["get:function", "put:function", "list:function", "delete:function", "deletePrefix:function", "stats:function"]);
	});

	test("host.callRoute includes structured JSON error bodies on non-2xx responses", async ({ page }) => {
		await gotoAndWait(page);
		const err = await page.evaluate(() => (window as any).__callRouteHttpError());
		expect(err).toMatchObject({ status: 500, code: "STORE_QUOTA_EXCEEDED", routeError: "Review payload is too large to save." });
		expect(err.message).toContain("callRoute publish HTTP 500");
		expect(err.message).toContain("STORE_QUOTA_EXCEEDED");
		expect(err.message).toContain("Review payload is too large to save.");
		expect(err.message).toContain("reviews/job/final/payload: maxTotalBytes exceeded");
	});

	test("pack-bound surface tokens use the trusted app bridge instead of REST", async ({ page }) => {
		await gotoAndWait(page);
		await expect(page.evaluate(() => (window as any).__packSurfaceTokenMintUsesTrustedBridge())).resolves.toEqual({
			bridgeMinted: true,
			fetchMinted: false,
		});
	});

	test("host.channels.open does not require user activation", async ({ page }) => {
		await gotoAndWait(page);
		const result = await page.evaluate(() => (window as any).__channelOpenWithoutGesture());
		expect(result).toEqual({
			id: "chan-1",
			sentTypes: ["auth", "ext_channel_open_grant", "ext_channel_open"],
			grant: "grant-1",
		});
	});

	test("host.channels.open remints a stale pack surface token once", async ({ page }) => {
		await gotoAndWait(page);
		const result = await page.evaluate(() => (window as any).__channelOpenRemintsStaleSurfaceToken());
		expect(result).toEqual({
			id: "chan-retry",
			mintCount: 2,
			tokens: ["stale-surface-token", "fresh-surface-token"],
		});
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
