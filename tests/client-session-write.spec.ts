/**
 * Browser unit for the C2 client session WRITE (`host.session.postMessage`) and
 * its MANDATORY user-gesture gate (src/app/host-api.ts + src/app/gesture-context.ts;
 * design docs/design/extension-host-phase2.md §8 C2.1).
 *
 * Pins (the client side of the §8 security posture, Fix A):
 *   - NO POST fires on mount / without a genuine user activation — postMessage
 *     throws SYNCHRONOUSLY ("postMessage requires a user gesture") so a render-time
 *     post fails loudly. The gate is `navigator.userActivation.isActive`.
 *   - WITH a genuine activation the POST fires to /api/ext/session/message carrying
 *     the bound `tool` (so the server derives the trusted packId) AND the trusted
 *     per-session secret as `x-bobbit-session-secret` — usable from a panel/entrypoint
 *     origin with NO toolUseId.
 *   - the secret is sourced from a gesture-context module closure (never the body,
 *     never window/host); with no trusted secret present, no header is attached.
 *   - subscribe returns an unsubscribe fn (no throw, no server round-trip).
 *
 * Pattern mirrors client-host-api.spec.ts: esbuild bundles the entry once, a
 * file:// fixture loads it, and we drive helpers via window globals.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/client-session-write.html");
const BUNDLE = path.resolve("tests/fixtures/client-session-write-bundle.js");
const ENTRY = path.resolve("tests/fixtures/client-session-write-entry.ts");
const HOST_SRC = path.resolve("src/app/host-api.ts");
const GESTURE_SRC = path.resolve("src/app/gesture-context.ts");
const BUS_SRC = path.resolve("src/app/session-event-bus.ts");
const SHARED_SRC = path.resolve("src/shared/extension-host/host-api.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(HOST_SRC).mtimeMs,
		fs.statSync(GESTURE_SRC).mtimeMs,
		fs.statSync(BUS_SRC).mtimeMs,
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

test.describe("host.session.postMessage — activation + secret gate (extension-host-phase2 §8, Fix A)", () => {
	test("throws synchronously and fires NO POST without a user activation", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const msg = await page.evaluate(() => (window as any).__postNoGesture());
		expect(msg).toContain("postMessage requires a user gesture");
		const calls = await page.evaluate(() => (window as any).__calls());
		expect(calls.length).toBe(0);
	});

	test("with a genuine activation the POST fires with the bound tool + trusted secret header", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const res = await page.evaluate(() => (window as any).__postWithGesture());
		expect(res.posted).toBe(true);
		expect(res.body.tool).toBe("sample_action");
		expect(res.body.role).toBe("user");
		expect(res.body.text).toBe("hi");
		expect(res.body.resumeTurn).toBe(false);
		// Panel/entrypoint origin: no toolUseId is bound.
		expect(res.body.toolUseId).toBeUndefined();
		// Fix A: the trusted per-session secret is attached as a header (NOT the body),
		// sourced from the gesture-context closure pack code cannot read.
		expect(res.secretHeader).toBe("test-secret");
		expect(res.body.gestureNonce).toBeUndefined();
		const calls = await page.evaluate(() => (window as any).__calls());
		const msg = calls.find((c: any) => c.url.includes("/api/ext/session/message"));
		expect(msg).toBeTruthy();
		expect(msg.method).toBe("POST");
	});

	test("with no trusted secret present, no secret header is attached (server then rejects)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const res = await page.evaluate(() => (window as any).__postWithoutSecret());
		expect(res.posted).toBe(true);
		expect(res.secretHeader).toBeUndefined();
	});

	test("subscribe returns an unsubscribe fn (no throw, no round-trip)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const ok = await page.evaluate(() => (window as any).__subscribeReturnsUnsub());
		expect(ok).toBe(true);
		const calls = await page.evaluate(() => (window as any).__calls());
		expect(calls.length).toBe(0);
	});
});
