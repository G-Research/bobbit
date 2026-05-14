/**
 * Pause-cascade — acceptance criteria 1, 2, 3 & 5.
 *
 *  - `POST /pause {cascade:true}` aborts every streaming session in
 *    the subtree within 5s and prevents new ones for 60s.
 *  - While paused, `/team/spawn`, `/spawn-child` and `/gates/:id/signal`
 *    all return 409 `{ code: "GOAL_PAUSED", goalId }`.
 *  - `POST /resume {cascade:true}` clears the flag and re-opens spawn
 *    paths but does NOT auto-restart sessions.
 *
 * See `docs/design/pause-cascade.md`.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	gitCwd,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(120_000);

/** List all sessions whose goalId is in the given set. */
async function listSubtreeSessions(goalIds: Set<string>): Promise<Array<{ id: string; status: string; goalId?: string; role?: string }>> {
	const r = await apiFetch("/api/sessions");
	if (r.status !== 200) return [];
	const data = await r.json() as { sessions: Array<{ id: string; status: string; goalId?: string; role?: string }> };
	return data.sessions.filter(s => s.goalId && goalIds.has(s.goalId));
}

async function waitForSetupReady(goalId: string): Promise<void> {
	await pollUntil(async () => {
		const r = await apiFetch(`/api/goals/${goalId}`);
		if (r.status !== 200) return false;
		const g = await r.json();
		return g.setupStatus === "ready";
	}, { timeoutMs: 60_000, intervalMs: 200, label: `goal ${goalId} ready` });
}

test.describe("pause cascade — aborts sessions + blocks new spawns", () => {
	test("pause stops subtree sessions and returns 409 on spawn paths; resume re-enables spawn", async () => {
		// ─── Build a 3-goal subtree: R → C1, R → C2 ───────────────────
		const root = await createGoal({
			title: `pause-root-${Date.now()}`,
			team: true,
			worktree: true,
			cwd: gitCwd(),
		});
		const rootId = root.id;
		await waitForSetupReady(rootId);

		// Spawn two direct children via spawn-child (auto-starts their teams).
		const c1Resp = await apiFetch(`/api/goals/${rootId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p-c1", title: "pause-c1", spec: "c1 spec: first direct child for pause-cascade test, padded to meet spec validator minimum length." }),
		});
		expect(c1Resp.status).toBe(201);
		const c1Id = (await c1Resp.json()).id as string;

		const c2Resp = await apiFetch(`/api/goals/${rootId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p-c2", title: "pause-c2", spec: "c2 spec: second direct child for pause-cascade test, padded to meet spec validator minimum length." }),
		});
		expect(c2Resp.status).toBe(201);
		const c2Id = (await c2Resp.json()).id as string;

		const subtree = new Set([rootId, c1Id, c2Id]);

		try {
			// Wait until at least the root team-lead is streaming/idle (proves
			// pre-pause there ARE sessions in the subtree).
			await pollUntil(async () => {
				const sessions = await listSubtreeSessions(subtree);
				return sessions.some(s => s.role === "team-lead");
			}, { timeoutMs: 60_000, intervalMs: 200, label: "team-lead spawned in subtree" });

			// ─── 1. Pause cascade ───────────────────────────────────────
			const pauseResp = await apiFetch(`/api/goals/${rootId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: true }),
			});
			expect(pauseResp.status).toBe(200);
			const pauseData = await pauseResp.json();
			expect(pauseData.paused).toBeGreaterThanOrEqual(1);

			// All three goals should now be paused.
			for (const id of subtree) {
				const g = await (await apiFetch(`/api/goals/${id}`)).json();
				expect(g.paused).toBe(true);
			}

			// ─── 2. Within 5s no subtree session is streaming ───────────
			await pollUntil(async () => {
				const sessions = await listSubtreeSessions(subtree);
				return sessions.every(s => s.status !== "streaming");
			}, { timeoutMs: 5_000, intervalMs: 100, label: "subtree sessions stop streaming" });

			// ─── 2b. Soft-abort: sessions must still be registered ───────
			// pause-cascade uses abortSessionTurn (interrupt) not forceAbort
			// (terminate). Sessions remain registered and not archived.
			const subtreeSessions = await listSubtreeSessions(subtree);
			for (const s of subtreeSessions) {
				const detail = await (await apiFetch(`/api/sessions/${s.id}`)).json();
				expect(detail.archived).toBeFalsy();
			}

			// ─── 3. 409 GOAL_PAUSED from spawn endpoints ────────────────
			const teamSpawn = await apiFetch(`/api/goals/${c1Id}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role: "coder", task: "noop" }),
			});
			expect(teamSpawn.status).toBe(409);
			const teamSpawnBody = await teamSpawn.json();
			expect(teamSpawnBody.code).toBe("GOAL_PAUSED");
			expect(teamSpawnBody.goalId).toBe(c1Id);

			const spawnChild = await apiFetch(`/api/goals/${c1Id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "p-blocked", title: "blocked", spec: "should-not-spawn: this spawn must be rejected with GOAL_PAUSED because the parent is paused." }),
			});
			expect(spawnChild.status).toBe(409);
			const spawnChildBody = await spawnChild.json();
			expect(spawnChildBody.code).toBe("GOAL_PAUSED");
			expect(spawnChildBody.goalId).toBe(c1Id);

			// Gate signal — pick any gate on the goal's workflow.
			const goalDoc = await (await apiFetch(`/api/goals/${c1Id}`)).json();
			const someGateId: string | undefined = goalDoc?.workflow?.gates?.[0]?.id;
			if (someGateId) {
				const signal = await apiFetch(`/api/goals/${c1Id}/gates/${someGateId}/signal`, {
					method: "POST",
					body: JSON.stringify({ content: "should be blocked" }),
				});
				expect(signal.status).toBe(409);
				const signalBody = await signal.json();
				expect(signalBody.code).toBe("GOAL_PAUSED");
				expect(signalBody.goalId).toBe(c1Id);
			}

			// ─── 4. Resume cascade ──────────────────────────────────────
			const resumeResp = await apiFetch(`/api/goals/${rootId}/resume`, {
				method: "POST",
				body: JSON.stringify({ cascade: true }),
			});
			expect(resumeResp.status).toBe(200);

			for (const id of subtree) {
				const g = await (await apiFetch(`/api/goals/${id}`)).json();
				expect(g.paused).toBeFalsy();
			}

			// After resume, team/spawn must NOT 409 anymore. We don't require
			// it to fully succeed (worktree state may matter); we just assert
			// it stops returning GOAL_PAUSED.
			const reSpawn = await apiFetch(`/api/goals/${c1Id}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role: "coder", task: "noop after resume" }),
			});
			if (reSpawn.status === 409) {
				const body = await reSpawn.json();
				expect(body.code).not.toBe("GOAL_PAUSED");
			}
		} finally {
			await deleteGoal(rootId, true);
		}
	});
});
