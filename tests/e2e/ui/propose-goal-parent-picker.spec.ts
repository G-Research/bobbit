/**
 * Browser E2E coverage for the `propose_goal` parent picker, breadcrumb,
 * depth indicator, and subgoal/top-level badges in the goal proposal panel.
 *
 * Three scenarios:
 *   1. Parent picker visible and pre-filled when subgoals are enabled and
 *      the seeded proposal carries `parentGoalId`. Asserts the parent
 *      picker, breadcrumb, depth indicator, and "Subgoal of X" badge.
 *   2. No parent in the seeded proposal → "Top-level goal" badge appears
 *      and the subgoal badge does NOT.
 *   3. Subgoals disabled → parent picker row is hidden even if a draft
 *      exists.
 *
 * The proposal panel is driven by API-seeding the goal proposal (via the
 * same endpoint `propose_goal` calls). The server then broadcasts a
 * `proposal_update` WS event which populates `state.activeProposals.goal`
 * and the preview panel auto-switches to the "goal" tab.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, createSession, createGoal, deleteGoal, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function setPref(key: string, value: unknown): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: value }),
	});
	expect(resp.status).toBe(200);
}

async function seedGoalProposal(
	sessionId: string,
	args: Record<string, unknown>,
): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
	expect(resp.status, `seed proposal must succeed`).toBe(200);
	const body = await resp.json();
	expect(body.ok).toBe(true);
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("propose_goal modal parent picker + depth indicator", () => {
	test("parent picker visible and pre-filled when subgoals enabled + parentGoalId seeded", async ({ page }) => {
		test.setTimeout(60_000);
		await setPref("subgoalsEnabled", true);
		await setPref("maxNestingDepth", 3);

		const parent = await createGoal({ title: `Parent goal ${Date.now()}` });
		const sessionId = await createSession();

		try {
			await seedGoalProposal(sessionId, {
				title: "Child goal under parent",
				spec: "Test spec for the child goal — should render parent picker.",
				parentGoalId: parent.id,
			});

			await openSession(page, sessionId);

			// The proposal panel renders inside the preview pane; the WS
			// proposal_update event populates state.activeProposals.goal and
			// the active tab flips to "goal".
			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(titleInput).toHaveValue("Child goal under parent", { timeout: 10_000 });

			// Parent picker row + dropdown.
			const parentRow = page.locator("[data-testid='goal-form-parent-row']").first();
			await expect(parentRow).toBeVisible({ timeout: 10_000 });
			const parentPicker = page.locator("[data-testid='goal-form-parent-picker']").first();
			await expect(parentPicker).toBeVisible();
			await expect(parentPicker).toHaveValue(parent.id);

			// "Subgoal of <parent title>" badge.
			const subgoalBadge = page.locator("[data-testid='goal-form-subgoal-badge']").first();
			await expect(subgoalBadge).toBeVisible();
			await expect(subgoalBadge).toContainText("Subgoal of");
			await expect(subgoalBadge).toContainText(parent.title as string);

			// Breadcrumb references parent title.
			const breadcrumb = page.locator("[data-testid='goal-form-breadcrumb']").first();
			await expect(breadcrumb).toBeVisible();
			await expect(breadcrumb).toContainText(parent.title as string);

			// Depth indicator: parent is depth 1 (root), child is depth 2.
			const depth = page.locator("[data-testid='goal-form-depth-indicator']").first();
			await expect(depth).toBeVisible();
			await expect(depth).toContainText("depth 2");
			await expect(depth).toContainText("of 3");

			// Top-level badge must NOT be shown when a parent is selected.
			await expect(page.locator("[data-testid='goal-form-toplevel-badge']")).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
			await deleteGoal(parent.id);
		}
	});

	test("no parent selected shows top-level badge", async ({ page }) => {
		test.setTimeout(60_000);
		await setPref("subgoalsEnabled", true);
		await setPref("maxNestingDepth", 3);

		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, {
				title: "Top-level goal proposal",
				spec: "A goal proposal without any parentGoalId — should show top-level badge.",
			});

			await openSession(page, sessionId);

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(titleInput).toHaveValue("Top-level goal proposal", { timeout: 10_000 });

			// Parent picker is visible (subgoals enabled) but unselected.
			const parentRow = page.locator("[data-testid='goal-form-parent-row']").first();
			await expect(parentRow).toBeVisible({ timeout: 10_000 });
			const parentPicker = page.locator("[data-testid='goal-form-parent-picker']").first();
			await expect(parentPicker).toHaveValue("");

			// "Top-level goal" badge present.
			const toplevelBadge = page.locator("[data-testid='goal-form-toplevel-badge']").first();
			await expect(toplevelBadge).toBeVisible();
			await expect(toplevelBadge).toContainText(/top-level goal/i);

			// Subgoal badge, breadcrumb, and depth indicator are absent.
			await expect(page.locator("[data-testid='goal-form-subgoal-badge']")).toHaveCount(0);
			await expect(page.locator("[data-testid='goal-form-breadcrumb']")).toHaveCount(0);
			await expect(page.locator("[data-testid='goal-form-depth-indicator']")).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("parent picker not shown when subgoals disabled", async ({ page }) => {
		test.setTimeout(60_000);
		await setPref("subgoalsEnabled", false);

		const sessionId = await createSession();
		try {
			await seedGoalProposal(sessionId, {
				title: "Goal without parent picker",
				spec: "Subgoals are disabled — parent picker row must not be rendered.",
			});

			await openSession(page, sessionId);

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(titleInput).toHaveValue("Goal without parent picker", { timeout: 10_000 });

			// Parent row hidden when subgoals are disabled.
			await expect(page.locator("[data-testid='goal-form-parent-row']")).toHaveCount(0);
			await expect(page.locator("[data-testid='goal-form-toplevel-badge']")).toHaveCount(0);
			await expect(page.locator("[data-testid='goal-form-subgoal-badge']")).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
			// Restore default for subsequent tests in the same worker.
			await setPref("subgoalsEnabled", true);
		}
	});
});
