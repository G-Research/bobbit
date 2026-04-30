/**
 * Scroll-lock hardening — Changes 1–4 from the design doc.
 *
 * Behavioural twin of the post-hardening logic in
 * src/ui/components/AgentInterface.ts. Each test maps directly to one of
 * the five mechanical changes specified in the design doc.
 *
 * (Change 5, the Jump-to-bottom button, is covered by an E2E test:
 * tests/e2e/ui/jump-to-bottom.spec.ts.)
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/agent-interface-scroll-hardening.html")}`;

test.describe("AgentInterface scroll hardening", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	test("Change 1 — sub-pixel echo latch (< 1 px) consumes the echo and does not flip stickToBottom", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__primeProgrammaticScroll());

		const before = await page.evaluate(() => (window as any).__getState());
		expect(before.stickToBottom).toBe(true);
		expect(before.lastProgrammaticScrollTop).not.toBeNull();

		// Synthesize a scroll event whose reported scrollTop is the latched value + 0.4.
		// On master (strict equality) this would miss the echo and recompute
		// _stickToBottom against a false offset. With the < 1 tolerance, the
		// echo is consumed exactly once and the latch is cleared.
		await page.evaluate(() => (window as any).__simulateFractionalEcho());

		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.lastProgrammaticScrollTop, "echo latch should be cleared after consumption").toBeNull();
		expect(after.lastProgrammaticScrollHeight).toBeNull();
		expect(after.stickToBottom, "stickToBottom must not be flipped by the echoed event").toBe(true);
	});

	test("Change 2 — widened tail tolerance (< 10) keeps stickToBottom true at distance 7", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		// Position so scrollHeight - scrollTop - clientHeight === 7 px from bottom.
		await page.evaluate(() => (window as any).__scrollSoDistanceFromBottomIs(7));

		const state = await page.evaluate(() => (window as any).__getState());
		const distance = state.scrollHeight - state.scrollTop - state.clientHeight;
		expect(distance).toBe(7);
		expect(state.stickToBottom, "tail tolerance is now < 10, so 7px must still be 'at bottom'").toBe(true);
	});

	test("Change 3 — wasAtBottom carry-over scrolls to bottom on state_update after a transient scroll-up", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		// Transient scroll-up by 30 px (well > 10 to defeat Change 2's tolerance).
		await page.evaluate(() => (window as any).__simulateTransientScrollUp(30));

		const mid = await page.evaluate(() => (window as any).__getState());
		expect(mid.stickToBottom, "30px scroll-up must flip stickToBottom false").toBe(false);
		expect(mid.wasAtBottomAtLastUserScroll, "carry-over must remember we WERE at bottom").toBe(true);
		expect(mid.scrollToBottomCallCount).toBe(0);

		// Fire state_update — should re-anchor to bottom via the carry-over.
		await page.evaluate(() => (window as any).__fireStateUpdate());
		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.scrollToBottomCallCount, "state_update must re-anchor to bottom via carry-over").toBe(1);
	});

	test("Change 3 — explicit user intent (wheel) resets the carry-over", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__simulateTransientScrollUp(30));
		// Explicit wheel/touchstart-style user intent.
		await page.evaluate(() => (window as any).__fireUserWheel());
		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.stickToBottom).toBe(false);
		expect(after.wasAtBottomAtLastUserScroll, "user-intent must clear the carry-over").toBe(false);
	});

	test("Change 3 — keyboard navigation also clears carry-over", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__simulateTransientScrollUp(30));
		await page.evaluate(() => (window as any).__fireScrollKey("PageUp"));
		const after = await page.evaluate(() => (window as any).__getState());
		expect(after.wasAtBottomAtLastUserScroll).toBe(false);
	});

	test("Change 4 — settle window re-anchors across staggered RO ticks", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__armSettleWindow(2000));

		// Three staggered ticks — each grows scrollHeight, simulating async
		// markdown/code-block layout settling after session bind.
		for (let i = 0; i < 3; i++) {
			await page.evaluate(() => {
				(window as any).__appendMessages(20);
				(window as any).__fireResizeObserver();
			});
			await page.waitForTimeout(20);
		}

		const after = await page.evaluate(() => (window as any).__getState());
		const tail = after.scrollHeight - after.scrollTop - after.clientHeight;
		expect(tail, "after settle, must be within 5 px of the bottom").toBeLessThanOrEqual(5);
		expect(after.scrollToBottomCallCount, "settle window must have re-anchored at least once").toBeGreaterThanOrEqual(1);
	});

	test("Change 4 — user wheel during settle cancels the window; later RO ticks do NOT force-scroll", async ({ page }) => {
		await page.evaluate(() => (window as any).__startAtBottom());
		await page.evaluate(() => (window as any).__armSettleWindow(2000));

		// First tick — settle window applies.
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		const afterFirst = await page.evaluate(() => (window as any).__getState());
		const callsAfterFirst = afterFirst.scrollToBottomCallCount;

		// User scrolls (wheel) → settle window must cancel.
		await page.evaluate(() => (window as any).__fireUserWheel());
		const cancelled = await page.evaluate(() => (window as any).__getState());
		expect(cancelled.settleWindowActive).toBe(false);
		expect(cancelled.stickToBottom).toBe(false);

		// Subsequent RO ticks must NOT force-scroll — stickToBottom is false
		// AND settle window is inactive.
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		await page.evaluate(() => {
			(window as any).__appendMessages(20);
			(window as any).__fireResizeObserver();
		});
		const final = await page.evaluate(() => (window as any).__getState());
		expect(final.scrollToBottomCallCount, "no further scroll after user intent cancelled the window").toBe(callsAfterFirst);
	});
});
