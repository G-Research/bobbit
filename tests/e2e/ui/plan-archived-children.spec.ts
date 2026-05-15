/**
 * Plan tab + tree-cost — archived & completed children E2E.
 *
 * Verifies the user-facing contract for the archived-children fix:
 *
 *   1. Plan tab default view shows ALL direct children — live
 *      in-progress AND completed AND archived.
 *   2. Reload mid-test → archived child still appears (catches the
 *      cb75426e/4581f8a5 client-side-dedupe regression class).
 *   3. Toggling `data-testid="plan-live-only-toggle"` hides archived
 *      children; the live child remains.
 *   4. Tree-cost breakdown attributes spend to all descendants — the
 *      archived child appears in the rollup with its stamped cost.
 *
 * Seeds children directly via the in-process gateway's `goalStore.put()`
 * — same pattern as `plan-tab-unarchive-dedupe.spec.ts` and friends —
 * because REST `POST /spawn-child` does not let us create a "complete"
 * or "archived" child in one step.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Plan tab + tree-cost — archived/completed children", () => {
	let parentId = "";
	let liveChildId = "";
	let completeChildId = "";
	let archivedChildId = "";

	test.beforeEach(async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({
			title: "Parent w/ live+complete+archived children",
			projectId,
			team: false,
		});
		parentId = parent.id as string;

		// Resolve goalStore + costTracker via the in-process sessionManager.
		const sm = (gateway as any).sessionManager;
		const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
		const ctx = pcm.getContextForGoal(parentId) ?? pcm.getOrCreate(projectId);
		const goalStore = ctx.goalStore;
		const costTracker = ctx.costTracker ?? (gateway as any).costTracker;

		const now = Date.now();
		liveChildId     = `seed-live-${now}`;
		completeChildId = `seed-complete-${now}`;
		archivedChildId = `seed-archived-${now}`;

		goalStore.put({
			id: liveChildId,
			title: "Live in-progress child",
			cwd: parent.cwd as string,
			state: "in-progress",
			spec: "live in-progress child for plan-archived-children E2E, padded to meet spec validator minimum length.",
			createdAt: now - 3000,
			updatedAt: now - 3000,
			parentGoalId: parentId,
			rootGoalId: parentId,
			spawnedFromPlanId: "p-live",
			projectId,
		});
		goalStore.put({
			id: completeChildId,
			title: "Completed (not archived) child",
			cwd: parent.cwd as string,
			state: "complete",
			spec: "completed child for plan-archived-children E2E, padded to meet spec validator minimum length.",
			createdAt: now - 2000,
			updatedAt: now - 2000,
			parentGoalId: parentId,
			rootGoalId: parentId,
			spawnedFromPlanId: "p-complete",
			projectId,
		});
		goalStore.put({
			id: archivedChildId,
			title: "Archived child",
			cwd: parent.cwd as string,
			state: "complete",
			spec: "archived child for plan-archived-children E2E, padded to meet spec validator minimum length.",
			createdAt: now - 1000,
			updatedAt: now - 1000,
			parentGoalId: parentId,
			rootGoalId: parentId,
			spawnedFromPlanId: "p-archived",
			archived: true,
			archivedAt: now - 500,
			projectId,
		});

		// Seed cost stamped by goalId on the archived child so the
		// tree-cost breakdown has a non-zero row to assert against.
		if (costTracker?.recordUsage) {
			costTracker.recordUsage(`sess-${liveChildId}`,     { cost: 0.02, inputTokens: 200, outputTokens: 100 }, liveChildId);
			costTracker.recordUsage(`sess-${completeChildId}`, { cost: 0.03, inputTokens: 300, outputTokens: 150 }, completeChildId);
			costTracker.recordUsage(`sess-${archivedChildId}`, { cost: 0.05, inputTokens: 500, outputTokens: 250 }, archivedChildId);
		}
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	test("Plan tab shows live + completed + archived children; live-only toggle hides archived; cost breakdown attributes archived spend", async ({ page }) => {
		// Sanity: descendants endpoint reports all three.
		const descRes = await apiFetch(`/api/goals/${parentId}/descendants`);
		expect(descRes.status).toBe(200);
		const desc = await descRes.json() as { goals: Array<{ id: string; archived?: boolean }> };
		const ids = new Set(desc.goals.map(g => g.id));
		expect(ids.has(liveChildId)).toBe(true);
		expect(ids.has(completeChildId)).toBe(true);
		expect(ids.has(archivedChildId)).toBe(true);
		const archivedDesc = desc.goals.find(g => g.id === archivedChildId);
		expect(archivedDesc?.archived).toBe(true);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);

		// Open Plan tab.
		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();
		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 10_000 });

		// All three plan-nodes appear by default — including archived.
		const allNodes = page.locator('[data-testid="plan-node"]');
		await expect(allNodes).toHaveCount(3, { timeout: 10_000 });

		const archivedNode = page.locator('[data-testid="plan-node"][data-archived="true"]').first();
		await expect(archivedNode).toBeVisible({ timeout: 10_000 });

		// Reload — archived child must still be visible after a fresh hydrate.
		await page.reload();
		await expect(page.locator('[data-testid="tab-plan"]').first()).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="tab-plan"]').first().click();
		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="plan-node"]')).toHaveCount(3, { timeout: 10_000 });
		await expect(
			page.locator('[data-testid="plan-node"][data-archived="true"]').first(),
		).toBeVisible({ timeout: 10_000 });

		// Toggle live-only — archived child must disappear, live remains.
		const toggle = page.locator('[data-testid="plan-live-only-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await expect(toggle).toHaveAttribute("data-live-only", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("data-live-only", "true", { timeout: 5_000 });

		// After toggle, archived nodes are filtered out. The live
		// in-progress child must remain. Completed (non-archived) children
		// also remain — `liveOnly` filters by `archived`, not by state.
		await expect(
			page.locator('[data-testid="plan-node"][data-archived="true"]'),
		).toHaveCount(0, { timeout: 10_000 });
		const remaining = await page.locator('[data-testid="plan-node"]').count();
		expect(remaining).toBeGreaterThanOrEqual(1);

		// Toggle back — archived child reappears.
		await toggle.click();
		await expect(toggle).toHaveAttribute("data-live-only", "false", { timeout: 5_000 });
		await expect(
			page.locator('[data-testid="plan-node"][data-archived="true"]').first(),
		).toBeVisible({ timeout: 10_000 });

		// Tree-cost breakdown — archived child must be present with its
		// stamped cost. We assert via the API surface (UI render of the
		// breakdown is covered by `tree-cost-rollup.spec.ts`); this test
		// pins the attribution contract for archived rows specifically.
		const treeRes = await apiFetch(`/api/goals/${parentId}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json() as {
			rootGoalId: string;
			totalCostUsd: number;
			breakdown: Array<{ goalId: string; costUsd: number; tokensIn: number; tokensOut: number; title?: string }>;
		};
		expect(tree.rootGoalId).toBe(parentId);
		const archivedRow = tree.breakdown.find(e => e.goalId === archivedChildId);
		expect(archivedRow, "archived child must have a breakdown row").toBeTruthy();
		expect(archivedRow!.costUsd).toBeGreaterThan(0);
		expect(archivedRow!.tokensIn).toBeGreaterThan(0);
		expect(tree.totalCostUsd).toBeGreaterThanOrEqual(archivedRow!.costUsd);

		// All three children appear in the breakdown.
		const breakdownIds = new Set(tree.breakdown.map(e => e.goalId));
		expect(breakdownIds.has(liveChildId)).toBe(true);
		expect(breakdownIds.has(completeChildId)).toBe(true);
		expect(breakdownIds.has(archivedChildId)).toBe(true);
	});
});
