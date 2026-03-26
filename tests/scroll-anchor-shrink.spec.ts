import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/scroll-anchor-shrink.html")}`;

test.describe("Scroll anchor on shrink", () => {
	test("compensates scrollTop when content shrinks while scrolled up", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// First scroll to bottom so stickToBottom = true, then scroll up
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			sc.scrollTop = sc.scrollHeight;
		});
		await page.waitForTimeout(200);

		// Scroll up ~300px from bottom so _stickToBottom becomes false
		const initialState = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			const target = sc.scrollHeight - sc.clientHeight - 300;
			(window as any).__scrollTo(target);
			return (window as any).__getState();
		});
		await page.waitForTimeout(200);

		// Verify we're scrolled up (not stuck to bottom)
		expect(initialState.stickToBottom).toBe(false);

		const scrollTopBefore = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// Get the height of the collapsible element before collapse
		const collapsibleHeight = await page.evaluate(() =>
			document.getElementById("collapsible")!.getBoundingClientRect().height,
		);
		expect(collapsibleHeight).toBe(400);

		// Collapse the element — this shrinks content above/at the scroll position
		await page.evaluate(() => (window as any).__collapseElement());

		// Wait for ResizeObserver to fire
		await page.waitForTimeout(300);

		const scrollTopAfter = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// The collapsible element (400px) collapsed to 0px.
		// If scroll anchoring works, scrollTop should decrease by ~400px to keep
		// the same content visible. The current buggy code does NOT adjust scrollTop
		// when _stickToBottom is false, so scrollTopAfter === scrollTopBefore.
		//
		// We assert that scrollTop was adjusted (decreased by roughly the collapse amount).
		// This WILL FAIL on the buggy code — proving the bug.
		const delta = scrollTopBefore - scrollTopAfter;
		expect(delta, "scroll position was not compensated after content shrink").toBeGreaterThanOrEqual(350);
	});
});
