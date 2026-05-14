/**
 * Plan-tab dedupe-on-shared-planId E2E.
 *
 * Bug: when two child goals share `spawnedFromPlanId` (the archive +
 * unarchive / re-spawn flow observed on goal `2663c7b1`), the living-plan
 * path in `buildPlanSteps` emitted TWO PlanSteps for the same planId and
 * the DAG drew two nodes.
 *
 * Fix: `buildPlanSteps` groups living-plan children by planId and picks a
 * single winner via `resolvePlanNodeChild`'s tier preference (live
 * in-progress > archived complete > live other > archived non-complete).
 *
 * Reproduction note: REST `POST /spawn-child` is idempotent on planId
 * (returns the existing match — archived or not), so two children with the
 * same planId cannot be created via public API. This test seeds them
 * directly via the in-process gateway's `goalStore.put()` — same pattern
 * used by `tests/e2e/transcript-api.spec.ts` and `sandbox-restore.spec.ts`.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Plan tab — dedupe by planId across archive+respawn", () => {
	let parentId = "";
	let liveChildId = "";
	let archivedChildId = "";

	test.beforeEach(async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Parent w/ duplicated planId", projectId, team: false });
		parentId = parent.id as string;

		// Resolve goalStore via the in-process sessionManager → projectContextManager.
		const sm = (gateway as any).sessionManager;
		const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
		const ctx = pcm.getContextForGoal(parentId) ?? pcm.getOrCreate(projectId);
		const goalStore = ctx.goalStore;

		// Seed an ARCHIVED child + a LIVE child sharing spawnedFromPlanId="p1".
		// Both must satisfy the descendants endpoint's discovery and the
		// goal-dashboard plan-tab synthesis pipeline.
		const now = Date.now();
		archivedChildId = `seed-archived-${now}`;
		liveChildId = `seed-live-${now}`;

		goalStore.put({
			id: archivedChildId,
			title: "Child v1 (archived)",
			cwd: parent.cwd as string,
			state: "complete",
			spec: "v1: archived child for plan-tab unarchive-dedupe UI test, padded to meet validator length.",
			createdAt: now - 1000,
			updatedAt: now - 1000,
			parentGoalId: parentId,
			spawnedFromPlanId: "p1",
			archived: true,
			archivedAt: now - 500,
			projectId,
		});
		goalStore.put({
			id: liveChildId,
			title: "Child v2 (live)",
			cwd: parent.cwd as string,
			state: "in-progress",
			spec: "v2: live child for plan-tab unarchive-dedupe UI test, padded to meet spec validator length.",
			createdAt: now,
			updatedAt: now,
			parentGoalId: parentId,
			spawnedFromPlanId: "p1",
			projectId,
		});
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	test("DAG renders exactly ONE node for shared planId='p1' (live in-progress wins)", async ({ page }) => {
		// Sanity: descendants endpoint reports BOTH seeded children.
		const descRes = await apiFetch(`/api/goals/${parentId}/descendants`);
		expect(descRes.status).toBe(200);
		const desc = await descRes.json() as { goals: Array<{ id: string; archived?: boolean; spawnedFromPlanId?: string }> };
		const p1Children = desc.goals.filter(g => g.spawnedFromPlanId === "p1");
		expect(p1Children.length).toBe(2);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);

		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();
		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 5_000 });

		// Exactly ONE plan-node for planId="p1" — the dedupe fix.
		const p1Nodes = page.locator('[data-testid="plan-node"][data-plan-id="p1"]');
		await expect(p1Nodes.first()).toBeVisible({ timeout: 10_000 });
		await expect(p1Nodes).toHaveCount(1);

		// The surviving node points at the live in-progress child (tier 1),
		// not the archived loser (tier 2).
		const surviving = p1Nodes.first();
		await expect(surviving).toHaveAttribute("data-child-goal-id", liveChildId);
		await expect(surviving).toHaveAttribute("data-archived", "false");
	});
});
