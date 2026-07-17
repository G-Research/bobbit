import { test, expect } from "@playwright/test";
import path from "node:path";
import { waitForStableScroll, waitForFrames } from "../_helpers/stable-wait.js";

const TEST_PAGE = `file://${path.resolve("tests/mobile-scroll-keyboard.html")}`;

const SCROLLER = "#scroll-container";

/** Wait until the stick-to-bottom flag reaches the expected value (scroll events are async). */
async function waitForStick(page: import("@playwright/test").Page, expected: boolean) {
	await page.waitForFunction(
		(want) => (window as any).__getState().stickToBottom === want,
		expected,
	);
}

test.describe("Stick-to-bottom scroll behavior", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

	test("starts at bottom, sticks when new content arrives", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		const state0 = await page.evaluate(() => (window as any).__getState());
		expect(state0.stickToBottom).toBe(true);
		expect(state0.distanceFromBottom).toBeLessThan(5);

		// Add content — should auto-scroll to bottom. Wait for the observable
		// outcome of each append: the ResizeObserver re-pin brings us back to
		// the bottom before the next message lands.
		for (let i = 0; i < 5; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`New ${n}`), i);
			await page.waitForFunction(() => {
				const el = document.getElementById("scroll-container")!;
				return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
			});
		}

		const state1 = await page.evaluate(() => (window as any).__getState());
		expect(state1.stickToBottom).toBe(true);
		expect(state1.distanceFromBottom).toBeLessThan(5);
	});

	test("user scrolls up → unsticks → new content does not pull back", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll up — wait for the async scroll event to flip the flag
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 200;
		});
		await waitForStick(page, false);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(false);

		const scrollBefore = state.scrollTop;

		// New content arrives — should NOT scroll. Frame waits guarantee the
		// ResizeObserver callback for each append has been delivered (a buggy
		// re-pin would have fired by then); the final stability wait catches
		// any straggling scroll adjustment before we read the outcome.
		for (let i = 0; i < 5; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`Stream ${n}`), i);
			await waitForFrames(page);
		}
		await waitForStableScroll(page, SCROLLER);

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(scrollAfter).toBe(scrollBefore);
	});

	test("user scrolls back to bottom → re-sticks", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll up — wait for the async scroll event to flip the flag
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 200;
		});
		await waitForStick(page, false);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(false);

		// Scroll back to bottom — wait for the flag to re-stick
		await page.evaluate(() => {
			const el = document.getElementById("scroll-container")!;
			el.scrollTop = el.scrollHeight;
		});
		await waitForStick(page, true);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(true);

		// New content should auto-scroll — wait for the observable scroll
		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		await page.evaluate(() => (window as any).__addMessage("Re-stuck content"));
		await page.waitForFunction(
			(prev) => document.getElementById("scroll-container")!.scrollTop > prev,
			scrollBefore,
		);
		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(scrollAfter).toBeGreaterThan(scrollBefore);
	});

	test("keyboard open: user at bottom stays stuck, position stable", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// At bottom, stuck
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(true);

		// Open keyboard — shrinks container. Wait for the layout change to be
		// observable, then for any resulting scroll adjustment to settle.
		const heightBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.clientHeight,
		);
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForFunction(
			(h) => document.getElementById("scroll-container")!.clientHeight < h,
			heightBefore,
		);
		await waitForStableScroll(page, SCROLLER);

		// Container shrank, but we were at the bottom so still stuck
		const state = await page.evaluate(() => (window as any).__getState());
		// After container shrinks, the distance from bottom should still be small
		// because ResizeObserver fires and scrolls us to the new bottom
		expect(state.stickToBottom).toBe(true);
	});

	test("keyboard open: user scrolled up stays unstuck, no jump", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll to middle — wait for the async scroll event to flip the flag
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 300;
		});
		await waitForStick(page, false);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(false);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		// Open keyboard — wait for the layout shrink to be observable and
		// any resulting scroll adjustment to settle
		const heightBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.clientHeight,
		);
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForFunction(
			(h) => document.getElementById("scroll-container")!.clientHeight < h,
			heightBefore,
		);
		await waitForStableScroll(page, SCROLLER);

		// Add content — frame waits guarantee each ResizeObserver tick has
		// been delivered; the stability wait catches any straggling (buggy)
		// scroll before we read the outcome.
		for (let i = 0; i < 3; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`Msg ${n}`), i);
			await waitForFrames(page);
		}
		await waitForStableScroll(page, SCROLLER);

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		// Should not have jumped to bottom
		expect(scrollAfter).toBe(scrollBefore);
	});

	test("workflow bar update does not affect vertical scroll", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 400;
		});
		await waitForStableScroll(page, SCROLLER);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		// Repeated workflow bar updates — a frame wait per update lets any
		// (buggy) vertical scroll side-effect land; final stability wait
		// ensures the smooth horizontal scroll has settled before we read.
		for (let i = 0; i < 10; i++) {
			await page.evaluate(() => (window as any).__simulateWorkflowBarUpdate());
			await waitForFrames(page);
		}
		await waitForStableScroll(page, SCROLLER);

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(scrollAfter).toBe(scrollBefore);
	});

	test("typing in textarea does not cause scroll jump when unstuck", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll to middle — wait for scroll state to settle
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 400;
		});
		await waitForStableScroll(page, SCROLLER);

		await page.locator("#chat-input").focus();
		const heightBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.clientHeight,
		);
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForFunction(
			(h) => document.getElementById("scroll-container")!.clientHeight < h,
			heightBefore,
		);
		await waitForStableScroll(page, SCROLLER);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		await page.locator("#chat-input").type("Hello world test", { delay: 20 });
		await waitForStableScroll(page, SCROLLER);

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(10);
	});
});
