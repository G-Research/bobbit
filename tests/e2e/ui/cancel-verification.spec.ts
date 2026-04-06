/**
 * Cancel Verification UI E2E tests.
 *
 * Tests:
 * 1. Cancel button appears when a verification is in "running" state
 * 2. Clicking cancel resets the verification and the button disappears
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

const SLOW_WORKFLOW_ID = `test-cancel-ui-${Date.now()}`;

/** Create a workflow with a slow verification command. */
async function createSlowWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: SLOW_WORKFLOW_ID,
			name: "Test Cancel UI Verification",
			description: "Workflow with slow command for cancel-verification UI tests",
			gates: [
				{
					id: "slow-gate",
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{
							name: "Slow check",
							type: "command",
							// 30-second sleep — long enough to see the running state in the UI
							run: 'node -e "setTimeout(()=>{console.log(\'done\');process.exit(0)},30000)"',
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

async function deleteSlowWorkflow(): Promise<void> {
	await apiFetch(`/api/workflows/${SLOW_WORKFLOW_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Get active verifications for a goal. */
async function getActiveVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.verifications || [];
}

/** Poll until a condition is met. */
async function pollUntil<T>(
	fn: () => Promise<T>,
	pred: (val: T) => boolean,
	timeoutMs = 15000,
	intervalMs = 100,
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const val = await fn();
		if (pred(val)) return val;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const lastVal = await fn();
	if (pred(lastVal)) return lastVal;
	throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

test.describe("Cancel Verification UI", () => {
	test.setTimeout(90_000);

	test.beforeAll(async () => {
		await createSlowWorkflow();
	});

	test.afterAll(async () => {
		await deleteSlowWorkflow();
	});

	test("cancel button appears for running verification and clicking it resets the state", async ({ page }) => {
		const goal = await createGoal({
			title: `Cancel UI Test ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Signal the gate to start a slow verification
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Test signal for UI" }),
			});
			expect(signalRes.status).toBe(201);

			// Wait for verification to be running via API
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => v.length > 0 && v.some(a => a.overallStatus === "running"),
				15000,
			);

			// Open app and navigate to goal dashboard
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			// Wait for the cancel button to appear — it should be visible when verification is running
			const cancelBtn = page.locator(".cancel-verification-btn");
			await expect(cancelBtn.first()).toBeVisible({ timeout: 15_000 });

			// Click the cancel button
			await cancelBtn.first().click();

			// The cancel button should disappear after cancellation
			await expect(cancelBtn).not.toBeVisible({ timeout: 15_000 });

			// Verify via API that no running verification remains
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running"),
				10000,
			);
		} finally {
			// Clean up any remaining verification
			await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			}).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("cancel button is not visible when no verification is running", async ({ page }) => {
		const goal = await createGoal({
			title: `No Cancel Button ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			// Wait for dashboard to render
			await expect(page.locator(".tab").first()).toBeVisible({ timeout: 10_000 });

			// Give time for content to render fully
			await page.waitForTimeout(1000);

			// The cancel button should NOT be present since no verification is running
			const cancelBtn = page.locator(".cancel-verification-btn");
			await expect(cancelBtn).not.toBeVisible();
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});
});
