import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/bg-process-popover.html")}`;

test.describe("BgProcessPill inside More popover", () => {
	test("dropdown should be portaled to body when inside backdrop-filter container", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// The pill is inside a container with backdrop-filter:blur(12px) and mask-image
		const toggleBtn = page.locator("[data-pill-toggle='p1']");
		await expect(toggleBtn).toBeVisible();

		// Click the pill toggle to expand the dropdown
		await toggleBtn.click();

		// Wait for the dropdown to appear
		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toBeVisible({ timeout: 3000 });

		// BUG: The dropdown is rendered INSIDE the pill container (which is inside
		// the backdrop-filter container), causing position:fixed to act like
		// position:absolute and getting clipped by mask-image.
		//
		// EXPECTED (after fix): dropdown should be a direct child of document.body
		// (portaled out of the backdrop-filter container).
		const isPortaledToBody = await dropdown.evaluate((el) => {
			return el.parentElement === document.body;
		});

		expect(isPortaledToBody).toBe(true);
		// ^ This FAILS on current code because the dropdown is a child of
		// [data-pill-container], not document.body.
	});

	test("dismiss button should work for pills inside More popover", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Open the "More" popover
		await page.locator("[data-more-toggle]").click();
		const popover = page.locator("[data-popover]");
		await expect(popover).toBeVisible();

		// Reset tracking state
		await page.evaluate(() => {
			(window as any).__dismissCalls = [];
			(window as any).__dismissingId = null;
		});

		// Click the dismiss (✕) button on a popover pill (hidden pill "old-1")
		await page.locator("[data-pill-dismiss='old-1']").click();

		// Wait for any async handling — animation would take 300ms if it played
		await page.waitForTimeout(500);

		// BUG: The dismiss callback is never called because:
		// 1. handlePillDismiss sets __dismissingId and expects animationend
		// 2. Popover pills have no animation wrapper with animationend listener
		// 3. So animationend never fires and __dismissingId stays stuck
		//
		// EXPECTED (after fix): dismiss callback fires immediately for popover pills
		const dismissState = await page.evaluate(() => {
			return {
				dismissCalls: (window as any).__dismissCalls as string[],
				dismissingId: (window as any).__dismissingId as string | null,
			};
		});

		// The dismiss callback should have been called with the pill's id
		expect(dismissState.dismissCalls).toContain("old-1");
		// ^ FAILS: callback never fires — dismissCalls is empty

		// _dismissingId should be cleared (not stuck)
		expect(dismissState.dismissingId).toBeNull();
		// ^ FAILS: dismissingId is stuck as "old-1"
	});
});
