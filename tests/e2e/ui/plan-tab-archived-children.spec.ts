/**
 * Plan-tab archived-children E2E.
 *
 * Bug: the Plan-tab DAG sourced children from `state.goals`, which excludes
 * archived goals when the sidebar's "See Archived" toggle is off. Children
 * archived after `goal_merge_child` (or any other archive flow) silently
 * vanished from the DAG even though they're part of the goal's history.
 *
 * Fix: dashboard fetches `GET /api/goals/:id/descendants` (live + archived)
 * and merges into the Plan-tab compute pool. Archived nodes are marked
 * `data-archived="true"` and rendered faded with an "archived" pill.
 *
 * This test:
 *   1. Creates a parent goal (team:false, no autonomy).
 *   2. Spawns one child via REST.
 *   3. Archives the child via DELETE ?cascade=true.
 *   4. Loads the parent dashboard, opens the Plan tab.
 *   5. Asserts the plan-node renders with `data-archived="true"`.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, seedTeamLeadHeader } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Plan tab — archived children", () => {
	let parentId = "";
	let childId = "";

	test.beforeEach(async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Parent w/ archived child", projectId, team: false });
		parentId = parent.id as string;
		// spawn-child is ORCHESTRATION (cookie does NOT bypass) — authorize as
		// the parent's team-lead via a seeded matching header.
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			headers: seedTeamLeadHeader(gateway.teamManager, parentId),
			body: JSON.stringify({ planId: "p1", title: "Child A", spec: "child a spec: plan-tab archived-children UI test, padded to meet spec validator minimum length." }),
		});
		expect(r1.status).toBe(201);
		childId = (await r1.json()).id as string;

		// Archive the child via DELETE ?cascade=true. The child has no
		// descendants of its own, so cascade is technically unneeded but
		// matches the cascade-required REST contract.
		const arch = await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });
		expect([200, 204]).toContain(arch.status);
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	test("DAG renders archived child with data-archived='true'", async ({ page }) => {
		// Sanity: REST endpoint reports the archived child as a descendant.
		const descRes = await apiFetch(`/api/goals/${parentId}/descendants`);
		expect(descRes.status).toBe(200);
		const desc = await descRes.json() as { goals: Array<{ id: string; archived?: boolean }> };
		expect(Array.isArray(desc.goals)).toBe(true);
		const archivedChild = desc.goals.find(g => g.id === childId);
		expect(archivedChild).toBeTruthy();
		expect(archivedChild!.archived).toBe(true);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);

		// Plan tab should be visible (parent has at least one child — archived
		// or live both qualify under the merged-pool fix).
		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();

		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 5_000 });

		// At least one plan-node, AND it must be the archived one.
		const archivedNodes = page.locator('[data-testid="plan-node"][data-archived="true"]');
		await expect(archivedNodes.first()).toBeVisible({ timeout: 10_000 });
		const count = await archivedNodes.count();
		expect(count).toBeGreaterThanOrEqual(1);

		// Visual distinction: archived pill is rendered inside the node.
		await expect(
			page.locator('[data-testid="plan-node-archived-pill"]').first(),
		).toBeVisible({ timeout: 5_000 });
	});
});
