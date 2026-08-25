/**
 * Journey: Goal plan-tab gate states — v2 browser smoke
 */
import {
  test,
  expect,
  openApp,
  navigateToHash,
  createGoal,
  deleteGoal,
  apiFetch,
} from "../../../tests2/browser/_helpers/journey-fixture.js";
import { seedTeamLeadHeader } from "../../e2e/e2e-setup.js";

// Behavioral assertions ported from plan-tab-gate-status.spec.ts
test.describe("Journey: Plan-Tab Gate-Status — behavioral assertions", () => {
	async function enableSubgoalsForFixture(): Promise<void> {
		const prefs = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		expect(prefs.status, `enable subgoals for plan-tab fixture: ${await prefs.clone().text()}`).toBe(200);
	}

	test("gate list API returns gates for a workflow-linked goal", async () => {
		const goal = await createGoal({ title: "v2-plan-gates-api-check", workflowId: "test-fast" });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}/gates`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(Array.isArray(data.gates)).toBe(true);
			expect(data.gates.length).toBeGreaterThan(0);
			const gateIds = (data.gates as Array<{ gateId: string }>).map((g) => g.gateId);
			expect(gateIds).toContain("design-doc");
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal dashboard shows workflow checklist for a workflow-linked goal", async ({ page }) => {
		const goal = await createGoal({ title: "v2-plan-checklist-smoke", workflowId: "test-fast" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			// Workflow checklist items should render for a workflow-linked goal
			await expect(page.locator(".wf-checklist-item").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("plan tab renders archived children and route-injected failed gate status", async ({ page, gateway }) => {
		test.setTimeout(90_000); // real hierarchy: parent + two archived children + route injection
		await enableSubgoalsForFixture();
		const parent = await createGoal({ title: "v2-plan-gate-status", team: false, subgoalsAllowed: true });
		const parentId = parent.id as string;
		let archivedChildId = "";
		let failedChildId = "";
		try {
			const spawnChild = async (planId: string, title: string, spec: string): Promise<string> => {
				const response = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
					method: "POST",
					headers: seedTeamLeadHeader(gateway, parentId),
					body: JSON.stringify({ planId, title, spec }),
				});
				expect(response.status).toBe(201);
				return (await response.json()).id as string;
			};
			archivedChildId = await spawnChild(
				"p1",
				"Child A",
				"child a spec for plan-tab gate-status journey test, padded to satisfy spec validator minimum length requirement.",
			);
			failedChildId = await spawnChild(
				"p2",
				"Child B",
				"child b spec for plan-tab gate-status injection journey test, padded to satisfy minimum length requirement here.",
			);
			// Archive both children so the plan is sourced from /descendants. Keep
			// hierarchy mutations serialized: each archive updates the same parent.
			for (const childId of [archivedChildId, failedChildId]) {
				const archive = await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });
				expect([200, 204]).toContain(archive.status);
			}

			// Inject one archived child's failed status before navigation.
			await page.route(/\/api\/goals\/[^/]+\/descendants(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				const resp = await route.fetch();
				const body = await resp.json() as { goals?: Array<{ id: string; [k: string]: unknown }> };
				for (const goal of body.goals ?? []) {
					if (goal.id === failedChildId) Object.assign(goal, { gateStatus: "failed", mergeConflict: false });
				}
				await route.fulfill({ response: resp, json: body });
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			const planTab = page.locator('[data-testid="tab-plan"]').first();
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 15_000 });

			const archivedNode = page.locator(`[data-testid="plan-node"][data-child-goal-id="${archivedChildId}"]`).first();
			await expect(archivedNode).toBeVisible({ timeout: 20_000 });
			await expect(archivedNode).toHaveAttribute("data-archived", "true");
			await expect(archivedNode.locator('[data-testid="plan-node-archived-pill"]')).toBeVisible({ timeout: 15_000 });

			const failedNode = page.locator(`[data-testid="plan-node"][data-child-goal-id="${failedChildId}"]`).first();
			await expect(failedNode).toBeVisible({ timeout: 20_000 });
			await expect(failedNode).toHaveAttribute("data-plan-gate-status", "failed");
			await expect(
				failedNode.locator('[data-testid="plan-node-gate-dot"][data-gate-status="failed"]'),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(parentId, true);
		}
	});
});
