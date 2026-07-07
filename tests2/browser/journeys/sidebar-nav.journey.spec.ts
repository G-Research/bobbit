/**
 * Journey: Sidebar Navigation — v2 browser smoke
 * Covers: session switching, sidebar highlight, search/filter
 * Consolidated from: sidebar-navigation.spec.ts, sidebar-filters.spec.ts
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch, createGoal, deleteGoal } from "../_helpers/journey-fixture.js";
import { filtersButton, clickShowArchivedToggle, openFiltersPopover } from "../../../tests/e2e/ui/utils/sidebar-filters.js";

test.describe("Journey: Sidebar Navigation", () => {
	test("sidebar and new-session button visible on load", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("settings hash route renders settings text", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await page.waitForFunction(() => window.location.hash.includes("/settings"), null, { timeout: 20_000 });
		await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 15_000 });
	});

	test("session row visible in sidebar after creation", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("switch between two sessions updates URL", async ({ page }) => {
		const s1 = await createSession();
		const s2 = await createSession();
		await waitForSessionStatus(s1, "idle");
		await waitForSessionStatus(s2, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${s1}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(s1);
			await navigateToHash(page, `#/session/${s2}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(s2);
		} finally {
			await deleteSession(s1);
			await deleteSession(s2);
		}
	});

	// ── SB-01/SB-04: active session row highlighted (CT-03 contract) ──

	test("active session row is highlighted with data-nav-active after navigation", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Row must have data-nav-active="true" OR sidebar-session-active class
			await expect(
				page.locator(
					`[data-session-id="${sessionId}"][data-nav-active="true"], ` +
					`[data-session-id="${sessionId}"].sidebar-session-active`,
				).first(),
			).toBeVisible({ timeout: 15_000 });

			// URL must contain the session ID
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("clicking a different session row updates active highlight", async ({ page }) => {
		const s1 = await createSession();
		const s2 = await createSession();
		await waitForSessionStatus(s1, "idle");
		await waitForSessionStatus(s2, "idle");
		try {
			await openApp(page);

			// Navigate to s1 first
			await navigateToHash(page, `#/session/${s1}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Now click s2 row in sidebar
			const s2Row = page.locator(`[data-session-id="${s2}"]`).first();
			await expect(s2Row).toBeVisible({ timeout: 20_000 });
			await s2Row.click();

			// Editor visible for s2
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// s2 row must now be highlighted; s1 row must not be
			await expect(
				page.locator(
					`[data-session-id="${s2}"][data-nav-active="true"], ` +
					`[data-session-id="${s2}"].sidebar-session-active`,
				).first(),
			).toBeVisible({ timeout: 15_000 });

			// URL reflects s2
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(s2);
		} finally {
			await deleteSession(s1);
			await deleteSession(s2);
		}
	});

	// ── SB-24: search filter narrows sessions by title (CT-03 contract) ──

	test("search filter narrows visible sessions by title, clears to show all", async ({ page }) => {
		const [sA, sB, sC] = await Promise.all([createSession(), createSession(), createSession()]);
		await Promise.all([
			waitForSessionStatus(sA, "idle"),
			waitForSessionStatus(sB, "idle"),
			waitForSessionStatus(sC, "idle"),
		]);

		const stamp = Date.now();
		const titleA = `AlphaSBNav${stamp}`;
		const titleB = `BravoSBNav${stamp}`;
		const titleC = `CharlieSBNav${stamp}`;

		await Promise.all([
			apiFetch(`/api/sessions/${sA}`, { method: "PATCH", body: JSON.stringify({ title: titleA }) }),
			apiFetch(`/api/sessions/${sB}`, { method: "PATCH", body: JSON.stringify({ title: titleB }) }),
			apiFetch(`/api/sessions/${sC}`, { method: "PATCH", body: JSON.stringify({ title: titleC }) }),
		]);

		try {
			await openApp(page);

			// All three sessions must be visible before filtering
			await expect(page.getByText(titleA).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(titleB).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(titleC).first()).toBeVisible({ timeout: 15_000 });

			// Wait for shortcuts listener to attach, then use Ctrl+K to open search
			await expect.poll(
				() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
				{ timeout: 15_000 },
			).toBe(true);
			await page.keyboard.press("Control+k");
			const searchInput = page.locator("input[data-search]");
			await expect(searchInput).toBeFocused({ timeout: 15_000 });

			// Search for AlphaSBNav — only that session should be visible
			await searchInput.fill(titleA);
			await expect(page.getByText(titleA).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(titleB)).not.toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(titleC)).not.toBeVisible({ timeout: 15_000 });

			// Clear search — all three visible again
			await searchInput.fill("");
			await expect(page.getByText(titleA).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(titleB).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(titleC).first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await Promise.all([
				deleteSession(sA).catch(() => {}),
				deleteSession(sB).catch(() => {}),
				deleteSession(sC).catch(() => {}),
			]);
		}
	});

	// Ported from search-e2e.spec.ts SR-01 (audit: sidebar-nav PARTIAL): sidebar
	// search must match GOAL titles too — a non-matching query hides the goal.
	test("sidebar search hides a non-matching goal by title", async ({ page }) => {
		const stamp = Date.now();
		const goalTitle = `SidebarGoalSearch${stamp}`;
		const goal = await createGoal({ title: goalTitle });
		try {
			await openApp(page);
			// Goal is visible before filtering.
			await expect(page.getByText(goalTitle).first()).toBeVisible({ timeout: 20_000 });

			// Focus the sidebar search and enter a query that matches NOTHING.
			await expect.poll(
				() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
				{ timeout: 15_000 },
			).toBe(true);
			await page.keyboard.press("Control+k");
			const searchInput = page.locator("input[data-search]");
			await expect(searchInput).toBeFocused({ timeout: 15_000 });
			await searchInput.fill(`zzz-no-match-${stamp}`);

			// The goal must be hidden (goal-title filtering).
			await expect(page.getByText(goalTitle)).not.toBeVisible({ timeout: 15_000 });

			// Searching the goal's own title brings it back.
			await searchInput.fill(goalTitle);
			await expect(page.getByText(goalTitle).first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true).catch(() => {});
		}
	});
	// Ported from sidebar-filters.spec.ts (audit: sidebar-nav GAP / BR58): the
	// Filters popover exposes a "Show Read" toggle row with its stable testid.
	test("Filters popover exposes the Show Read toggle", async ({ page }) => {
		await openApp(page);
		await expect(filtersButton(page)).toBeVisible({ timeout: 10_000 });
		await openFiltersPopover(page);
		const readToggle = page.locator("[data-testid='sidebar-filter-read']").first();
		await expect(readToggle).toBeVisible({ timeout: 10_000 });
		await expect(readToggle.locator("input[type='checkbox']")).toHaveCount(1);
	});

	// Ported from sidebar-archived-layout.spec.ts (audit: sidebar-nav GAP): an
	// archived session/goal renders under Show Archived with grayscale dimming.
	test("Show Archived reveals an archived item with grayscale dimming", async ({ page }) => {
		const goalTitle = `SidebarArchivedSmoke${Date.now()}`;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await deleteSession(sessionId);
		const goal = await createGoal({ title: goalTitle, worktree: false });
		try {
			await apiFetch(`/api/goals/${goal.id}?cascade=false`, { method: "DELETE" });
			await openApp(page);
			await expect(filtersButton(page)).toBeVisible({ timeout: 10_000 });
			await clickShowArchivedToggle(page);
			// Archived section label + the grayscale-dimmed archived row must render.
			await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator("[style*='grayscale(1)']").first()).toBeVisible({ timeout: 10_000 });
		} finally {
			await deleteGoal(goal.id, true).catch(() => {});
		}
	});

	// Ported from search-e2e.spec.ts SR-02 (audit: sidebar-nav PARTIAL / BR54):
	// typing a query then clicking "Full Search" must navigate to the #/search
	// route carrying the query.
	test("Full Search link navigates to the #/search route with the query", async ({ page }) => {
		await openApp(page);
		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 15_000 });
		await searchInput.fill("testquery");
		const fullSearchLink = page.getByText("Full Search");
		await expect(fullSearchLink).toBeVisible({ timeout: 5_000 });
		await fullSearchLink.click();
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain("#/search");
			expect(hash).toContain("testquery");
		}).toPass({ timeout: 5_000 });
	});
});
