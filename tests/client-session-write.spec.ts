/**
 * Browser unit for the C2 client session WRITE (`host.session.postMessage`) — its
 * trusted WebSocket transport + its user-gesture gate (src/app/host-api.ts +
 * src/app/gesture-context.ts + src/app/session-write-bridge.ts; design
 * docs/design/extension-host-phase2.md §8 C2.1).
 *
 * Pins (the client side of the §8 security posture):
 *   - The SEND rides the TRUSTED session WebSocket (the session-write-bridge poster
 *     RemoteAgent registers over its private WS) — NOT a `fetch`. There is no
 *     session secret on any request for a same-realm pack to monkey-patch / capture
 *     / replay, and `window.fetch` is never called by the post.
 *   - NO post fires on mount / without a genuine user activation — postMessage
 *     throws SYNCHRONOUSLY ("postMessage requires a user gesture"). The gate is
 *     `navigator.userActivation.isActive`.
 *   - WITH a genuine activation the post flows through the WS poster carrying the
 *     bound `tool` (so the server derives the trusted packId) + role/text/resumeTurn
 *     — usable from a panel/entrypoint origin with NO toolUseId.
 *   - With NO trusted WS transport registered, the post rejects (a raw same-realm
 *     context cannot drive the agent — there is no fetch fallback).
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
const BRIDGE_SRC = path.resolve("src/app/session-write-bridge.ts");
const BUS_SRC = path.resolve("src/app/session-event-bus.ts");
const SHARED_SRC = path.resolve("src/shared/extension-host/host-api.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(HOST_SRC).mtimeMs,
		fs.statSync(GESTURE_SRC).mtimeMs,
		fs.statSync(BRIDGE_SRC).mtimeMs,
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

test.describe("host.session.postMessage — trusted WS transport + activation gate (extension-host-phase2 §8)", () => {
	test("throws synchronously and sends NOTHING without a user activation", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const msg = await page.evaluate(() => (window as any).__postNoGesture());
		expect(msg).toContain("postMessage requires a user gesture");
		const posted = await page.evaluate(() => (window as any).__posted());
		const calls = await page.evaluate(() => (window as any).__calls());
		expect(posted.length).toBe(0);
		expect(calls.length).toBe(0);
	});

	test("with a genuine activation the post rides the trusted WS poster — and NO fetch", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const res = await page.evaluate(() => (window as any).__postWithGesture());
		expect(res.posted).toBeTruthy();
		expect(res.posted.tool).toBe("sample_action");
		expect(res.posted.role).toBe("user");
		expect(res.posted.text).toBe("hi");
		expect(res.posted.resumeTurn).toBe(false);
		// Transport is the WS bridge, never a fetch (no capturable secret surface).
		expect(res.fetches).toBe(0);
	});

	test("with no trusted WS transport registered, the post rejects (no fetch fallback)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).__reset());
		const msg = await page.evaluate(() => (window as any).__postNoTransport());
		expect(msg).toContain("transport unavailable");
		const calls = await page.evaluate(() => (window as any).__calls());
		expect(calls.length).toBe(0);
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
