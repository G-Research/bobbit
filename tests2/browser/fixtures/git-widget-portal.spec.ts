import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/git-widget-portal.html")}`;

test.describe("Git widget dropdown inside transformed ancestor", () => {
	// Mobile viewport — simulates the conditions where preview slider is active
	test.use({ viewport: { width: 375, height: 667 } });

	test("dropdown should be visible within viewport when expanded inside transformed ancestor", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Click the git status pill to expand the dropdown
		await page.click("#git-pill");

		// Wait a frame for positioning to apply
		await page.waitForTimeout(100);

		// Verify the dropdown is toggled on
		const isExpanded = await page.evaluate(() => (window as any).__isExpanded());
		expect(isExpanded).toBe(true);

		// Get the dropdown's bounding rect as seen by the browser
		const dropdownRect = await page.evaluate(() => {
			const dd = document.getElementById("git-status-dropdown")!;
			const r = dd.getBoundingClientRect();
			return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
		});

		// Get the viewport dimensions
		const viewport = await page.evaluate(() => ({
			width: window.innerWidth,
			height: window.innerHeight,
		}));

		// The dropdown must have non-zero dimensions (it rendered)
		expect(dropdownRect.width).toBeGreaterThan(0);
		expect(dropdownRect.height).toBeGreaterThan(0);

		// THE KEY ASSERTION: The dropdown must be visible within the viewport.
		// With the bug, position:fixed inside a transformed ancestor causes the
		// dropdown to be positioned relative to the transform ancestor, not the
		// viewport. Combined with overflow:hidden on .preview-slider, the
		// dropdown is clipped and its visible rect is outside the viewport or
		// has zero intersection with it.
		const isWithinViewport =
			dropdownRect.top >= 0 &&
			dropdownRect.left >= 0 &&
			dropdownRect.bottom <= viewport.height &&
			dropdownRect.right <= viewport.width;

		// Also check: is the dropdown actually not clipped by the overflow:hidden ancestor?
		// Use an intersection check: can the user actually see/tap the dropdown?
		const isVisibleToUser = await page.evaluate(() => {
			const dd = document.getElementById("git-status-dropdown")!;
			const r = dd.getBoundingClientRect();
			// Check if the element at the dropdown's center is the dropdown or a descendant
			const centerX = r.left + r.width / 2;
			const centerY = r.top + r.height / 2;
			const elAtCenter = document.elementFromPoint(centerX, centerY);
			return elAtCenter !== null && (dd === elAtCenter || dd.contains(elAtCenter));
		});

		const isVisible = isWithinViewport && isVisibleToUser;
		expect(
			isVisible,
			"dropdown should be visible within viewport when expanded inside transformed ancestor"
		).toBe(true);
	});


});
