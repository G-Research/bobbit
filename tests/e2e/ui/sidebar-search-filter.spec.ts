/**
 * E2E tests for sidebar search and keyboard shortcuts.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { createSession, deleteSession, createGoal, deleteGoal, apiFetch, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function waitForShortcutsReady(page: Page): Promise<void> {
	await expect.poll(
		() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
		{ timeout: 15_000 },
	).toBe(true);
}

async function dispatchCtrlK(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent("keydown", {
			key: "k", code: "KeyK", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
		}));
	});
}

async function dispatchCtrlBracket(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent("keydown", {
			key: "[", code: "BracketLeft", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
		}));
	});
}

test.describe("Sidebar search & keyboard shortcuts", () => {
	let sessionAlpha: string;
	let sessionBravo: string;
	let goalCharlie: { id: string };

	test.beforeAll(async () => {
		await waitForHealth();

		sessionAlpha = await createSession({ cwd: nonGitCwd() });
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

	test("SB-24: filter, preserve query on navigation, Escape clears and blurs @smoke", async ({ page }) => {
		await openApp(page);

		const sidebar = page.locator(".sidebar-edge");
		const alphaRow = sidebar.getByText("AlphaUniqueSearch").first();
		const bravoRow = sidebar.getByText("BravoUniqueSearch").first();
		await expect(alphaRow).toBeVisible({ timeout: 10_000 });
		await expect(bravoRow).toBeVisible({ timeout: 5_000 });

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("AlphaUnique");
		await expect(searchInput).toHaveValue("AlphaUnique");
		await expect(alphaRow).toBeVisible({ timeout: 5_000 });
		await expect(bravoRow).not.toBeVisible({ timeout: 3_000 });

		await alphaRow.click();
		await expect(searchInput).toHaveValue("AlphaUnique", { timeout: 5_000 });

		await searchInput.click();
		await searchInput.press("Escape");
		await expect(searchInput).toHaveValue("");
		expect(await searchInput.evaluate((el) => document.activeElement === el)).toBe(false);
		await expect(alphaRow).toBeVisible({ timeout: 5_000 });
		await expect(bravoRow).toBeVisible({ timeout: 5_000 });
	});

	test("SB-24: goal visible when child session matches", async ({ page }) => {
		const goalSession = await createSession({ cwd: nonGitCwd(), goalId: goalCharlie.id });
		await apiFetch(`/api/sessions/${goalSession}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "DeltaGoalChild" }),
		});

		try {
			await openApp(page);
			await expect(page.getByText("CharlieUniqueGoal")).toBeVisible({ timeout: 10_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("DeltaGoalChild");
			await expect(page.getByText("CharlieUniqueGoal")).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText("AlphaUniqueSearch")).not.toBeVisible({ timeout: 3_000 });
		} finally {
			await deleteSession(goalSession).catch(() => {});
		}
	});

	test("SB-25: search auto-opens archived section", async ({ page }) => {
		const archivedId = await createSession({ cwd: nonGitCwd() });
		await apiFetch(`/api/sessions/${archivedId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "EchoArchived" }),
		});
		await deleteSession(archivedId);

		await openApp(page);
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("EchoArchived");

		await expect(page.getByText("Archived").first()).toBeVisible({ timeout: 8_000 });
		await searchInput.fill("");
		await expect(page.getByText("EchoArchived")).not.toBeVisible({ timeout: 5_000 });
	});

	test("SB-26: full search link navigates to search page", async ({ page }) => {
		await openApp(page);

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("TestQuery");

		const fullSearchLink = page.getByText("Full Search");
		await expect(fullSearchLink).toBeVisible({ timeout: 5_000 });
		await fullSearchLink.click();

		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain("#/search");
			expect(hash).toContain("TestQuery");
		}).toPass({ timeout: 5_000 });
	});

	test("SB-34: keyboard shortcuts focus search from app/textarea and toggle sidebar collapse", async ({ page }) => {
		const tempSession = await createSession({ cwd: nonGitCwd() });
		try {
			await openApp(page);
			const searchInput = page.locator("input[data-search]");
			expect(await searchInput.evaluate((el) => document.activeElement === el)).toBe(false);
			await waitForShortcutsReady(page);

			await dispatchCtrlK(page);
			await expect.poll(
				() => searchInput.evaluate((el) => document.activeElement === el),
				{ timeout: 5_000 },
			).toBe(true);

			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, tempSession);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
			await page.locator("textarea").first().click();
			expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("textarea");

			await dispatchCtrlK(page);
			await expect.poll(
				() => searchInput.evaluate((el) => document.activeElement === el),
				{ timeout: 5_000 },
			).toBe(true);

			await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 5_000 });
			await dispatchCtrlBracket(page);
			await expect.poll(
				() => page.evaluate(() => !!document.querySelector("[data-testid='sidebar-collapsed']")),
				{ timeout: 5_000 },
			).toBe(true);

			await dispatchCtrlBracket(page);
			await expect(searchInput).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(tempSession).catch(() => {});
		}
	});
});
