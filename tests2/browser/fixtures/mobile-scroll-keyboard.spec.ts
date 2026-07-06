import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-scroll-keyboard.html")}`;

test.describe("Stick-to-bottom scroll behavior", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

	test("starts at bottom, sticks when new content arrives", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		const state0 = await page.evaluate(() => (window as any).__getState());
		expect(state0.stickToBottom).toBe(true);
		expect(state0.distanceFromBottom).toBeLessThan(5);

		// Add content — should auto-scroll to bottom
		for (let i = 0; i < 5; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`New ${n}`), i);
			await page.waitForTimeout(30);
		}

		const state1 = await page.evaluate(() => (window as any).__getState());
		expect(state1.stickToBottom).toBe(true);
		expect(state1.distanceFromBottom).toBeLessThan(5);
	});

	test("user scrolls up → unsticks → new content does not pull back", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll up
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 200;
		});
		await page.waitForTimeout(50);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(false);

		const scrollBefore = state.scrollTop;

		// New content arrives — should NOT scroll
		for (let i = 0; i < 5; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`Stream ${n}`), i);
			await page.waitForTimeout(30);
		}

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(scrollAfter).toBe(scrollBefore);
	});

	test("user scrolls back to bottom → re-sticks", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll up
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 200;
		});
		await page.waitForTimeout(50);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(false);

		// Scroll back to bottom
		await page.evaluate(() => {
			const el = document.getElementById("scroll-container")!;
			el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(50);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(true);

		// New content should auto-scroll
		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		await page.evaluate(() => (window as any).__addMessage("Re-stuck content"));
		await page.waitForTimeout(50);
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

		// Open keyboard — shrinks container
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForTimeout(200);

		// Container shrank, but we were at the bottom so still stuck
		const state = await page.evaluate(() => (window as any).__getState());
		// After container shrinks, the distance from bottom should still be small
		// because ResizeObserver fires and scrolls us to the new bottom
		expect(state.stickToBottom).toBe(true);
	});

	test("keyboard open: user scrolled up stays unstuck, no jump", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll to middle
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 300;
		});
		await page.waitForTimeout(50);
		expect((await page.evaluate(() => (window as any).__getState())).stickToBottom).toBe(false);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		// Open keyboard
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForTimeout(200);

		// Add content
		for (let i = 0; i < 3; i++) {
			await page.evaluate((n) => (window as any).__addMessage(`Msg ${n}`), i);
			await page.waitForTimeout(30);
		}

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
		await page.waitForTimeout(50);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		// Repeated workflow bar updates
		for (let i = 0; i < 10; i++) {
			await page.evaluate(() => (window as any).__simulateWorkflowBarUpdate());
			await page.waitForTimeout(20);
		}

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(scrollAfter).toBe(scrollBefore);
	});

	test("typing in textarea does not cause scroll jump when unstuck", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Scroll to middle
		await page.evaluate(() => {
			document.getElementById("scroll-container")!.scrollTop = 400;
		});
		await page.waitForTimeout(50);

		await page.locator("#chat-input").focus();
		await page.evaluate(() => (window as any).__simulateKeyboardOpen(300));
		await page.waitForTimeout(100);

		const scrollBefore = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);

		await page.locator("#chat-input").type("Hello world test", { delay: 20 });
		await page.waitForTimeout(50);

		const scrollAfter = await page.evaluate(
			() => document.getElementById("scroll-container")!.scrollTop,
		);
		expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(10);
	});
});
