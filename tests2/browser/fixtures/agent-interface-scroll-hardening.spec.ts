/**
 * Scroll-lock hardening — outcome tests for the post-redesign model.
 *
 * The redesign collapses the previous layered patches (settle window,
 * `_wasAtBottomAtLastUserScroll` carry-over, geometry-driven intent flip,
 * jump-button suppression timer) into a single coherent model:
 *
 *   - `_stickToBottom` flips FALSE only on user gestures.
 *   - Geometry NEVER mutates the flag.
 *   - Programmatic-scroll echoes go through a ring buffer (length 4),
 *     consumed oldest-match first with sub-pixel (< 1 px) tolerance.
 *   - The ResizeObserver re-pins via `_pinIfSticking()` on `delta > 0`.
 *
 * These tests exercise the OUTCOMES that the old patches were trying to
 * achieve, against the new model. The previous mechanism-detail tests
 * (settle window re-anchors, carry-over scroll on state_update) are gone
 * because the mechanisms they asserted are deleted.
 *
 * The Jump-to-bottom button click flow is covered by
 * tests/e2e/ui/jump-to-bottom.spec.ts. The vibration regression
 * (delta === 0 RO no-op) is covered by tests/agent-interface-scroll.spec.ts.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/agent-interface-scroll-hardening.html")}`;

test.describe("AgentInterface scroll hardening (post-redesign)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	test("sub-pixel echo is consumed (< 1 px tolerance) and does not flip stickToBottom", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__primeProgrammaticScroll());

		const before = await page.evaluate(() => (window as any).__getState());
		expect(before.stickToBottom).toBe(true);
		expect(before.echoCount).toBeGreaterThanOrEqual(1);

		// Fractional-offset scroll event simulating HiDPI device-pixel rounding.
		await page.evaluate(() => (window as any).__simulateFractionalEcho());

		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.echoCount, "echo ring should have one fewer entry after consumption")
			.toBe(before.echoCount - 1);
		expect(after.stickToBottom, "stickToBottom must not change for an echo").toBe(true);
	});

	test("geometry alone does NOT flip stickToBottom even at distance 30 from bottom", async ({ page }) => {
		// In the legacy model, a transient sub-pixel scroll-up beyond the 10 px
		// stick-grace tail flipped _stickToBottom = false via geometry, which then
		// required a `_wasAtBottomAtLastUserScroll` carry-over to re-anchor on
		// state_update. The redesign removes geometry-driven flips entirely:
		// `_stickToBottom` stays true unless the user explicitly scrolls.
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__scrollSoDistanceFromBottomIs(30));

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom, "geometry must not mutate the flag").toBe(true);
		// Jump-button visibility comes from geometry — at 30 px (< clientHeight*0.5)
		// the button should remain hidden.
		expect(state.showJumpToBottom).toBe(false);
	});

	test("explicit user wheel releases stickiness immediately", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__fireUserWheel());
		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.stickToBottom).toBe(false);
	});

	test("keyboard nav releases stickiness", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__fireScrollKey("PageUp"));
		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.stickToBottom).toBe(false);
	});

	test("RO ticks on growth re-pin while sticking; viewport stays within sub-pixel tail", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		// Three staggered growths — async markdown / code-block layout.
		for (let i = 0; i < 3; i++) {
			await page.evaluate(() => {
				(window as any).__appendMessages(20);
				(window as any).__fireResizeObserver();
			});
			await page.waitForTimeout(20);
		}
		const after = await page.evaluate(() => (window as any).__getState());
		const tail = after.scrollHeight - after.scrollTop - after.clientHeight;
		expect(tail, "after growth, must be within 1 px of the bottom").toBeLessThanOrEqual(1);
		expect(after.scrollToBottomCallCount, "must have re-pinned at least once").toBeGreaterThanOrEqual(1);
	});

	test("user wheel mid-stream stops further re-pins (no hidden settle window)", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		// First tick re-pins (we're stuck).
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		const afterFirst = await page.evaluate(() => (window as any).__getState());
		const callsAfterFirst = afterFirst.scrollToBottomCallCount;

		// User wheel — stickiness released.
		await page.evaluate(() => (window as any).__fireUserWheel());
		const cancelled = await page.evaluate(() => (window as any).__getState());
		expect(cancelled.stickToBottom).toBe(false);

		// Subsequent RO ticks must NOT re-pin.
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		const final = await page.evaluate(() => (window as any).__getState());
		expect(final.scrollToBottomCallCount, "no further re-pins after user intent")
			.toBe(callsAfterFirst);
	});

	test("ring-buffer absorbs multi-write echo race (older echo arriving after newer write)", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		const before = await page.evaluate(() => (window as any).__getState());
		await page.evaluate(() => (window as any).__simulateMultiWriteRace());
		const after = await page.evaluate(() => (window as any).__getState());
		// stickToBottom must stay true: geometry never mutates it, AND the
		// older echo was consumed instead of falling through to user-intent
		// territory.
		expect(after.stickToBottom).toBe(true);
		// And the ring still holds the newer echo — only the older one was spliced.
		expect(after.echoCount).toBeGreaterThanOrEqual(1);
		void before;
	});
});
