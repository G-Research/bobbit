import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/scroll-anchor-shrink.html")}`;

test.describe("Scroll anchor on shrink", () => {
	test("compensates scrollTop when content shrinks while scrolled up", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom so stickToBottom = true, then scroll up
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

		// Verify collapsible is 400px
		const collapsibleHeight = await page.evaluate(() =>
			document.getElementById("collapsible")!.getBoundingClientRect().height,
		);
		expect(collapsibleHeight).toBe(400);

		// Collapse the element then trigger the resize handler
		// (ResizeObserver doesn't fire in headless Chromium, so we call it manually)
		await page.evaluate(() => {
			(window as any).__collapseElement();
			(window as any).__handleResize();
		});

		await page.waitForTimeout(100);

		const scrollTopAfter = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// The collapsible (400px) collapsed to 0px. The resize handler should
		// adjust scrollTop down by ~400px to keep the same content visible.
		// Without compensation, scrollTop stays the same (or is browser-clamped),
		// causing the viewport to shift.
		const delta = scrollTopBefore - scrollTopAfter;
		expect(delta, "scroll position was not compensated after content shrink").toBeGreaterThanOrEqual(350);
	});

	test("does not adjust scrollTop when stuck to bottom", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom (stickToBottom = true)
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight);
		});
		await page.waitForTimeout(200);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(true);

		// Collapse and trigger resize
		await page.evaluate(() => {
			(window as any).__collapseElement();
			(window as any).__handleResize();
		});
		await page.waitForTimeout(100);

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
		await page.waitForTimeout(200);

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
		await page.waitForTimeout(100);

		const scrollTopAfter = await page.evaluate(() =>
			document.getElementById("scroll-container")!.scrollTop,
		);

		// scrollTop should not change — new content below viewport shouldn't pull user down
		expect(scrollTopAfter).toBe(scrollTopBefore);
	});
});
