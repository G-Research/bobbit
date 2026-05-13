/**
 * Pause-cascade — acceptance criterion 2 ("No new sessions for 60s
 * after pause" — supervisor-respawn whack-a-mole fix).
 *
 * `TeamManager._bootRespawnSessionlessGoals()` is invoked on every
 * boot / event-resubscription. It walks every in-progress, team-mode,
 * setupStatus=ready goal whose `teams` map has no live entry, and
 * spins up a fresh team-lead. Before this fix, an operator who paused
 * a goal then aborted (or crashed) its team-lead would see a new
 * team-lead reappear within seconds.
 *
 * This test:
 *  1. Starts a team for goal G.
 *  2. Pauses cascade on G.
 *  3. Removes G's `teams` entry (simulates a crash-recovery state in
 *     which the team-lead session was lost but the goal's persisted
 *     `team:true` flag survives) by tearing down the team.
 *  4. Invokes the supervisor sweep directly via the test-exposed
 *     `gateway.teamManager`.
 *  5. Asserts NO new team-lead session was created for G.
 *  6. Resumes G — the sweep is now allowed to respawn.
 *
 * See `docs/design/pause-cascade.md` §Call-site 7 (CRITICAL).
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	assertStaysFalse,
	createGoal,
	deleteGoal,
	gitCwd,
	startTeam,
	teardownTeam,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(120_000);

async function findTeamLeadSession(goalId: string): Promise<{ id: string; status: string } | null> {
	const r = await apiFetch(`/api/sessions`);
	if (r.status !== 200) return null;
	const data = await r.json() as { sessions: Array<{ id: string; role?: string; teamGoalId?: string; goalId?: string; status: string }> };
	const lead = data.sessions.find(s =>
		s.role === "team-lead"
		&& (s.teamGoalId === goalId || s.goalId === goalId)
		&& s.status !== "terminated",
	);
	return lead ? { id: lead.id, status: lead.status } : null;
}

test.describe("pause cascade — supervisor respawn skips paused goals", () => {
	test("_bootRespawnSessionlessGoals does NOT respawn a paused goal's team-lead", async ({ gateway }) => {
		const goal = await createGoal({
			title: `pause-respawn-${Date.now()}`,
			team: true,
			worktree: true,
			cwd: gitCwd(),
		});
		const goalId = goal.id;

		try {
			// Wait for setup to be ready.
			await pollUntil(async () => {
				const r = await apiFetch(`/api/goals/${goalId}`);
				if (r.status !== 200) return false;
				const g = await r.json();
				return g.setupStatus === "ready";
			}, { timeoutMs: 60_000, intervalMs: 200, label: `goal ${goalId} ready` });

			// Start the team (may already auto-start). Idempotent-ish: ignore errors.
			try {
				await startTeam(goalId);
			} catch { /* may already be running */ }

			await pollUntil(async () => !!(await findTeamLeadSession(goalId)),
				{ timeoutMs: 60_000, intervalMs: 200, label: "team-lead exists" });

			// Pause cascade.
			const pauseRes = await apiFetch(`/api/goals/${goalId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: true }),
			});
			expect(pauseRes.status).toBe(200);

			// Tear down the team — simulates the crash-recovery state in
			// which the live `teams` entry is missing for an in-progress
			// goal. `teardownTeam` also terminates the team-lead session.
			await teardownTeam(goalId, false);

			// Wait for the teams map entry to clear (event-driven via the
			// internal teamManager state — polling instead of sleeping).
			const tm = gateway.teamManager;
			expect(tm).toBeTruthy();
			await pollUntil(async () => !(tm as any).teams?.has(goalId),
				{ timeoutMs: 5_000, intervalMs: 50, label: "teams entry cleared" });

			// Invoke the supervisor sweep directly. This is the function
			// the gateway runs on every restart / resubscribe pass.
			(tm as any)._bootRespawnSessionlessGoals();

			// Assert: NO new team-lead session appears for this paused goal
			// within 3s of the sweep. (The sweep schedules `startTeam`
			// synchronously when not blocked, so 3s is plenty of slack.)
			let cached: { id: string; status: string } | null = null;
			let lastCheck = 0;
			await assertStaysFalse(() => {
				const now = Date.now();
				if (now - lastCheck >= 200) {
					lastCheck = now;
					findTeamLeadSession(goalId).then(l => { cached = l; }).catch(() => {});
				}
				const l = cached as { id: string; status: string } | null;
				if (!l) return false;
				// Treat terminated/aborted lingering sessions as not-a-respawn.
				return !(["terminated", "aborted", "aborting"].includes(l.status));
			}, { durationMs: 3_000, intervalMs: 100, message: "team-lead respawned on paused goal" });

			// Resume — sweep is now allowed.
			const resumeRes = await apiFetch(`/api/goals/${goalId}/resume`, {
				method: "POST",
				body: JSON.stringify({ cascade: true }),
			});
			expect(resumeRes.status).toBe(200);

			// After resume, the sweep may respawn — or operator can start manually.
			// Just assert the paused flag is cleared.
			const after = await (await apiFetch(`/api/goals/${goalId}`)).json();
			expect(after.paused).toBeFalsy();
		} finally {
			await deleteGoal(goalId, true);
		}
	});
});
