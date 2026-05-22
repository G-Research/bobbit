/**
 * Search E2E tests — SR-01, SR-02, SR-05, SR-07.
 *
 * Keeps served-app coverage for sidebar search wiring, keyboard shortcuts,
 * full-search navigation, and archived auto-open/close. Full search result
 * grouping/filter rendering lives in the lightweight search-page fixture.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, createGoal, deleteGoal, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Search (UI)", () => {
	test("SR-01: sidebar filter matches session and goal titles @smoke", async ({ page }) => {
		const id1 = await createSession();
		const id2 = await createSession();
		const goal = await createGoal({ title: "UniqueGoalXYZ123" });
		try {
			await waitForSessionStatus(id1, "idle");
			await waitForSessionStatus(id2, "idle");
			await apiFetch(`/api/sessions/${id1}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "AlphaSearchTarget" }),
			});
			await apiFetch(`/api/sessions/${id2}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "BetaOtherItem" }),
			});

			await openApp(page);
			await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 10_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("AlphaSearch");
			await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("BetaOtherItem")).not.toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).not.toBeVisible({ timeout: 5_000 });

			await searchInput.fill("BetaOther");
			await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("AlphaSearchTarget")).not.toBeVisible({ timeout: 5_000 });

			await searchInput.fill("UniqueGoalXYZ");
			await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("AlphaSearchTarget")).not.toBeVisible({ timeout: 5_000 });

			await searchInput.fill("");
			await expect(page.getByText("AlphaSearchTarget")).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("BetaOtherItem")).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("UniqueGoalXYZ123", { exact: false })).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(id1).catch(() => {});
			await deleteSession(id2).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("SR-02: Full Search link navigates, with no sidebar Content toggle", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("testquery");

		const fullSearchLink = page.getByText("Full Search");
		await expect(fullSearchLink).toBeVisible({ timeout: 5_000 });
		const searchBox = page.locator("search-box");
		await expect(searchBox.getByText("Content")).not.toBeVisible({ timeout: 2_000 });

		await fullSearchLink.click();
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain("#/search");
			expect(hash).toContain("testquery");
		}).toPass({ timeout: 5_000 });
		await expect(page.locator("input").last()).toBeVisible({ timeout: 5_000 });
	});

	test("SR-05: Ctrl+K focuses search, Escape clears", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 10_000 });
		await expect.poll(
			() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
			{ timeout: 15_000 },
		).toBe(true);

		await page.evaluate(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", {
				key: "k", code: "KeyK", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
			}));
		});
		await expect(searchInput).toBeFocused({ timeout: 5_000 });

		await searchInput.fill("hello");
		await expect(searchInput).toHaveValue("hello");
		await page.keyboard.press("Escape");
		await expect(searchInput).toHaveValue("", { timeout: 3_000 });
		await expect(searchInput).not.toBeFocused({ timeout: 3_000 });
	});

	test("SR-07: archived section auto-opens on search match", async ({ page }) => {
		const id = await createSession();
		try {
			await waitForSessionStatus(id, "idle");
			await apiFetch(`/api/sessions/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ArchivedSearchTest999" }),
			});
			await deleteSession(id);

			await openApp(page);
			await expect(page.locator("[data-testid='sidebar-filters-button']:visible").first())
				.toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("ArchivedSearchTest999")).not.toBeVisible({ timeout: 3_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("ArchivedSearchTest999");
			await expect(page.getByText("ArchivedSearchTest999")).toBeVisible({ timeout: 15_000 });

			await searchInput.fill("");
			await expect(page.getByText("ArchivedSearchTest999")).not.toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(id).catch(() => {});
		}
	});
});
