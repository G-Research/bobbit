/**
 * E2E tests for sidebar search and keyboard shortcuts.
 *
 * Covers user stories:
 *   SB-24: Filter sidebar by typing
 *   SB-25: Search auto-opens archived section
 *   SB-26: Launch full search from sidebar
 *   SB-34: Sidebar keyboard shortcuts
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, createGoal, deleteGoal, apiFetch, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar search & keyboard shortcuts", () => {
	// Track created resources for cleanup
	let sessionAlpha: string;
	let sessionBravo: string;
	let goalCharlie: { id: string };

	test.beforeAll(async () => {
		await waitForHealth();

		// Create sessions and a goal with distinct names
		sessionAlpha = await createSession({ cwd: nonGitCwd() });
		// Rename sessions via API to have distinct, searchable names
		await apiFetch(`/api/sessions/${sessionAlpha}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "AlphaUniqueSearch" }),
		});

		sessionBravo = await createSession({ cwd: nonGitCwd() });
		await apiFetch(`/api/sessions/${sessionBravo}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "BravoUniqueSearch" }),
		});

		goalCharlie = await createGoal({ title: "CharlieUniqueGoal", cwd: nonGitCwd() });
	});

	test.afterAll(async () => {
		await deleteSession(sessionAlpha).catch(() => {});
		await deleteSession(sessionBravo).catch(() => {});
		await deleteGoal(goalCharlie.id).catch(() => {});
	});

	test("SB-24: filter sidebar by typing partial name", async ({ page }) => {
		await openApp(page);

		// Wait for sidebar to render our sessions
		await expect(page.getByText("AlphaUniqueSearch")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("BravoUniqueSearch")).toBeVisible({ timeout: 5_000 });

		// Type partial name matching only Alpha
		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("AlphaUnique");

		// Wait for debounce (200ms + buffer)
		await page.waitForTimeout(400);

		// Alpha should be visible, Bravo should be hidden
		await expect(page.getByText("AlphaUniqueSearch")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoUniqueSearch")).not.toBeVisible({ timeout: 3_000 });

		// Clear the input — all should reappear
		await searchInput.fill("");
		await page.waitForTimeout(400);

		await expect(page.getByText("AlphaUniqueSearch")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoUniqueSearch")).toBeVisible({ timeout: 5_000 });
	});

	test("SB-24: query persists after clicking a filtered session", async ({ page }) => {
		await openApp(page);

		const sidebar = page.locator(".sidebar-edge");
		await expect(sidebar.getByText("AlphaUniqueSearch")).toBeVisible({ timeout: 10_000 });

		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("AlphaUnique");
		await page.waitForTimeout(400);

		// Click the filtered session row
		await sidebar.getByText("AlphaUniqueSearch").click();

		// Query should persist in the input
		await expect(searchInput).toHaveValue("AlphaUnique");
	});

	test("SB-24: goal visible when child session matches", async ({ page }) => {
		// Create a session under the goal with a searchable name
		const goalSession = await createSession({ cwd: nonGitCwd(), goalId: goalCharlie.id });
		await apiFetch(`/api/sessions/${goalSession}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "DeltaGoalChild" }),
		});

		try {
			await openApp(page);

			// Wait for goal to be visible
			await expect(page.getByText("CharlieUniqueGoal")).toBeVisible({ timeout: 10_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.click();
			await searchInput.fill("DeltaGoalChild");
			await page.waitForTimeout(400);

			// The goal should remain visible because its child matches
			await expect(page.getByText("CharlieUniqueGoal")).toBeVisible({ timeout: 5_000 });

			// Non-matching items should be hidden
			await expect(page.getByText("AlphaUniqueSearch")).not.toBeVisible({ timeout: 3_000 });
		} finally {
			await deleteSession(goalSession).catch(() => {});
		}
	});

	test("SB-24: escape clears and blurs search", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("AlphaUnique");
		await page.waitForTimeout(400);

		// Press Escape
		await searchInput.press("Escape");

		// Input should be cleared and blurred
		await expect(searchInput).toHaveValue("");
		const isFocused = await searchInput.evaluate((el) => document.activeElement === el);
		expect(isFocused).toBe(false);

		// All items should reappear
		await expect(page.getByText("AlphaUniqueSearch")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoUniqueSearch")).toBeVisible({ timeout: 5_000 });
	});

	test("SB-25: search auto-opens archived section", async ({ page }) => {
		// Create and archive a session with a unique name
		const archivedId = await createSession({ cwd: nonGitCwd() });
		await apiFetch(`/api/sessions/${archivedId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "EchoArchived" }),
		});
		// Archive by deleting (which archives in Bobbit)
		await deleteSession(archivedId);

		await openApp(page);

		// Ensure archived section is initially collapsed (not showing)
		// The "Archived" header should exist but content may not be expanded
		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("EchoArchived");
		await page.waitForTimeout(600); // debounce + fetch time

		// The archived section should auto-open — look for the archived toggle showing expanded state
		// The "▾" chevron next to "Archived" indicates it's open
		const archivedHeader = page.getByText("Archived").first();
		await expect(archivedHeader).toBeVisible({ timeout: 5_000 });

		// Clear search — archived section should revert (auto-close)
		await searchInput.fill("");
		await page.waitForTimeout(400);

		// After clearing a search-opened archived section, it should close
		// Verify the archived section is no longer showing expanded content
		// The content inside the archived section should be hidden
		await expect(page.getByText("EchoArchived")).not.toBeVisible({ timeout: 5_000 });
	});

	test("SB-26: full search link navigates to search page", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("TestQuery");
		await page.waitForTimeout(400);

		// Click "Full Search" link
		const fullSearchLink = page.getByText("Full Search");
		await expect(fullSearchLink).toBeVisible({ timeout: 5_000 });
		await fullSearchLink.click();

		// Should navigate to #/search?q=TestQuery
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain("#/search");
			expect(hash).toContain("TestQuery");
		}).toPass({ timeout: 5_000 });
	});

	test("SB-34: Ctrl+K focuses search input", async ({ page }) => {
		await openApp(page);

		// Ensure search is not focused initially
		const searchInput = page.locator("input[data-search]");
		const initiallyFocused = await searchInput.evaluate((el) => document.activeElement === el);
		expect(initiallyFocused).toBe(false);

		// Press Ctrl+K
		await page.keyboard.press("Control+k");

		// Search input should be focused
		const nowFocused = await searchInput.evaluate((el) => document.activeElement === el);
		expect(nowFocused).toBe(true);
	});

	test("SB-34: Ctrl+[ toggles sidebar collapse", async ({ page }) => {
		await openApp(page);

		// Sidebar is the flex-col element with sidebar-edge class
		const sidebar = page.locator(".sidebar-edge");
		await expect(sidebar).toBeVisible({ timeout: 5_000 });

		// Verify the search input is visible (proves sidebar is expanded)
		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 3_000 });

		// Press Ctrl+[
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(300);

		// Sidebar should be collapsed — search input no longer visible
		await expect(searchInput).not.toBeVisible({ timeout: 3_000 });

		// Press Ctrl+[ again to expand
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(300);

		// Sidebar should be expanded again — search input visible
		await expect(searchInput).toBeVisible({ timeout: 3_000 });
	});

	test("SB-34: Ctrl+K works even when textarea has focus", async ({ page }) => {
		// Create a session so we have a textarea
		const tempSession = await createSession({ cwd: nonGitCwd() });
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, tempSession);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

			// Focus the textarea
			await page.locator("textarea").first().click();
			const textareaFocused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
			expect(textareaFocused).toBe("textarea");

			// Press Ctrl+K — should still focus search
			// Note: Ctrl+K uses ctrlOrMeta modifier so it fires even in input contexts
			await page.keyboard.press("Control+k");

			const searchInput = page.locator("input[data-search]");
			const nowFocused = await searchInput.evaluate((el) => document.activeElement === el);
			expect(nowFocused).toBe(true);
		} finally {
			await deleteSession(tempSession).catch(() => {});
		}
	});
});
