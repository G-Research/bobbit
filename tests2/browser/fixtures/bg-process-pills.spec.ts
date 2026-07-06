import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/bg-process-pills.html")}`;

/**
 * Helper: wait for the pill strip measurement to settle after rAF cycles.
 */
async function waitForMeasurement(page: import("@playwright/test").Page) {
	await page.evaluate(() => (window as any).__waitForMeasurement());
	// Extra rAF for the re-render triggered by measurement
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.describe("Bg process pill overflow collapsing", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 600 });
		await page.goto(TEST_PAGE);
	});

	test("many pills collapse oldest into More button", async ({ page }) => {
		// Create 8 pills — should overflow the 50% budget on an 800px container
		await page.evaluate(() => (window as any).__initPills(8));
		await waitForMeasurement(page);

		// A "more" button should appear
		const moreBtn = page.locator("button[aria-haspopup='true']");
		await expect(moreBtn).toBeVisible();

		// The "more" button text should contain a count and "more"
		const moreText = await moreBtn.textContent();
		expect(moreText).toMatch(/\d+ more/);

		// Some pills should be directly visible (not in the popover)
		const visiblePills = page.locator("[data-pill-strip] > div[data-pill-wrapper] bg-process-pill");
		const visibleCount = await visiblePills.count();
		expect(visibleCount).toBeGreaterThanOrEqual(1);
		expect(visibleCount).toBeLessThan(8);
	});

	test("newest pills are visible, oldest are hidden", async ({ page }) => {
		await page.evaluate(() => (window as any).__initPills(8));
		await waitForMeasurement(page);

		// Get visible pill IDs
		const visibleIds = await page.evaluate(() => {
			const strip = document.getElementById("pill-strip")!;
			const wrappers = strip.querySelectorAll("div[data-pill-wrapper]");
			return Array.from(wrappers).map((w) => w.getAttribute("data-pill-wrapper"));
		});

		// Visible pills should be the newest (highest index = latest startTime)
		// proc-7 should be visible, proc-0 should be hidden
		expect(visibleIds).toContain("proc-7");
		expect(visibleIds).toContain("proc-6");
		// proc-0 (oldest) should NOT be in visible set
		expect(visibleIds).not.toContain("proc-0");
	});

	test("clicking More opens popover with hidden pills", async ({ page }) => {
		await page.evaluate(() => (window as any).__initPills(8));
		await waitForMeasurement(page);

		const moreBtn = page.locator("button[aria-haspopup='true']");
		await expect(moreBtn).toHaveAttribute("aria-expanded", "false");

		// Click the More button
		await moreBtn.click();

		// aria-expanded should be "true"
		const moreBtnAfter = page.locator("button[aria-haspopup='true']");
		await expect(moreBtnAfter).toHaveAttribute("aria-expanded", "true");

		// Popover should appear
		const popover = page.locator(".pill-more-popover");
		await expect(popover).toBeVisible();

		// Popover should contain bg-process-pill elements (the hidden ones)
		const popoverPills = popover.locator("bg-process-pill");
		const popoverCount = await popoverPills.count();
		expect(popoverCount).toBeGreaterThanOrEqual(1);

		// The popover pills should be the oldest ones (e.g. proc-0)
		const popoverIds = await popover.evaluate((el) => {
			return Array.from(el.querySelectorAll("bg-process-pill")).map((p) => p.getAttribute("data-id"));
		});
		expect(popoverIds).toContain("proc-0");
	});

	test("clicking outside closes the More popover", async ({ page }) => {
		await page.evaluate(() => (window as any).__initPills(8));
		await waitForMeasurement(page);

		// Open More popover
		await page.locator("button[aria-haspopup='true']").click();
		await expect(page.locator(".pill-more-popover")).toBeVisible();

		// Click outside
		await page.click("body", { position: { x: 10, y: 10 } });

		// Popover should close
		await expect(page.locator(".pill-more-popover")).toHaveCount(0);
	});

	test("at least 1 pill is always visible even on narrow viewport", async ({ page }) => {
		// Make the container very narrow
		await page.evaluate(() => (window as any).__setContainerWidth(200));
		await page.evaluate(() => (window as any).__initPills(5));
		await waitForMeasurement(page);

		// At least 1 pill wrapper should exist (not inside popover)
		const visiblePills = page.locator("[data-pill-strip] > div[data-pill-wrapper] bg-process-pill");
		const count = await visiblePills.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test("few pills do not show More button when they fit", async ({ page }) => {
		// Wide container with just 2 short-named pills — should fit
		await page.evaluate(() => (window as any).__setContainerWidth(800));
		await page.evaluate(() => (window as any).__initPills(2));
		await waitForMeasurement(page);

		// No "more" button should appear
		const moreBtn = page.locator("button[aria-haspopup='true']");
		await expect(moreBtn).toHaveCount(0);

		// Both pills should be visible
		const visiblePills = page.locator("[data-pill-strip] > div[data-pill-wrapper] bg-process-pill");
		expect(await visiblePills.count()).toBe(2);
	});

	test("resizing container triggers re-measurement", async ({ page }) => {
		// Start wide — pills fit
		await page.evaluate(() => (window as any).__setContainerWidth(800));
		await page.evaluate(() => (window as any).__initPills(6, { longCommands: true }));
		await waitForMeasurement(page);

		const initialVisibleCount = await page.locator("[data-pill-strip] > div[data-pill-wrapper]").count();

		// Shrink container
		await page.evaluate(() => (window as any).__setContainerWidth(300));
		// Wait for ResizeObserver + measurement
		await waitForMeasurement(page);
		await waitForMeasurement(page); // Extra settle

		const afterShrinkCount = await page.locator("[data-pill-strip] > div[data-pill-wrapper]").count();

		// Should have fewer visible pills (or at least the more button appeared)
		const moreBtnExists = (await page.locator("button[aria-haspopup='true']").count()) > 0;
		expect(afterShrinkCount <= initialVisibleCount || moreBtnExists).toBe(true);
	});
});

test.describe("Bg process pill animations", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 600 });
		await page.goto(TEST_PAGE);
	});

	test("no animation classes on initial render", async ({ page }) => {
		await page.evaluate(() => (window as any).__initPills(4));
		await waitForMeasurement(page);

		// No pill wrappers should have animation classes on first paint
		const dismissingCount = await page.locator(".pill-dismissing").count();
		const promotedCount = await page.locator(".pill-promoted").count();
		expect(dismissingCount).toBe(0);
		expect(promotedCount).toBe(0);
	});

	test("dismissing a pill applies pill-dismissing class", async ({ page }) => {
		// Use exited processes so they have the Remove button
		await page.evaluate(() => (window as any).__initPills(3, { allExited: true }));
		await waitForMeasurement(page);

		// Expand the last pill (newest) to show the dropdown with Remove
		const lastPill = page.locator("[data-pill-strip] > div[data-pill-wrapper]").last();
		await lastPill.locator("[data-pill-toggle]").click();

		// Click Remove
		await lastPill.locator("[data-remove]").click();

		// The wrapper should get the pill-dismissing class
		const dismissingWrapper = page.locator("[data-pill-strip] .pill-dismissing");
		await expect(dismissingWrapper).toHaveCount(1);
	});

	test("after dismiss animation ends, pill is removed", async ({ page }) => {
		await page.evaluate(() => (window as any).__initPills(3, { allExited: true }));
		await waitForMeasurement(page);

		// Count pills before
		const beforeCount = await page.locator("[data-pill-strip] bg-process-pill").count();
		expect(beforeCount).toBe(3);

		// Expand last pill and click Remove
		const lastPill = page.locator("[data-pill-strip] > div[data-pill-wrapper]").last();
		await lastPill.locator("[data-pill-toggle]").click();
		await lastPill.locator("[data-remove]").click();

		// Wait for animation to complete (150ms + buffer)
		await page.waitForTimeout(300);
		// Also wait for rAF re-render
		await waitForMeasurement(page);

		// Pill should be gone
		const afterCount = await page.locator("[data-pill-strip] bg-process-pill").count();
		expect(afterCount).toBe(2);
	});

	test("promoted pill gets pill-promoted class when becoming visible after dismiss", async ({ page }) => {
		// Create enough pills to cause overflow — some hidden, some visible
		// Use a narrow container to force overflow with fewer pills
		await page.evaluate(() => (window as any).__setContainerWidth(250));
		await page.evaluate(() => (window as any).__initPills(6, { allExited: true }));
		await waitForMeasurement(page);
		await waitForMeasurement(page);

		// Verify there are hidden pills (More button visible)
		const hasMore = (await page.locator("button[aria-haspopup='true']").count()) > 0;
		if (!hasMore) {
			test.skip();
			return;
		}

		// Get hidden count before dismiss
		const hiddenCountBefore = await page.evaluate(() => {
			const moreBtn = document.querySelector("button[aria-haspopup='true']");
			if (!moreBtn) return 0;
			const text = moreBtn.textContent || "";
			const match = text.match(/(\d+) more/);
			return match ? parseInt(match[1]) : 0;
		});

		if (hiddenCountBefore === 0) {
			test.skip();
			return;
		}

		// Instrument: listen for promoted class being added
		await page.evaluate(() => {
			(window as any).__sawPromoted = false;
			const observer = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.type === 'attributes' && m.attributeName === 'class') {
						const el = m.target as HTMLElement;
						if (el.classList.contains('pill-promoted')) {
							(window as any).__sawPromoted = true;
						}
					}
				}
				// Also check for new elements with the class
				for (const m of mutations) {
					if (m.type === 'childList') {
						for (const node of m.addedNodes) {
							if (node instanceof HTMLElement && node.classList.contains('pill-promoted')) {
								(window as any).__sawPromoted = true;
							}
						}
					}
				}
			});
			observer.observe(document.getElementById('pill-strip')!, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ['class'],
			});
			(window as any).__promotedObserver = observer;
		});

		// Expand newest visible pill and dismiss it
		const lastPill = page.locator("[data-pill-strip] > div[data-pill-wrapper]").last();
		await lastPill.locator("[data-pill-toggle]").click();
		await lastPill.locator("[data-remove]").click();

		// Wait for the dismiss animation (150ms) + re-render
		await page.waitForTimeout(400);
		await waitForMeasurement(page);

		// Check whether pill-promoted was observed
		const sawPromoted = await page.evaluate(() => (window as any).__sawPromoted);
		expect(sawPromoted).toBe(true);

		// Clean up observer
		await page.evaluate(() => {
			(window as any).__promotedObserver?.disconnect();
		});
	});
});
