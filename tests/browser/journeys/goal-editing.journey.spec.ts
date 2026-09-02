/**
 * Retained full-stack goal CRUD smokes.
 *
 * Field validation, proposal shaping, subgoal eligibility, preference controls,
 * and static dashboard states live in unit, DOM, fixture, and gateway tests.
 * Keep only browser/server boundaries that require the real app, operator auth,
 * or a durable reload.
 */
import {
	test,
	expect,
	openApp,
	navigateToHash,
	createGoal,
	deleteGoal,
	apiFetch,
	sendMessage,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createGoalAssistantViaUI } from "../../support/helpers/browser/fixtures/ui-helpers.js";

const dashboard = (page: import("@playwright/test").Page) =>
	page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first();

test.describe("Journey: Goal Editing — retained full-stack smokes", () => {
	test("archive action persists and reloads the dashboard read-only state", async ({ page }) => {
		const title = `v2-goal-archive-${Date.now()}`;
		const goal = await createGoal({ title, team: false });
		const goalId = goal.id as string;
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(dashboard(page)).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });

			await page.reload();
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(dashboard(page)).toBeVisible({ timeout: 20_000 });

			await dashboard(page).getByRole("button", { name: "Archive", exact: true }).first().click();
			const archiveHeading = page.getByRole("heading", { name: "Archive Goal", exact: true });
			await expect(archiveHeading).toBeVisible({ timeout: 15_000 });
			await page.getByRole("button", { name: "Archive", exact: true }).last().click();
			await expect(archiveHeading).toBeHidden({ timeout: 15_000 });

			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goalId}`);
				return response.ok && (await response.json()).archived === true;
			}, { timeout: 20_000 }).toBe(true);
			await expect(page.getByText(/This goal was archived .*Dashboard is read-only\./)).toBeVisible({ timeout: 15_000 });
			await expect(dashboard(page).getByRole("button", { name: "Archived", exact: true }).first()).toBeDisabled();

			await page.reload();
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(page.getByText(/This goal was archived .*Dashboard is read-only\./)).toBeVisible({ timeout: 20_000 });
			await expect(dashboard(page).getByRole("button", { name: "Archived", exact: true }).first()).toBeDisabled();
		} finally {
			await deleteGoal(goalId, true).catch(() => {});
		}
	});

	test("empty workflow response disables goal creation in the real proposal flow", async ({ page }) => {
		test.setTimeout(90_000);
		await page.route(/\/api\/workflows(?:\?.*)?$/, async (route, request) => {
			if (request.method() !== "GET") return route.continue();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
		});

		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
		await expect(page.locator("input[placeholder='Goal title']").first()).toHaveValue("E2E Test Goal", { timeout: 20_000 });
		await expect(page.getByTestId("goal-form-no-workflows-banner").first()).toContainText("no workflows yet");
		await expect(page.getByRole("button", { name: "Create Goal", exact: true }).first()).toBeDisabled();
	});

	test("Children-tab policy toggle uses browser authority and persists", async ({ page }) => {
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		const parent = await createGoal({
			title: `v2-existing-subgoal-${Date.now()}`,
			spec: "Parent goal for the retained browser-authorized policy update smoke.",
			team: false,
			subgoalsAllowed: false,
		});
		const parentId = parent.id as string;
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			await expect(dashboard(page)).toBeVisible({ timeout: 20_000 });
			await page.getByTestId("tab-children").first().click();
			const toggle = page.getByTestId("goal-subgoal-settings-allow-toggle").first();
			await expect(toggle).not.toBeChecked();
			await toggle.check();
			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${parentId}`);
				return (await response.json()).subgoalsAllowed;
			}, { timeout: 15_000 }).toBe(true);
			await expect(toggle).toBeChecked();
		} finally {
			await deleteGoal(parentId, true).catch(() => {});
		}
	});
});
