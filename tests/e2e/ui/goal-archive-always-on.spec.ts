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
 *  1. Sidebar goal with no PR and no team — trash icon renders, the standard
 *     "Archive Goal" confirm modal opens, cancel preserves the goal, confirm
 *     archives it, and reloading the UI shows the goal no longer present in
 *     the active goal list (persistence).
 *  2. Sidebar goal with an active team — trash icon renders, the modal copy
 *     adapts ("Stop team and archive goal?", "Stop & Archive"), confirming
 *     tears down the team and archives the goal.
 *  3. Goal dashboard for a no-team goal — Archive button is present, enabled,
 *     and successfully archives the goal via the same confirm flow.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	createGoal,
	deleteGoal,
	apiFetch,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/**
 * Read the live `state.goals` list from the page and return the entry with
 * the given id (or null if not present). Live state is exposed under
 * `window.bobbitState` for diagnostics — callers must tolerate it being
 * undefined briefly during initial app load.
 */
async function readGoalFromState(page: Page, goalId: string): Promise<{ archived: boolean; present: boolean } | null> {
	return page.evaluate((id) => {
		const s = (window as any).bobbitState as
			| { goals: Array<{ id: string; archived?: boolean }> }
			| undefined;
		if (!s) return null;
		const g = s.goals.find((x) => x.id === id);
		return g ? { archived: g.archived === true, present: true } : { archived: false, present: false };
	}, goalId);
}

/**
 * Returns true when at least one non-terminated team-lead session is
 * registered for the given goal id in the client's `gatewaySessions`. The
 * `deleteGoal()` heuristic uses exactly this check to decide between the
 * standard and team-active modal copy.
 */
async function teamLeadActiveForGoal(page: Page, goalId: string): Promise<boolean> {
	return page.evaluate((id) => {
		const s = (window as any).bobbitState as
			| { gatewaySessions: Array<{ goalId?: string; teamGoalId?: string; role?: string; status?: string }> }
			| undefined;
		if (!s) return false;
		return s.gatewaySessions.some(
			(x) => (x.goalId === id || x.teamGoalId === id)
				&& x.role === "team-lead"
				&& x.status !== "terminated",
		);
	}, goalId);
}

test.describe("Goal archive button (always-on)", () => {
	test("non-merged, no-team goal: archives via confirm modal and persists across reload", async ({ page }) => {
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
			await goalRow.hover();

			// The action strip is hover-revealed (`hidden group-hover:flex`)
			// on desktop — the button exists in the DOM regardless. Asserting
			// on `count() > 0` proves the always-on render gate; clicks below
			// dispatch programmatically to bypass the CSS hide.
			const archiveButtons = page.locator('button[title="Archive goal"]');
			await expect.poll(async () => archiveButtons.count(), { timeout: 5_000 }).toBeGreaterThan(0);
			const archiveBtn = archiveButtons.first();

			// --- Cancel path ---
			await archiveBtn.evaluate((el: HTMLElement) => el.click());
			const dialogTitle = page.getByText("Archive Goal", { exact: true }).first();
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
			await page.getByRole("button", { name: "Cancel" }).first().click();
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

			const stillThere = await apiFetch(`/api/goals/${goalId}`);
			expect(stillThere.ok).toBe(true);

			// --- Confirm path ---
			await goalRow.hover();
			await archiveBtn.evaluate((el: HTMLElement) => el.click());
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			await page.getByRole("button", { name: "Archive", exact: true }).first().click();
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

			// Goal flagged archived server-side.
			await expect.poll(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (!r.ok) return "missing";
				const g = await r.json();
				return g.archived === true ? "archived" : "active";
			}, { timeout: 10_000 }).toBe("archived");

			// --- Persistence across reload ---
			// Reload the UI and assert the goal no longer appears in the
			// active goals list. The DOM hides archived goals from the
			// sidebar by default (See-Archived toggle is off), so the row
			// is gone entirely. We check the live `state.goals` array as
			// the source of truth and back it up with a DOM check.
			await page.reload();
			await openApp(page);
			await expect.poll(async () => {
				const v = await readGoalFromState(page, goalId);
				if (!v) return "no-state";
				if (!v.present) return "absent";
				return v.archived ? "archived" : "active";
			}, { timeout: 10_000 }).toMatch(/^(absent|archived)$/);

			// DOM check: the title must not appear as a visible active goal
			// row. The See-Archived toggle is off on a fresh reload, so the
			// row should not be rendered at all.
			const sidebar = page.locator("aside, nav, [role='complementary']").first();
			const sidebarHasTitle = await sidebar.locator("div", { hasText: title }).count().catch(() => 0);
			expect(sidebarHasTitle).toBe(0);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("team-active goal: dialog says 'Stop team and archive', confirm tears down team and archives", async ({ page }) => {
		// Create a real team goal. The mock-agent harness handles the team
		// lead startup without a real LLM. We start the team explicitly so
		// we can wait for the team-lead session to reach a non-terminated
		// state before asserting the heuristic in deleteGoal() picks it up.
		const title = `Team active archive ${Date.now()}`;
		// Probe: capture the raw body when create fails so the assertion message is
		// useful instead of just "got 400".
		const probeResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title, worktree: false, team: true, autoStartTeam: false, spec: "E2E test goal — spec for SPEC_REQUIRED guard." }),
		});
		if (probeResp.status !== 201) {
			const text = await probeResp.text();
			throw new Error(`createGoal failed ${probeResp.status}: ${text}`);
		}
		const goal = await probeResp.json();
		const goalId = goal.id;
		let teamLeadId: string | undefined;

		try {
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle");

			await openApp(page);

			// Wait for the client-side state to register the team-lead
			// session as non-terminated under this goal — that's the exact
			// heuristic `deleteGoal()` uses to pick the team-active copy.
			await expect.poll(
				async () => teamLeadActiveForGoal(page, goalId),
				{ timeout: 15_000 },
			).toBe(true);

			const goalRow = page.locator("div", { hasText: title }).first();
			await expect(goalRow).toBeVisible({ timeout: 10_000 });
			await goalRow.hover();

			const archiveButtons = page.locator('button[title="Archive goal"]');
			await expect.poll(async () => archiveButtons.count(), { timeout: 5_000 }).toBeGreaterThan(0);
			await archiveButtons.first().evaluate((el: HTMLElement) => el.click());

			// Team-active modal copy.
			const teamDialogTitle = page.getByText("Stop team and archive goal?", { exact: true }).first();
			await expect(teamDialogTitle).toBeVisible({ timeout: 5_000 });
			await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
			const confirmBtn = page.getByRole("button", { name: "Stop & Archive", exact: true }).first();
			await expect(confirmBtn).toBeVisible();

			// Confirm — teardown then DELETE.
			await confirmBtn.click();
			await expect(teamDialogTitle).toBeHidden({ timeout: 10_000 });

			// Server-side: goal archived.
			await expect.poll(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (!r.ok) return "missing";
				const g = await r.json();
				return g.archived === true ? "archived" : "active";
			}, { timeout: 15_000 }).toBe("archived");

			// Server-side: team lead torn down (teardownTeam ran first). The
			// session ends up either `terminated` (if still queryable) or
			// `archived` (if the goal-archive sweep moved it under archived
			// sessions); both prove teardown happened before DELETE.
			await expect.poll(async () => {
				if (!teamLeadId) return "missing";
				const r = await apiFetch(`/api/sessions/${teamLeadId}`);
				if (!r.ok) return "missing";
				const s = await r.json();
				return s.status;
			}, { timeout: 15_000 }).toMatch(/^(terminated|archived)$/);

			// UI persistence: reload, goal is no longer in the active list.
			await page.reload();
			await openApp(page);
			await expect.poll(async () => {
				const v = await readGoalFromState(page, goalId);
				if (!v) return "no-state";
				if (!v.present) return "absent";
				return v.archived ? "archived" : "active";
			}, { timeout: 10_000 }).toMatch(/^(absent|archived)$/);
		} finally {
			await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId);
		}
	});

	test("goal dashboard: Archive button is enabled and archives the goal", async ({ page }) => {
		const title = `Dashboard archive ${Date.now()}`;
		const goal = await createGoal({ title, team: false, worktree: false });
		const goalId = goal.id;

		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);

			// The dashboard Archive button is a `btn-icon` with the goal's
			// archive title. After the fix it must be present and enabled
			// regardless of team/PR state.
			const archiveBtn = page.locator('button.btn-icon[title="Archive goal"]').first();
			await expect(archiveBtn).toBeVisible({ timeout: 10_000 });
			await expect(archiveBtn).toBeEnabled();

			await archiveBtn.click();

			const dialogTitle = page.getByText("Archive Goal", { exact: true }).first();
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });

			// The dashboard renders an "Archive" button (the trash icon we
			// just clicked) and the modal renders its own confirm "Archive"
			// button — both match `getByRole("button", { name: "Archive" })`.
			// confirmAction() wires Enter to confirm and Escape to cancel, so
			// pressing Enter is the cleanest, ambiguity-free way to confirm
			// from a focused dialog.
			await page.keyboard.press("Enter");
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

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
