/**
 * Journey: Scheduler recovery controls
 *
 * A bounded scheduler stop must remain visible and recoverable from both the
 * root dashboard and its Plan child node. This drives the real authorized
 * browser POST, then verifies the endpoint's persisted consume boundary is
 * reflected without a reload and remains clear after a reload.
 */
import {
	test,
	expect,
	openApp,
	navigateToHash,
	createGoal,
	deleteGoal,
	apiFetch,
} from "../_helpers/journey-fixture.js";
import { seedTeamLeadHeader } from "../../e2e/_helpers/e2e-setup.js";

type SchedulerRecovery = {
	kind: "child" | "root";
	code: string;
	reason: string;
	retryable: boolean;
	updatedAt: number;
	affectedChildGoalIds?: string[];
};

function goalStoreFor(gateway: any, goalId: string): any {
	const contexts = gateway.sessionManager?.getProjectContextManager?.();
	const context = contexts?.getContextForGoal?.(goalId);
	if (!context?.goalStore) throw new Error(`scheduler recovery fixture has no goal store for ${goalId}`);
	return context.goalStore;
}

function stampRecovery(gateway: any, goalId: string, recovery: SchedulerRecovery): void {
	const updated = goalStoreFor(gateway, goalId).update(goalId, { schedulerRecovery: recovery });
	expect(updated, `stamp scheduler recovery for ${goalId}`).toBe(true);
}

function persistedRecovery(gateway: any, goalId: string): SchedulerRecovery | undefined {
	return goalStoreFor(gateway, goalId).get(goalId)?.schedulerRecovery;
}

async function enableSubgoals(): Promise<void> {
	const response = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: true }),
	});
	expect(response.status, `enable subgoals: ${await response.clone().text()}`).toBe(200);
}

test.describe("Journey: Scheduler recovery controls", () => {
	test("root badge and Plan child retry consume persisted recovery and survive reload", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await enableSubgoals();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = await createGoal({
			title: `Scheduler recovery root ${stamp}`,
			team: false,
			subgoalsAllowed: true,
		});
		const rootId = root.id as string;
		let childId = "";

		try {
			const childResponse = await apiFetch(`/api/goals/${rootId}/spawn-child`, {
				method: "POST",
				headers: seedTeamLeadHeader(gateway, rootId),
				body: JSON.stringify({
					planId: `scheduler-recovery-${stamp}`,
					title: "Recoverable child",
					spec: "Child fixture for the scheduler recovery browser journey, padded to satisfy the minimum goal specification length.",
				}),
			});
			expect(childResponse.status, `spawn scheduler recovery child: ${await childResponse.clone().text()}`).toBe(201);
			childId = (await childResponse.json()).id as string;

			// spawn-child returns while its scheduler-owned auto-start is still
			// finishing. Wait for TeamManager.startTeam's durable transition before
			// injecting recovery that the scheduler success continuation may clear.
			await expect.poll(
				() => goalStoreFor(gateway, childId).get(childId)?.state,
				{
					message: "child auto-start reaches its durable in-progress state",
					timeout: 20_000,
				},
			).toBe("in-progress");

			const rootRecovery: SchedulerRecovery = {
				kind: "root",
				code: "SCHEDULER_CIRCUIT_OPEN",
				reason: "fixture root scheduler circuit is open",
				retryable: true,
				updatedAt: Date.now(),
				affectedChildGoalIds: [childId],
			};
			const childRecovery: SchedulerRecovery = {
				kind: "child",
				code: "RETRY_EXHAUSTED",
				reason: "fixture child worktree remains busy",
				retryable: true,
				updatedAt: Date.now(),
			};
			stampRecovery(gateway, rootId, rootRecovery);
			stampRecovery(gateway, childId, childRecovery);

			await openApp(page);
			await navigateToHash(page, `#/goal/${rootId}`);
			const rootRetry = page.locator('[data-testid="goal-scheduler-recovery-retry"]');
			await expect(rootRetry).toBeVisible({ timeout: 20_000 });
			await expect(rootRetry).toHaveAttribute("title", rootRecovery.reason);

			const planTab = page.locator('[data-testid="tab-plan"]');
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			const childNode = page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"]`);
			await expect(childNode).toBeVisible({ timeout: 20_000 });
			const childRetry = childNode.locator('[data-testid="plan-node-scheduler-retry"]');
			await expect(childRetry).toBeVisible();
			await expect(childRetry).toHaveAttribute("title", childRecovery.reason);

			const rootPost = page.waitForResponse((response) =>
				response.request().method() === "POST"
				&& new URL(response.url()).pathname === `/api/goals/${rootId}/retry-scheduled-start`,
			);
			await rootRetry.click();
			const rootResponse = await rootPost;
			expect(rootResponse.status(), "dashboard retry is authorized and reaches the scheduler recovery endpoint").toBe(200);
			await expect.poll(() => persistedRecovery(gateway, rootId), { timeout: 10_000 }).toBeUndefined();
			await expect(rootRetry, "root recovery badge clears in the live dashboard after its POST").toHaveCount(0, { timeout: 20_000 });

			await page.reload();
			await navigateToHash(page, `#/goal/${rootId}`);
			await expect(rootRetry, "root cleanup persists after a full reload").toHaveCount(0, { timeout: 20_000 });
			await page.locator('[data-testid="tab-plan"]').click();
			const childRetryAfterReload = page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"] [data-testid="plan-node-scheduler-retry"]`);
			await expect(childRetryAfterReload, "unconsumed child recovery remains visible after reload").toBeVisible({ timeout: 20_000 });

			const childPost = page.waitForResponse((response) =>
				response.request().method() === "POST"
				&& new URL(response.url()).pathname === `/api/goals/${childId}/retry-scheduled-start`,
			);
			await childRetryAfterReload.click();
			const childResponseAfterRetry = await childPost;
			expect(childResponseAfterRetry.status(), "Plan retry is authorized and reaches the child recovery endpoint").toBe(200);
			await expect.poll(() => persistedRecovery(gateway, childId), { timeout: 10_000 }).toBeUndefined();
			await expect(childRetryAfterReload, "Plan retry control clears without a reload").toHaveCount(0, { timeout: 20_000 });

			await page.reload();
			await navigateToHash(page, `#/goal/${rootId}`);
			await page.locator('[data-testid="tab-plan"]').click();
			await expect(
				page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"] [data-testid="plan-node-scheduler-retry"]`),
				"child recovery cleanup persists after a full reload",
			).toHaveCount(0, { timeout: 20_000 });
		} finally {
			await deleteGoal(rootId, true);
		}
	});
});
