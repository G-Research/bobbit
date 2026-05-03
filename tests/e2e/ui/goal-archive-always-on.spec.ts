/**
 * Goal archive button — always-on regression test.
 *
 * The trash/archive icon used to require `pr.state === "MERGED" && !hasActiveTeam`
 * before rendering, leaving non-merged or team-active goals with no archive
 * affordance in the sidebar. After the fix the icon must be visible and
 * clickable on any unarchived goal, with the confirmation modal handling the
 * team-active case.
 *
 * Coverage:
 *  1. Sidebar goal with no PR and no team — trash icon renders and clicking
 *     it opens the standard "Archive Goal" confirm modal.
 *  2. Cancel keeps the goal alive.
 *  3. Confirm archives the goal (DELETE /api/goals/:id).
 */
import { test, expect } from "../gateway-harness.js";
import { createGoal, deleteGoal, apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Goal archive button (always-on)", () => {
	test("non-merged, no-team goal shows trash icon and archives via confirm modal", async ({ page }) => {
		// Create a goal with no team, no worktree, no PR. Pre-fix this row had
		// no trash icon at all in the sidebar.
		const title = `Archive icon visibility ${Date.now()}`;
		const goal = await createGoal({ title, team: false, worktree: false });
		const goalId = goal.id;

		try {
			await openApp(page);

			// Find the goal row in the sidebar by its title.
			const goalRow = page.locator("div", { hasText: title }).first();
			await expect(goalRow).toBeVisible({ timeout: 10_000 });

			// The archive controls live in a hover-revealed action strip on
			// desktop. `force: true` bypasses the hidden→visible animation
			// race because the click handler is wired on the underlying
			// button regardless of the opacity transition.
			await goalRow.hover();

			// Resolve the archive button. The action strip is hover-revealed
			// (`hidden group-hover:flex`) on desktop — the button exists in
			// the DOM regardless. Asserting on `count() > 0` proves the
			// always-on render gate; clicks below use `force: true` to
			// bypass the CSS hide.
			const archiveButtons = page.locator('button[title="Archive goal"]');
			await expect.poll(async () => archiveButtons.count(), { timeout: 5_000 }).toBeGreaterThan(0);
			const archiveBtn = archiveButtons.first();

			// --- Cancel path ---
			// The archive button lives inside an `absolute hidden group-hover:flex`
			// strip. `click({ force: true })` still requires the element to be in
			// the layout box, which the `hidden` class prevents. Dispatch a
			// programmatic click against the underlying button instead — we are
			// asserting the always-on render+wiring, not pointer hit-testing.
			await archiveBtn.evaluate((el: HTMLElement) => el.click());
			// Dialog header reads "Archive Goal" for the no-team case.
			const dialogTitle = page.getByText("Archive Goal", { exact: true }).first();
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			// Body should reference the goal title.
			await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
			// Cancel — goal must remain.
			await page.getByRole("button", { name: "Cancel" }).first().click();
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

			let stillThere = await apiFetch(`/api/goals/${goalId}`);
			expect(stillThere.ok).toBe(true);

			// --- Confirm path ---
			await goalRow.hover();
			await archiveBtn.evaluate((el: HTMLElement) => el.click());
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			await page.getByRole("button", { name: "Archive", exact: true }).first().click();
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

			// Goal should now be archived. The server keeps the row but
			// flips `archived: true`. Poll briefly for the flag.
			await expect.poll(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (!r.ok) return "missing";
				const g = await r.json();
				return g.archived === true ? "archived" : "active";
			}, { timeout: 10_000 }).toBe("archived");
		} finally {
			await deleteGoal(goalId);
		}
	});
});
