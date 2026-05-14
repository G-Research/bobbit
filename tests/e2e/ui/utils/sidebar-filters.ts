/**
 * Test helpers for the sidebar Filters popover.
 *
 * The old sidebar had a single "See Archived" button. It has been replaced
 * with a Filters popover containing three toggles (Show Archived / Show Busy
 * / Show Read). These helpers wrap the new UI so tests don't have to know
 * about its internal selectors.
 *
 * Stable selectors (defined in `src/ui/components/sidebar-filters.ts`):
 *   - Trigger button:    [data-testid="sidebar-filters-button"]
 *   - Popover panel:     [data-testid="sidebar-filters-popover"]
 *   - Show Archived row: [data-testid="sidebar-filter-archived"]
 *   - Show Busy row:     [data-testid="sidebar-filter-busy"]
 *   - Show Read row:     [data-testid="sidebar-filter-read"]
 *
 * The trigger button itself carries the "active" styling
 * (`text-primary bg-primary/10 font-medium`) whenever any filter differs from
 * its default — so tests that previously asserted active class on the See
 * Archived button can continue to assert it on `filtersButton(page)`.
 */
import type { Locator, Page } from "@playwright/test";

/**
 * Returns the visible Filters trigger button locator. Both desktop and mobile
 * sidebars render the same `data-testid`; using `:visible` picks whichever is
 * mounted for the current viewport.
 */
export function filtersButton(page: Page): Locator {
	return page.locator("[data-testid='sidebar-filters-button']:visible").first();
}

/** Open the Filters popover (no-op if already open). */
export async function openFiltersPopover(page: Page): Promise<void> {
	const btn = filtersButton(page);
	const popover = page.locator("[data-testid='sidebar-filters-popover']");
	if ((await popover.count()) === 0) {
		await btn.click();
		await popover.first().waitFor({ state: "visible", timeout: 5_000 });
	}
}

/**
 * Click the "Show Archived" toggle row in the Filters popover. Opens the
 * popover first if it isn't already open. This is the click-based equivalent
 * of the old "See Archived" button click — exercises the visible UI.
 */
export async function clickShowArchivedToggle(page: Page): Promise<void> {
	await openFiltersPopover(page);
	await page.locator("[data-testid='sidebar-filter-archived']:visible").first().click();
}

/**
 * Toggle Show Archived via the registered Alt+Shift+A keyboard shortcut.
 * Faster than the click path and works regardless of focus
 * (the shortcut is registered with `allowInInput: true`).
 */
export async function toggleShowArchivedViaKeyboard(page: Page): Promise<void> {
	await page.keyboard.press("Alt+Shift+A");
}
