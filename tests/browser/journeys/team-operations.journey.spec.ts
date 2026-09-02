/**
 * Retained full-stack team/dashboard smokes.
 *
 * Delegation semantics, mutation cards, goal-status states, gate bypass, plan
 * nodes, and orchestration APIs are covered below the spawned-browser tier.
 * These scenarios keep the two UI/server joins not represented there.
 */
import {
	test,
	expect,
	openApp,
	navigateToHash,
	createGoal,
	deleteGoal,
	createSession,
	deleteSession,
	waitForSessionStatus,
	apiFetch,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import { nonGitCwd } from "../../support/harnesses/browser/e2e-setup.js";

test.describe("Journey: Team Operations — retained full-stack smokes", () => {
	test("terminate confirmation resolves and lists real delegate children", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 900 });
		const parentId = await createSession();
		await waitForSessionStatus(parentId, "idle");
		const childIds: string[] = [];
		try {
			for (const instructions of ["CascadeChildAlpha", "CascadeChildBeta"]) {
				const response = await apiFetch("/api/sessions", {
					method: "POST",
					body: JSON.stringify({ delegateOf: parentId, instructions, cwd: nonGitCwd() }),
				});
				expect(response.status).toBe(201);
				const childId = String((await response.json()).id);
				childIds.push(childId);
				await waitForSessionStatus(childId, "idle");
			}

			await openApp(page);
			await navigateToHash(page, `#/session/${parentId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const row = page.locator(`[data-session-id="${parentId}"]`).first();
			await row.hover();
			await row.getByTestId("sidebar-actions-trigger").click();
			await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="terminate"]').first().click();

			const body = page.locator("p.text-muted-foreground")
				.filter({ hasText: /Are you sure you want to terminate/ })
				.first();
			await expect(body).toContainText("This will also archive its 2 child agents");
			await expect(body).toContainText("CascadeChildAlpha");
			await expect(body).toContainText("CascadeChildBeta");
			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
		} finally {
			for (const childId of childIds) await deleteSession(childId).catch(() => {});
			await deleteSession(parentId).catch(() => {});
		}
	});

	test("persisted gate signal reloads as the exact dashboard badge", async ({ page }) => {
		test.setTimeout(90_000);
		const goal = await createGoal({ title: `v2-gate-signal-${Date.now()}`, workflowId: "test-fast" });
		const goalId = goal.id as string;
		try {
			const signalResponse = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nRetained gate signal persistence smoke." }),
			});
			expect(signalResponse.status).toBe(201);

			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(page.locator(".dashboard-container").first()).toBeVisible({ timeout: 20_000 });
			await page.reload();
			await navigateToHash(page, `#/goal/${goalId}`);
			const row = page.locator(".wf-checklist-item").filter({ hasText: "Design Doc" }).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row.locator(".gate-signal-badge")).toHaveText(/^1 signal$/, { timeout: 20_000 });
		} finally {
			await deleteGoal(goalId, true).catch(() => {});
		}
	});
});
