/**
 * QA-SPOT 2026-07-05 FINDING 2 — "the goal dashboard is unreachable".
 *
 * Two independent repros were logged against the QA seed environment:
 *
 *  (a) the sidebar's "Goal dashboard" quick-action button wasn't hittable
 *      by a real pointer click — `elementFromPoint` at the button's
 *      bounding-box center resolved to the row's truncating title `<span>`.
 *  (b) direct `#/goal/:id` navigation (even a cold fresh page load) fell
 *      back to the generic Headquarters empty state, silently, no console
 *      error.
 *
 * Root-cause findings (see src/app/routing.ts + tests/goal-hash-route-charset.test.ts):
 *
 *  - (b) was entirely explained by `getRouteFromHash()`'s `#/goal/:id`
 *    regex only accepting `[a-f0-9-]+` — the QA seed script's
 *    human-readable fixture id ("qa-seed-goal-0001-...") doesn't match
 *    that charset (letters like q/s/g/o/l aren't hex), so the hash fell
 *    through to `{ view: "landing" }`. Real production goal ids are
 *    always `crypto.randomUUID()` (a strict subset of the old AND new
 *    charset), so this never affected a real user-created goal — but the
 *    charset was needlessly stricter than every sibling id route in the
 *    same file, and it silently broke a valid navigation target with no
 *    error surfaced anywhere. Fixed by broadening the charset to match
 *    session/role/tool/workflow's `[a-zA-Z0-9_-]+`.
 *  - (a) does NOT reproduce with real pointer semantics. The sidebar
 *    action cluster uses the same `opacity-0 pointer-events-none
 *    group-hover:opacity-100 group-hover:pointer-events-auto` reveal
 *    pattern as every other sidebar row (session, archived session,
 *    staff) — by design, `elementFromPoint` on a *non-hovered* row will
 *    always resolve to whatever's underneath a `pointer-events: none`
 *    layer; that's not a defect, it's how CSS hit-testing works before
 *    :hover engages. `goal-archive-always-on.spec.ts` and
 *    `sidebar-goal-staff.spec.ts` already prove this exact row/cluster is
 *    clickable via `row.hover()` then `button.click()` for the adjacent
 *    "Archive" quick action and the overflow trigger — but until this
 *    spec, nothing pinned the "Goal dashboard" quick action specifically,
 *    which is the actual coverage gap: no e2e ever drove a cold
 *    `#/goal/:id` navigation OR a real-pointer click on this exact
 *    button, so a genuine regression in either path could have shipped
 *    silently.
 */
import { test, expect } from "../gateway-harness.js";
import { createGoal, deleteGoal, readE2ETokenAsync, base } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

function sidebarGoalRow(page: import("@playwright/test").Page, goalId: string) {
	return page.locator(`[data-nav-id="goal:${goalId}"]`);
}

const DASHBOARD_EMPTY_STATE_TEXT = "Start in Headquarters to configure Bobbit";

test.describe("Goal dashboard reachability (QA-SPOT Finding 2)", () => {
	test("cold direct navigation to #/goal/:id renders dashboard content on first paint, not the generic empty state", async ({ page }) => {
		const goal = await createGoal({ title: `Cold nav reachability ${Date.now()}` });
		try {
			const token = await readE2ETokenAsync();
			// Load the hash-target URL directly on first navigation — no prior
			// in-app hash assignment. This is the exact scenario QA's "fresh
			// full page load" repro used and the existing e2e suite never
			// covered (navigateToGoalDashboard always calls openApp() at "/"
			// first, then sets window.location.hash in-page).
			await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/goal/${goal.id}`, { waitUntil: "networkidle" });

			await expect(page.locator(`[data-testid^="tab-"]`).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(DASHBOARD_EMPTY_STATE_TEXT)).toHaveCount(0);
			expect(page.url()).toContain(`#/goal/${goal.id}`);
		} finally {
			await deleteGoal(goal.id as string);
		}
	});

	test("sidebar 'Goal dashboard' quick-action button is hittable by a real pointer click and navigates to the dashboard", async ({ page }) => {
		const goal = await createGoal({ title: `Sidebar click reachability ${Date.now()}` });
		try {
			await openApp(page);
			const goalRow = sidebarGoalRow(page, goal.id as string);
			await expect(goalRow).toBeVisible({ timeout: 10_000 });

			// Establish real hover first (mirrors goal-archive-always-on.spec.ts /
			// sidebar-goal-staff.spec.ts, which already prove this exact
			// hover-reveal cluster is clickable for its sibling actions).
			await goalRow.hover();
			const dashboardBtn = goalRow.getByRole("button", { name: "Goal dashboard", exact: true }).first();
			await expect(dashboardBtn).toBeVisible({ timeout: 5_000 });

			// Positive elementFromPoint pin: once hovered, the button's own
			// bounding-box center must resolve to the button itself (or a
			// descendant, e.g. its icon), not the row's title span. This is
			// the regression guard for the exact failure mode QA's
			// non-hovered elementFromPoint check reported.
			const box = await dashboardBtn.boundingBox();
			expect(box, "dashboard button must have a bounding box").toBeTruthy();
			const hitOk = await page.evaluate(({ x, y }) => {
				const el = document.elementFromPoint(x, y);
				const btn = el?.closest('[data-sidebar-action-id="dashboard"]');
				return btn != null;
			}, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
			expect(hitOk, "hovered dashboard button's center point should hit-test to the button, not an overlapping sibling").toBe(true);

			await dashboardBtn.click();

			await expect(page).toHaveURL(new RegExp(`#/goal/${goal.id}`));
			await expect(page.locator(`[data-testid^="tab-"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(DASHBOARD_EMPTY_STATE_TEXT)).toHaveCount(0);
		} finally {
			await deleteGoal(goal.id as string);
		}
	});
});
