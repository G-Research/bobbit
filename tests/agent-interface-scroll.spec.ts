/**
 * Bug 1 — vibration / snap-back when scrolling up in an idle session.
 *
 * Reproduces the invariant violation in AgentInterface's ResizeObserver
 * callback (src/ui/components/AgentInterface.ts:264–296):
 *
 *   if (this._stickToBottom) {
 *     this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
 *     ...
 *   }
 *
 * That branch fires whenever `delta >= 0` AND `_stickToBottom === true`.
 * On a delta=0 RO fire (no actual height change — the observed element's
 * width/border-box just reflowed for any reason: scrollbar gutter, pill
 * strip, canvas remount, Lit re-render cascade) the callback still slams
 * `scrollTop` back to `scrollHeight`, snapping the user back to the bottom
 * even though they have intentionally scrolled up inside the 50 px tail.
 *
 * The fixture is a behavioural twin of the production logic — not a
 * re-implementation of unrelated code. After the proposed fix (only
 * auto-scroll on delta > 0), the user's scrollTop is preserved.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/agent-interface-scroll.html")}`;

test.describe("AgentInterface scroll lock — vibration / snap-back", () => {
	test("RO fire with delta=0 must NOT clobber user scrollTop while stickToBottom is true", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// 1. Start at bottom (stickToBottom = true).
		await page.evaluate(() => (window as any).__startAtBottom());
		const before = await page.evaluate(() => (window as any).__getState());
		expect(before.stickToBottom).toBe(true);
		expect(before.scrollTop).toBe(before.scrollHeight - before.clientHeight);

		// 2. User scrolls up 30 px — inside the 50 px tail. Per the production
		//    scroll handler (`scrollHeight - scrollTop - clientHeight < 50`),
		//    this leaves _stickToBottom = true. The user's scrollTop reflects
		//    a small upward gesture.
		const SCROLL_UP_PX = 30;
		await page.evaluate((px) => (window as any).__userScrollUp(px), SCROLL_UP_PX);
		// Wait one microtask so the scroll event handler runs.
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

		const afterUserScroll = await page.evaluate(() => (window as any).__getState());
		expect(
			afterUserScroll.scrollTop,
			"user scroll should have moved the viewport up by SCROLL_UP_PX",
		).toBe(afterUserScroll.scrollHeight - afterUserScroll.clientHeight - SCROLL_UP_PX);

		// 3. Synthesize a ResizeObserver fire with delta === 0 (no height change).
		//    On master this enters the stick-to-bottom branch and clobbers
		//    scrollTop back to scrollHeight, which is the snap-back/vibration.
		await page.evaluate(() => (window as any).__fireResizeObserverDeltaZero());
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

		// 4. The user's scrollTop must be preserved. No height changed, so the
		//    RO callback has no business moving the viewport.
		const afterRo = await page.evaluate(() => (window as any).__getState());
		expect(
			afterRo.scrollTop,
			`scrollTop should be preserved after a delta=0 ResizeObserver fire — expected ${
				afterRo.scrollHeight - afterRo.clientHeight - SCROLL_UP_PX
			} but got ${afterRo.scrollTop} (snap-back / vibration bug)`,
		).toBe(afterRo.scrollHeight - afterRo.clientHeight - SCROLL_UP_PX);
	});
});
