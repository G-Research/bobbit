/**
 * Phase 5b — cascade pause E2E.
 *
 * Verifies pause-with-descendants:
 *  - Pause parent with descendants → modal asks about cascade.
 *  - Cascade=true → all paused.
 *  - Cascade=false → only parent paused; children still active.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

interface GoalSnapshot { id: string; paused?: boolean }

async function readGoal(id: string): Promise<GoalSnapshot> {
	const res = await apiFetch(`/api/goals/${id}`);
	return await res.json() as GoalSnapshot;
}

test.describe("Phase 5b — cascade pause", () => {
	let parentId = "";
	let child1Id = "";
	let child2Id = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Pause parent", projectId, team: false });
		parentId = parent.id as string;
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Child 1", spec: "cascade-pause UI test: first child goal padded to meet spec validator minimum length." }),
		});
		child1Id = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p2", title: "Child 2", spec: "cascade-pause UI test: second child goal padded to meet spec validator minimum length." }),
		});
		child2Id = (await r2.json()).id as string;
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	test("cascade=true pauses parent + all descendants", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		const pauseBtn = page.locator('[data-testid="goal-pause-btn"]').first();
		await expect(pauseBtn).toBeVisible({ timeout: 10_000 });
		await pauseBtn.click();

		// Cascade dialog with default-on checkbox.
		const summary = page.locator('[data-testid="cascade-pause-summary"]').first();
		await expect(summary).toBeVisible({ timeout: 5_000 });
		await expect(summary).toContainText("2 descendant goals");
		const checkbox = page.locator('[data-testid="cascade-pause-checkbox"]').first();
		await expect(checkbox).toBeChecked();

		const action = page.locator('[data-testid="cascade-pause-confirm"] button').first();
		// Listen for the pause REST response, then click — guarantees we
		// observe the server side-effect before assertions read it back.
		const pauseResp = page.waitForResponse(
			r => r.url().includes(`/api/goals/${parentId}/pause`) && r.request().method() === "POST" && r.ok(),
			{ timeout: 10_000 },
		);
		await action.click();
		await pauseResp;
		// All three goals should be paused.
		await expect.poll(async () => (await readGoal(parentId)).paused === true, { timeout: 5_000 }).toBe(true);
		await expect.poll(async () => (await readGoal(child1Id)).paused === true, { timeout: 5_000 }).toBe(true);
		await expect.poll(async () => (await readGoal(child2Id)).paused === true, { timeout: 5_000 }).toBe(true);
	});

	test("cascade=false pauses only the parent", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		const pauseBtn = page.locator('[data-testid="goal-pause-btn"]').first();
		await expect(pauseBtn).toBeVisible({ timeout: 10_000 });
		await pauseBtn.click();

		const checkbox = page.locator('[data-testid="cascade-pause-checkbox"]').first();
		await expect(checkbox).toBeVisible({ timeout: 5_000 });
		// Toggle OFF.
		await checkbox.uncheck();
		// Action label updates to plain "Pause goal".
		const action = page.locator('[data-testid="cascade-pause-confirm"] button').first();
		const pauseResp = page.waitForResponse(
			r => r.url().includes(`/api/goals/${parentId}/pause`) && r.request().method() === "POST" && r.ok(),
			{ timeout: 10_000 },
		);
		await action.click();
		await pauseResp;
		await expect.poll(async () => (await readGoal(parentId)).paused === true, { timeout: 5_000 }).toBe(true);
		// Children remain unpaused.
		expect((await readGoal(child1Id)).paused ?? false).toBe(false);
		expect((await readGoal(child2Id)).paused ?? false).toBe(false);
	});
});
