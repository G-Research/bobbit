import { test, expect } from "@playwright/test";
import path from "node:path";
import { waitForStableScroll } from "../_helpers/stable-wait.js";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/scroll-anchor-shrink.html")}`;

const SCROLLER = "#scroll-container";

test.describe("Scroll anchor on shrink", () => {
	test("does not jolt viewport when content shrinks while scrolled up (small collapse)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom so stickToBottom = true, then scroll up
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			sc.scrollTop = sc.scrollHeight;
		});
		await waitForStableScroll(page, SCROLLER);

		// Scroll up ~300px from bottom so _stickToBottom becomes false
		const initialState = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			const target = sc.scrollHeight - sc.clientHeight - 300;
			(window as any).__scrollTo(target);
			return (window as any).__getState();
		});
		await waitForStableScroll(page, SCROLLER);

		// Verify we're scrolled up (not stuck to bottom)
		expect(initialState.stickToBottom).toBe(false);

		// Collapse the element then trigger the resize handler
		await page.evaluate(() => {
			(window as any).__collapseElement();
			(window as any).__handleResize();
		});

		// Wait for the browser's async scroll clamp/adjustment to settle
		await waitForStableScroll(page, SCROLLER);

		// With the new post-collapse clamp, small collapses (< half viewport)
		// let the browser naturally adjust scrollTop. The clamp only fires if
		// content bottom ends up above the viewport midpoint. For a 400px collapse
		// when scrolled 300px from bottom, the content bottom stays well within
		// the viewport, so no forced scroll happens. The user's viewport remains
		// roughly stable (browser may clamp scrollTop to the new max).
		const result = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			const contentBottom = sc.scrollHeight - sc.scrollTop;
			return {
				contentBottom,
				clientHeight: sc.clientHeight,
				// Content bottom should be at least half the viewport (no clamp needed)
				contentVisibleEnough: contentBottom >= sc.clientHeight / 2,
			};
		});
		expect(result.contentVisibleEnough, "content should remain visible after small collapse").toBe(true);
	});

	test("does not adjust scrollTop when stuck to bottom", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom (stickToBottom = true)
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight);
		});
		await waitForStableScroll(page, SCROLLER);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(true);

		// Collapse and trigger resize, then wait for scroll to settle
		await page.evaluate(() => {
			(window as any).__collapseElement();
			(window as any).__handleResize();
		});
		await waitForStableScroll(page, SCROLLER);

		// Should remain at the bottom
		const afterState = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			return {
				scrollTop: sc.scrollTop,
				scrollHeight: sc.scrollHeight,
				clientHeight: sc.clientHeight,
			};
		});
		const distFromBottom = afterState.scrollHeight - afterState.scrollTop - afterState.clientHeight;
		expect(distFromBottom).toBeLessThan(5);
	});

	test("does not adjust scrollTop when content grows while scrolled up", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll up
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight - sc.clientHeight - 300);
		});
		await waitForStableScroll(page, SCROLLER);

		const scrollTopBefore = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// Grow content (simulate new messages appearing below) and trigger resize
		await page.evaluate(() => {
			const after = document.getElementById("after-messages")!;
			for (let i = 0; i < 10; i++) {
				const div = document.createElement("div");
				div.className = "message";
				div.textContent = `New message ${i}`;
				after.appendChild(div);
			}
			(window as any).__handleResize();
		});
		// Wait for any (buggy) async scroll adjustment to settle before reading
		await waitForStableScroll(page, SCROLLER);

		const scrollTopAfter = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// scrollTop should not change — new content below viewport shouldn't pull user down
		expect(scrollTopAfter).toBe(scrollTopBefore);
	});

	test("stays near bottom when content shrinks while stuck to bottom", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom so stickToBottom = true
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight);
		});
		await waitForStableScroll(page, SCROLLER);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(true);

		// Collapse the element and trigger resize handler, then wait for the
		// browser's async scroll clamp to settle
		await page.evaluate(() => {
			(window as any).__collapseElement();
			(window as any).__handleResize();
		});
		await waitForStableScroll(page, SCROLLER);

		// With the new post-collapse clamp, a 400px collapse while at bottom:
		// browser clamps scrollTop naturally, content bottom = clientHeight (full viewport),
		// which is > clientHeight/2, so no forced scroll. User ends up at the new bottom.
		const afterState = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			return {
				scrollTop: sc.scrollTop,
				scrollHeight: sc.scrollHeight,
				clientHeight: sc.clientHeight,
			};
		});
		const distFromBottom = afterState.scrollHeight - afterState.scrollTop - afterState.clientHeight;
		expect(distFromBottom, "should be at or near the bottom after collapse").toBeLessThan(5);
	});
});
