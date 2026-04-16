/**
 * Search E2E tests — SR-01, SR-02, SR-05, SR-07.
 *
 * Tests sidebar filter mode (client-side title matching), full search
 * page navigation, Ctrl+K keyboard shortcut, and archived auto-open/close.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, createGoal, deleteGoal, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Search (UI)", () => {
	/**
	 * SR-01: Sidebar filter mode — typing in the sidebar search input
	 * instantly filters visible items by title (client-side).
	 */
	test("SR-01: sidebar filter hides non-matching sessions @smoke", async ({ page }) => {
		// Create two sessions with distinct titles via API
		const id1 = await createSession();
		const id2 = await createSession();
		await waitForSessionStatus(id1, "idle");
		await waitForSessionStatus(id2, "idle");

		// Rename sessions so they have known, distinguishable titles
		await apiFetch(`/api/sessions/${id1}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "AlphaSearchTarget" }),
		});
		await apiFetch(`/api/sessions/${id2}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "BetaOtherItem" }),
		});

		await openApp(page);

		// Both sessions should be visible
		await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 10_000 });

		// Type a query that matches only the first session
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("AlphaSearch");

		// Wait for debounce (200ms) + render — matching item visible, other hidden
		await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BetaOtherItem")).not.toBeVisible({ timeout: 5_000 });

		// Type a query that matches only the second session
		await searchInput.fill("BetaOther");
		await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("AlphaSearchTarget")).not.toBeVisible({ timeout: 5_000 });

		// Clear the search — both should reappear
		await searchInput.fill("");
		await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 5_000 });

		// Cleanup
		await deleteSession(id1);
		await deleteSession(id2);
	});

	/**
	 * SR-01 continued: sidebar filter also works for goal titles.
	 */
	test("SR-01: sidebar filter matches goal titles", async ({ page }) => {
		const goal = await createGoal({ title: "UniqueGoalXYZ123" });

		await openApp(page);

		// Goal should be visible in sidebar (goal titles render as uppercase via CSS)
		await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 10_000 });

		// Search for the goal
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("UniqueGoalXYZ");
		await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 5_000 });

		// Search for something else — goal should disappear
		await searchInput.fill("NoMatchZZZ999");
		await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).not.toBeVisible({ timeout: 5_000 });

		// Clear — goal reappears
		await searchInput.fill("");
		await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 5_000 });

		await deleteGoal(goal.id);
	});

	/**
	 * SR-02: Full search navigation — clicking "Full Search" link navigates
	 * to #/search?q=<query> with the query pre-filled.
	 */
	test("SR-02: Full Search link navigates to search page", async ({ page }) => {
		await openApp(page);

		// Type a query in sidebar search
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("testquery");

		// Wait for the Full Search link to appear (it shows when query is non-empty)
		const fullSearchLink = page.getByText("Full Search");
		await expect(fullSearchLink).toBeVisible({ timeout: 5_000 });

		// Click the Full Search link
		await fullSearchLink.click();

		// Verify URL contains #/search with the query
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain("#/search");
			expect(hash).toContain("testquery");
		}).toPass({ timeout: 5_000 });

		// Verify the search page rendered — look for the back arrow or search input
		// The search page has its own input and result area
		await expect(page.locator("input").last()).toBeVisible({ timeout: 5_000 });
	});

	/**
	 * SR-05: Keyboard shortcut — Ctrl+K focuses the sidebar search input,
	 * Escape clears and blurs it.
	 */
	test("SR-05: Ctrl+K focuses search, Escape clears", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");

		// Verify search input exists
		await expect(searchInput).toBeVisible({ timeout: 10_000 });

		// Press Ctrl+K to focus the search input
		await page.keyboard.press("Control+k");

		// Verify the input is focused
		await expect(searchInput).toBeFocused({ timeout: 3_000 });

		// Type something
		await searchInput.fill("hello");
		await expect(searchInput).toHaveValue("hello");

		// Press Escape to clear and blur
		await page.keyboard.press("Escape");

		// Verify input is cleared
		await expect(searchInput).toHaveValue("", { timeout: 3_000 });

		// Verify input is blurred (not focused)
		await expect(searchInput).not.toBeFocused({ timeout: 3_000 });
	});

	/**
	 * SR-07: Archived auto-open/close — when searching, the archived section
	 * auto-opens to include archived items in the filter. When search is cleared,
	 * it auto-closes if it was opened by search (not manually).
	 *
	 * This test creates and terminates a session (which archives it), then
	 * searches for its title to trigger archived auto-open.
	 */
	test("SR-07: archived section auto-opens on search match", async ({ page }) => {
		// Create a session with a unique title, then terminate it to archive
		const id = await createSession();
		await waitForSessionStatus(id, "idle");
		await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "ArchivedSearchTest999" }),
		});
		// Terminate (archives the session)
		await deleteSession(id);

		await openApp(page);

		// The "Archived" header should be visible (always rendered)
		await expect(page.getByText(/Archived/i).first()).toBeVisible({ timeout: 10_000 });

		// The archived session should NOT be visible yet (section collapsed by default)
		await expect(page.getByText("ArchivedSearchTest999")).not.toBeVisible({ timeout: 3_000 });

		// Search for the archived session's title
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("ArchivedSearchTest999");

		// The archived section should auto-open and show the item
		await expect(page.getByText("ArchivedSearchTest999")).toBeVisible({ timeout: 15_000 });

		// Clear the search — archived section should auto-close
		await searchInput.fill("");

		// The archived session should disappear (section auto-closed by search)
		await expect(page.getByText("ArchivedSearchTest999")).not.toBeVisible({ timeout: 5_000 });
	});

	/**
	 * Verify no Content toggle exists in sidebar search.
	 * The old "Content" toggle should have been removed.
	 */
	test("no Content toggle in sidebar search", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("test");

		// Wait for controls to render
		await expect(page.getByText("Full Search")).toBeVisible({ timeout: 5_000 });

		// The "Content" toggle should NOT exist in the search controls area
		// (search-box is the parent of the search input)
		const searchBox = page.locator("search-box");
		const contentToggle = searchBox.getByText("Content");
		await expect(contentToggle).not.toBeVisible({ timeout: 2_000 });
	});
});
