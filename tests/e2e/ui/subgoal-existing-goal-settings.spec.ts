/**
 * BROWSER E2E — existing-goal Sub-goals settings (the dead-end fix).
 *
 * Goal acceptance criterion: "A user can enable sub-goals on an existing goal
 * via the UI, then successfully create a child under it." This covers the full
 * human path end-to-end:
 *
 *   1. Create a top-level parent with `subgoalsAllowed: false` (the PR #497
 *      default that produced the "Parent doesn't allow sub-goals" dead-end).
 *   2. Open its dashboard → Children tab and find the Sub-goal settings control.
 *   3. Toggle "Allow sub-goals" ON — driven by the browser, so the request
 *      carries the gateway-minted `bobbit_session` cookie and is authorized by
 *      the OPERATOR-class policy auth (no team-lead secret needed). Previously
 *      this 403'd because the route was orchestration-only.
 *   4. The new value persists across a full page reload.
 *   5. A child can now be created under that parent (201) — the unblock.
 *
 * This is the regression guard for the narrowed `PATCH /api/goals/:id/policy`
 * auth: subgoal-only edits are operator-authorized (human cookie), so the
 * dashboard control actually works for a human operator.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	defaultProjectId,
	nonGitCwd,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

const PARENT_SPEC =
	"Parent goal for the existing-goal sub-goal settings E2E — padded to satisfy the spec minimum length validator.";

test.describe("Existing-goal Sub-goals settings", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("enable sub-goals on an existing parent via the dashboard, persist across reload, then create a child", async ({ page }) => {
		await setSubgoalsEnabled(true);
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const parent = await createGoal({
			title: `existing-settings ${stamp}`,
			spec: PARENT_SPEC,
			team: false,
			subgoalsAllowed: false,
		});
		const parentId = parent.id;
		let childId: string | undefined;

		try {
			// Starting state: sub-goals OFF on the parent.
			const before = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(before.subgoalsAllowed).toBe(false);

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

			// Children tab is reachable even with no children because the goal
			// can host them (nesting headroom). Open it.
			const childrenTab = page.locator('[data-testid="tab-children"]');
			await expect(childrenTab).toBeVisible({ timeout: 10_000 });
			await childrenTab.click();

			const settings = page.locator('[data-testid="goal-subgoal-settings"]');
			await expect(settings).toBeVisible({ timeout: 10_000 });

			const allowToggle = page.locator('[data-testid="goal-subgoal-settings-allow-toggle"]');
			await expect(allowToggle).toBeVisible();
			await expect(allowToggle).not.toBeChecked();

			// Toggle ON — browser-driven, so the cookie authorizes the
			// operator-class PATCH /policy.
			await allowToggle.check();

			// Server persisted the change (operator auth succeeded — not a 403).
			await expect.poll(async () => {
				const g = await (await apiFetch(`/api/goals/${parentId}`)).json();
				return g.subgoalsAllowed;
			}, { timeout: 10_000 }).toBe(true);

			// The toggle reflects the persisted ON state in the live UI.
			await expect(allowToggle).toBeChecked({ timeout: 10_000 });

			// Persistence across a full reload.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/goal/${parentId}`);
			await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });
			await page.locator('[data-testid="tab-children"]').click();
			await expect(
				page.locator('[data-testid="goal-subgoal-settings-allow-toggle"]'),
			).toBeChecked({ timeout: 10_000 });

			// The unblock: a child can now be created under the parent.
			const childResp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `child under enabled parent ${stamp}`,
					cwd: nonGitCwd(),
					worktree: false,
					autoStartTeam: false,
					workflowId: "feature",
					spec: PARENT_SPEC,
					projectId: await defaultProjectId(),
					parentGoalId: parentId,
				}),
			});
			expect(childResp.status).toBe(201);
			const childBody = await childResp.json();
			childId = childBody.id as string;
			expect(childBody.parentGoalId).toBe(parentId);
		} finally {
			if (childId) await deleteGoal(childId).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
			await setSubgoalsEnabled(true);
		}
	});
});
