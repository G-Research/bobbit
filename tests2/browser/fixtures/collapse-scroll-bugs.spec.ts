import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/collapse-scroll-bugs.html")}`;

test.describe("Collapse scroll bugs", () => {
	test("phantom padding after collapse", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom (stickToBottom = true)
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight);
		});
		await page.waitForTimeout(200);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(true);

		// Collapse all three 400px collapsible elements, calling handleResize after each
		for (const id of ["collapsible-1", "collapsible-2", "collapsible-3"]) {
			await page.evaluate((elId) => {
				(window as any).__collapseElement(elId);
				(window as any).__handleResize();
			}, id);
			await page.waitForTimeout(50);
		}
		await page.waitForTimeout(200);

		// Check the wrapper's paddingBottom — it should be "" or "0px" (no phantom padding)
		const paddingBottom = await page.evaluate(() =>
			document.getElementById("content-wrapper")!.style.paddingBottom,
		);
		const paddingValue = parseInt(paddingBottom, 10) || 0;

		expect(
			paddingValue,
			"phantom padding after collapse — expected no accumulated padding on content wrapper but found " + paddingBottom,
		).toBe(0);
	});

	test("latest message not visible after large collapse", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll to bottom (stickToBottom = true)
		await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			(window as any).__scrollTo(sc.scrollHeight);
		});
		await page.waitForTimeout(200);

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.stickToBottom).toBe(true);

		// Verify the final message is visible before collapse
		const visibleBefore = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			const fm = document.getElementById("final-message")!;
			const scRect = sc.getBoundingClientRect();
			const fmRect = fm.getBoundingClientRect();
			return fmRect.bottom <= scRect.bottom && fmRect.top >= scRect.top;
		});
		expect(visibleBefore, "final message should be visible before collapse").toBe(true);

		// Collapse the 2000px element and trigger resize
		await page.evaluate(() => {
			(window as any).__collapseElement("large-collapsible");
			(window as any).__handleResize();
		});
		await page.waitForTimeout(200);

		// The final message should still be visible within the scroll container viewport
		const result = await page.evaluate(() => {
			const sc = document.getElementById("scroll-container")!;
			const fm = document.getElementById("final-message")!;
			const scRect = sc.getBoundingClientRect();
			const fmRect = fm.getBoundingClientRect();
			return {
				fmBottom: fmRect.bottom,
				fmTop: fmRect.top,
				scBottom: scRect.bottom,
				scTop: scRect.top,
				visible: fmRect.bottom <= scRect.bottom + 1 && fmRect.top >= scRect.top - 1,
			};
		});

		expect(
			result.visible,
			`latest message not visible after large collapse — final message rect (top=${result.fmTop.toFixed(0)}, bottom=${result.fmBottom.toFixed(0)}) is outside scroll container (top=${result.scTop.toFixed(0)}, bottom=${result.scBottom.toFixed(0)})`,
		).toBe(true);
	});
});
