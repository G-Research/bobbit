/**
 * PERF-04 — goal-dashboard client pollers keep firing (and force full
 * re-renders) in backgrounded tabs.
 *
 * Drives the REAL `createVisibilityAwarePoller` / `hasPollDiff`
 * (src/app/visibility-poller.ts) through a file:// bundle, not a
 * hand-reproduction, per the client-host-api.spec.ts / pack-renderers pattern:
 * esbuild bundles a real entry once, a fixture loads it, tests drive it via
 * window globals.
 *
 * Pins:
 *   1. While the tab is visible, the wrapped tick fires on its declared
 *      cadence (sanity check the fixture itself isn't inert).
 *   2. While hidden, ticks stop entirely — no work is queued and replayed.
 *   3. The moment the tab becomes visible again, tick fires immediately —
 *      no staleness window waiting out the remaining interval.
 *   4. A poller composed with the real `hasPollDiff` (mirroring
 *      goal-dashboard.ts's agentPoll fix) does NOT bump a render counter on
 *      ticks where the fetched payload is unchanged, and DOES bump it by
 *      exactly one tick after the payload changes.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle";

const FIXTURE = path.resolve("tests/fixtures/visibility-poller.html");
const BUNDLE = path.resolve("tests/fixtures/visibility-poller-bundle.js");
const ENTRY = path.resolve("tests/fixtures/visibility-poller-entry.ts");
const SRC = path.resolve("src/app/visibility-poller.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function ready(page: any) {
	await page.goto(PAGE, { waitUntil: "load" });
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

/** Flip `document.visibilityState` and dispatch the real event, exactly the
 *  signal `createVisibilityAwarePoller` listens for in production. */
async function setVisibility(page: any, state: "visible" | "hidden") {
	await page.evaluate((s: string) => {
		Object.defineProperty(document, "visibilityState", {
			value: s,
			writable: true,
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}, state);
}

test.describe("createVisibilityAwarePoller (PERF-04)", () => {
	test("ticks fire on cadence while visible", async ({ page }) => {
		await ready(page);
		await setVisibility(page, "visible");

		await page.evaluate(() => (window as any).__startBasicPoller(40));
		await page.waitForTimeout(260); // ~6 intervals at 40ms

		const count = await page.evaluate(() => (window as any).__getTickCount());
		expect(count, "expected several ticks while the tab stays visible").toBeGreaterThanOrEqual(3);

		await page.evaluate(() => (window as any).__stopBasicPoller());
	});

	test("hidden tab: ticks stop entirely (no queued replay)", async ({ page }) => {
		await ready(page);
		await setVisibility(page, "visible");

		await page.evaluate(() => (window as any).__startBasicPoller(30));
		await page.waitForTimeout(150); // let a few ticks land while visible

		await setVisibility(page, "hidden");
		const countAtHide = await page.evaluate(() => (window as any).__getTickCount());

		// Wait well past several interval periods while hidden.
		await page.waitForTimeout(300);
		const countAfterHiddenWait = await page.evaluate(() => (window as any).__getTickCount());

		expect(
			countAfterHiddenWait,
			`expected 0 ticks while hidden (was ${countAtHide}, now ${countAfterHiddenWait}) — a hidden tab must not sustain a request cadence`,
		).toBe(countAtHide);

		await page.evaluate(() => (window as any).__stopBasicPoller());
	});

	test("becoming visible fires immediately — no staleness window", async ({ page }) => {
		await ready(page);
		await setVisibility(page, "visible");

		await page.evaluate(() => (window as any).__startBasicPoller(10_000)); // effectively never fires on its own cadence within this test
		await page.waitForTimeout(50);

		await setVisibility(page, "hidden");
		const countHidden = await page.evaluate(() => (window as any).__getTickCount());

		// Regain visibility — the fix must fire a tick synchronously off the
		// visibilitychange event, not wait out the 10s cadence.
		const countAfterVisible = await page.evaluate(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				writable: true,
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
			return (window as any).__getTickCount();
		});

		expect(
			countAfterVisible,
			"expected an immediate tick the moment the tab regains visibility",
		).toBe(countHidden + 1);

		await page.evaluate(() => (window as any).__stopBasicPoller());
	});

	test("no-change payload does not bump the render count; a real change bumps it by exactly one", async ({ page }) => {
		await ready(page);
		await setVisibility(page, "visible");

		await page.evaluate(() => (window as any).__startDiffPoller(40));
		const initialCount = await page.evaluate(() => (window as any).__getRenderCount());
		expect(initialCount, "expected exactly the initial mount render").toBe(1);

		// Payload is unchanged across several ticks — no re-render should occur.
		await page.waitForTimeout(220);
		const afterUnchangedTicks = await page.evaluate(() => (window as any).__getRenderCount());
		expect(
			afterUnchangedTicks,
			"expected no additional renders while the polled payload is unchanged",
		).toBe(1);

		// Now the payload actually changes — expect exactly one more render.
		await page.evaluate(() => (window as any).__setFakeAgents([{ id: "a2" }]));
		await page.waitForTimeout(80); // at least one more 40ms tick
		const afterChange = await page.evaluate(() => (window as any).__getRenderCount());
		expect(afterChange, "expected exactly one render after the payload changed").toBe(2);

		// Confirm it settles back to no-render once stable again.
		await page.waitForTimeout(220);
		const afterSettled = await page.evaluate(() => (window as any).__getRenderCount());
		expect(afterSettled, "expected no further renders once the new payload is stable").toBe(2);

		await page.evaluate(() => (window as any).__stopDiffPoller());
	});
});
