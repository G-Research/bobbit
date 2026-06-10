/**
 * `bash_bg wait` live-elapsed timer — reload stability.
 *
 * The timer must count up from when the wait started and must NOT reset to 0
 * on a page refresh / navigate-away-and-back. The reload-stable anchor is the
 * server-stamped assistant-message timestamp threaded as
 * `ctx.toolCallStartTime`; this test pins that the renderer hands that value
 * (not `Date.now()`) to <live-timer>.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = `file://${path.resolve("tests/fixtures/bg-wait-timer.html").replace(/\\/g, "/")}`;
const ENTRY = path.resolve("tests/fixtures/bg-wait-timer-entry.ts");
const BUNDLE = path.resolve("test-results/bg-wait-timer-bundle.js");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/BgProcessRenderer.ts");
const LIVE_TIMER_SRC = path.resolve("src/ui/components/LiveTimer.ts");

test.beforeAll(() => {
	fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER_SRC, LIVE_TIMER_SRC] });
});

async function gotoFixture(page: Page) {
	await page.goto(FIXTURE);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__bgWaitTimerReady === true);
}

test.describe("bash_bg wait timer", () => {
	test("uses the server message timestamp as the start anchor, not now", async ({ page }) => {
		await gotoFixture(page);
		const startedAt = Date.now() - 90_000; // wait started 90s ago
		const resolved = await page.evaluate((s) => (window as any).renderWait({ startTime: s, streaming: true }), startedAt);
		expect(resolved).toBe(startedAt);
	});

	test("does not reset on reload — a fresh render with the same anchor keeps it", async ({ page }) => {
		await gotoFixture(page);
		const startedAt = Date.now() - 45_000;
		// First render (initial load).
		await page.evaluate((s) => (window as any).renderWait({ startTime: s, streaming: true }), startedAt);
		// Simulate a full reload: navigate away and back, re-render with the
		// same persisted-from-transcript anchor.
		await gotoFixture(page);
		const afterReload = await page.evaluate((s) => (window as any).renderWait({ startTime: s, streaming: true }), startedAt);
		expect(afterReload).toBe(startedAt);
	});

	test("falls back to now only when no anchor is available", async ({ page }) => {
		await gotoFixture(page);
		const before = Date.now();
		const resolved: number = await page.evaluate(() => (window as any).renderWait({ streaming: true }));
		const after = Date.now();
		expect(resolved).toBeGreaterThanOrEqual(before - 1000);
		expect(resolved).toBeLessThanOrEqual(after + 1000);
	});
});
