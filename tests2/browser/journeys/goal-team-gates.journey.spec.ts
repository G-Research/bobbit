/**
 * Journey: Goal → Team → Gates — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal, apiFetch, defaultProjectId } from "../_helpers/journey-fixture.js";
import { seedTeamLeadHeader } from "../e2e-setup.js";

test.describe("Journey: Goal → Team → Gates", () => {
	test("goal dashboard renders after navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-smoke-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			const dashboard = page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first();
			await expect(dashboard).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal title visible in dashboard", async ({ page }) => {
		const title = "v2-journey-title-visible";
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("sidebar shows sidebar-edge after goal navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-sidebar-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal API returns goal after creation", async ({ page }) => {
		const { apiFetch } = await import("../../../tests/e2e/e2e-setup.js");
		const goal = await createGoal({ title: "v2-journey-api-check" });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(data.id).toBe(goal.id);
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

// Behavioral assertions ported from plan-tab-gate-status.spec.ts
test.describe("Journey: Plan-Tab Gate-Status — behavioral assertions", () => {
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

	test("plan tab renders archived child with data-archived='true'", async ({ page, gateway }) => {
		const parent = await createGoal({ title: "v2-plan-archived-parent", team: false });
		const parentId = parent.id as string;
		try {
			const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
				method: "POST",
				headers: seedTeamLeadHeader(gateway, parentId),
				body: JSON.stringify({
					planId: "p1",
					title: "Child A",
					spec: "child a spec for plan-tab gate-status journey test, padded to satisfy spec validator minimum length requirement.",
				}),
			});
			expect(r1.status).toBe(201);
			const childId = (await r1.json()).id as string;
			// Archive the child so it is sourced from /descendants
			const arch = await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });
			expect([200, 204]).toContain(arch.status);

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			const planTab = page.locator('[data-testid="tab-plan"]').first();
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 15_000 });
			// Archived node must render with data-archived="true"
			await expect(page.locator('[data-testid="plan-node"][data-archived="true"]').first()).toBeVisible({ timeout: 20_000 });
			// Archived pill renders inside the node
			await expect(page.locator('[data-testid="plan-node-archived-pill"]').first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(parentId, true);
		}
	});

	test("route-injected gateStatus:failed renders as data-plan-gate-status on plan node", async ({ page, gateway }) => {
		test.setTimeout(90_000); // plan-tab with real goal hierarchy: parent+child create, archive, route inject
		const parent = await createGoal({ title: "v2-plan-gate-status-inject", team: false });
		const parentId = parent.id as string;
		let childId = "";
		try {
			const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
				method: "POST",
				headers: seedTeamLeadHeader(gateway, parentId),
				body: JSON.stringify({
					planId: "p2",
					title: "Child B",
					spec: "child b spec for plan-tab gate-status injection journey test, padded to satisfy minimum length requirement here.",
				}),
			});
			expect(r1.status).toBe(201);
			childId = (await r1.json()).id as string;
			// Archive child so it's served from /descendants
			await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });

			// Inject gateStatus via route mock before navigation
			await page.route(/\/api\/goals\/[^/]+\/descendants(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				const resp = await route.fetch();
				const body = await resp.json() as { goals?: Array<{ id: string; [k: string]: unknown }> };
				for (const g of body.goals ?? []) {
					if (g.id === childId) Object.assign(g, { gateStatus: "failed", mergeConflict: false });
				}
				await route.fulfill({ response: resp, json: body });
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			const planTab = page.locator('[data-testid="tab-plan"]').first();
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 15_000 });

			const node = page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"]`).first();
			await expect(node).toBeVisible({ timeout: 20_000 });
			await expect(node).toHaveAttribute("data-plan-gate-status", "failed");
			await expect(
				page.locator('[data-testid="plan-node-gate-dot"][data-gate-status="failed"]').first(),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(parentId, true);
		}
	});
});
