/** Full-stack smoke for the human bypass control in the goal status widget.
 * Endpoint validation, completion, reset, and badge matrices live in gateway/unit coverage. */
import { test, expect } from "../../e2e/gateway-harness.js";
import { createGoal, createSession, deleteGoal, deleteSession } from "../../e2e/e2e-setup.js";
import { openApp, navigateToHash } from "../../e2e/ui/ui-helpers.js";

const GATE_ID = "implementation";
const WHY = "Manually verified on staging.";
const WHO = "Jamie";

test.describe("gate bypass full-stack smoke", () => {
	test("submits the human audit fields and rehydrates the bypassed row", async ({ page }) => {
		const goal = await createGoal({ title: `Gate bypass ${Date.now()}`, workflowId: "test-fast", worktree: false, team: false });
		const sessionId = await createSession({ goalId: goal.id });
		let bypassed = false;
		const calls: Array<Record<string, unknown>> = [];
		try {
			await page.route(new RegExp(`/api/goals/${goal.id}/gates(?:\\?.*)?$`), async route => {
				if (route.request().method() !== "GET") return route.fallback();
				const gates = [
					{ gateId: "design-doc", name: "Design Doc", status: "passed", signals: [] },
					{
						gateId: GATE_ID,
						name: "Implementation",
						status: bypassed ? "bypassed" : "failed",
						signals: [],
						...(bypassed ? { whyBypassed: WHY, whoAmI: WHO, bypassedAt: String(Date.now()) } : {}),
					},
				];
				if (route.request().url().includes("view=summary")) {
					await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: {
						passed: 1,
						bypassed: bypassed ? 1 : 0,
						bypassedCount: bypassed ? 1 : 0,
						total: 2,
						verifying: false,
						verifyingCount: 0,
						awaitingSignoffCount: 0,
						awaitingHumanSignoff: false,
						runningGateIds: [],
						gates: gates.map(gate => ({ ...gate, effectiveStatus: gate.status === "bypassed" ? "passed" : gate.status, running: false, awaitingSignoffCount: 0, dependsOn: [], signalCount: 0 })),
					} }) });
				} else {
					await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gates }) });
				}
			});
			await page.route(new RegExp(`/api/goals/${goal.id}/verifications/active(?:\\?.*)?$`), route =>
				route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verifications: [] }) }));
			await page.route(new RegExp(`/api/goals/${goal.id}/gates/${GATE_ID}/bypass$`), async route => {
				calls.push(JSON.parse(route.request().postData() || "{}"));
				bypassed = true;
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, gateId: GATE_ID, status: "bypassed", whyBypassed: WHY, whoAmI: WHO }) });
			});

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			const pill = page.getByTestId("goal-status-widget-pill").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();
			const row = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${GATE_ID}"]`);
			await expect(row).toHaveAttribute("data-gate-status", "failed", { timeout: 10_000 });
			await row.getByTestId("goal-widget-gate-bypass").click();
			await page.getByTestId("goal-widget-bypass-why").fill(WHY);
			await page.getByTestId("goal-widget-bypass-who").fill(WHO);
			await page.getByTestId("goal-widget-bypass-confirm").click();

			await expect(row).toHaveAttribute("data-gate-status", "bypassed", { timeout: 10_000 });
			expect(calls).toEqual([{ whyBypassed: WHY, whoAmI: WHO, isInitiatedByHuman: true }]);

			await page.reload();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.getByTestId("goal-status-widget-pill").first().click();
			const rehydratedRow = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${GATE_ID}"]`);
			await expect(rehydratedRow).toHaveAttribute("data-gate-status", "bypassed", { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
