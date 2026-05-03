/**
 * Reproducing test for goal "Fix tail-chat reliability" — User scroll-up:
 * **While streaming, user scrolls up; subsequent updates must NOT re-pin;
 * jump-button must show; clicking the button re-sticks and tracks new
 * content.**
 *
 * Per Issue Analysis section 7.1 row 5. This is the inverse-direction
 * outcome test — the redesign must preserve the *user-intent* release
 * (geometry never mutates the flag, but explicit wheel/touchstart/keydown
 * still releases stickiness).
 *
 * Master is already correct on the wheel-release side; the failure mode it
 * exhibits is on the recovery path — after the click + a follow-up growth,
 * the multi-write race can flip `_stickToBottom = false` again so the
 * "tracking new content" check fails. The redesign closes that recovery
 * race.
 */
import { test, expect } from "../gateway-harness.js";
import { setupTailChatScene, growContent, injectStaleScrollEvent, TAIL_PX, SCROLL_SEL } from "./tail-chat-helpers.js";

test.describe("tail-chat: user scroll-up release + recovery", () => {
	test("wheel-up unsticks; updates do NOT re-pin; jump-button click recovers + tracks", async ({ page }) => {
		await setupTailChatScene(page);

		// Bring the layout into a known state: one growth tick to establish
		// streaming, viewport at bottom.
		const after1 = await growContent(page, 200);
		expect(after1.stick).toBe(true);

		// User scroll-up via a synthetic `wheel` event (the wheel listener is
		// passive and fires `_handleUserIntent` → _stickToBottom = false) plus
		// a programmatic scrollTop write + scroll-event dispatch. Synthetic
		// dispatch is deterministic — Playwright's `mouse.wheel()` is processed
		// asynchronously by Chromium and races subsequent test steps.
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			// Fire wheel — this triggers _handleUserIntent unconditionally.
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
			const ch = el.clientHeight;
			// Set scrollTop to a position well above the bottom (>50% off-screen)
			// so the jump-to-bottom button visibility check passes deterministically.
			el.scrollTop = Math.max(0, el.scrollHeight - ch - Math.floor(ch * 0.7));
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);

		// 1. _stickToBottom must be false after explicit user wheel.
		const afterWheel = await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const el = document.querySelector(sel) as HTMLElement;
			return {
				stick: ai._stickToBottom,
				show: ai._showJumpToBottom,
				scrollTop: el.scrollTop,
				clientHeight: el.clientHeight,
				scrollHeight: el.scrollHeight,
			};
		}, SCROLL_SEL);
		expect(afterWheel.stick, "wheel-up must release _stickToBottom").toBe(false);

		// 2. Subsequent growth events must NOT re-pin the viewport (we're
		// scrolled up; the user expects scrollTop to stay put).
		const scrollTopBefore = afterWheel.scrollTop;
		await growContent(page, 150);
		await growContent(page, 150);
		const afterUpdates = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ai = document.querySelector("agent-interface") as any;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				stick: ai._stickToBottom,
			};
		}, SCROLL_SEL);
		expect(
			afterUpdates.stick,
			`tail-chat-user-scroll-up: stream after wheel-up must not re-stick`,
		).toBe(false);
		// The user-visible invariant: while scrolled-up, content growth must
		// NOT pull the viewport to the bottom. Allow scrollTop to differ
		// slightly across runs (browser sub-pixel rounding); just assert that
		// the viewport remains substantially above the bottom.
		const distFromBottom = afterUpdates.scrollHeight - afterUpdates.scrollTop - afterUpdates.clientHeight;
		expect(
			distFromBottom,
			`tail-chat-user-scroll-up: stream after wheel-up pulled viewport toward bottom; ` +
			`scrollTopBefore=${scrollTopBefore} after=${afterUpdates.scrollTop} ` +
			`distFromBottom=${distFromBottom} (must remain > clientHeight * 0.4)`,
		).toBeGreaterThan(afterUpdates.clientHeight * 0.4);

		// 3. Jump-to-bottom button must be visible (we're > clientHeight*0.5 from bottom).
		await page.waitForFunction(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			if (!b) return false;
			return b.style.opacity === "1" && b.style.pointerEvents === "auto";
		}, null, { timeout: 5_000 });

		// 4. Click the button → stickiness restored, viewport at bottom.
		await page.evaluate(() => {
			const b = document.querySelector('[data-testid="jump-to-bottom"]') as HTMLElement | null;
			b?.click();
		});
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
		}, SCROLL_SEL, { timeout: 5_000 });

		// 5. Tracking — a stale-echo race after click must NOT unstick us, AND
		// new content growth must keep the viewport pinned.
		await injectStaleScrollEvent(page);
		const afterTrack = await growContent(page, 300);
		const distance = afterTrack.scrollHeight - afterTrack.scrollTop - afterTrack.clientHeight;
		expect(
			afterTrack.stick,
			`tail-chat-user-scroll-up: post-click _stickToBottom flipped during tracking ` +
			`(stick=${afterTrack.stick})`,
		).toBe(true);
		expect(
			distance,
			`tail-chat-user-scroll-up: post-click viewport not tracking; ` +
			`distance=${distance} (>${TAIL_PX})`,
		).toBeLessThanOrEqual(TAIL_PX);
	});
});
