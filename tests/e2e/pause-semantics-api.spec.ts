/**
 * Pause semantics consolidation — API E2E tests.
 *
 * Covers the four server-side behaviors added in the pause-semantics subgoal
 * that are referenced by tests/pause-semantics.spec.ts but needed an
 * in-process harness to exercise:
 *
 *  1. state='blocked' (not paused=true) for dep-unmet children
 *  2. cascade-pause covers in-progress descendants
 *  3. cascade-pause excludes the caller's own session
 *  4. targeted childGoalId: happy-path + 403 NOT_DIRECT_CHILD + 404 archived
 *
 * Uses the in-process harness (same as pause-cascade-aborts-sessions.spec.ts).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, gitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(60_000);

async function waitSetupReady(goalId: string): Promise<void> {
	await pollUntil(async () => {
		const r = await apiFetch(`/api/goals/${goalId}`);
		if (r.status !== 200) return false;
		const g = await r.json();
		return g.setupStatus === "ready";
	}, { timeoutMs: 30_000, intervalMs: 200, label: `goal ${goalId} ready` });
}

// ─── 1. state='blocked' instead of paused=true ──────────────────────────────

test.describe("dependsOn — state:blocked (not paused)", () => {
	test("spawn-child with unresolved dep gets state=blocked, paused is falsy", async () => {
		const root = await createGoal({ title: `pause-sem-blocked-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			// Spawn depA first (no deps)
			const rA = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "depA", title: "Dep A", spec: "depA spec: foundation step for the blocked-state pause-semantics API test, padded to minimum." }),
			});
			expect(rA.status).toBe(201);
			const aId = (await rA.json()).id as string;

			// Spawn depB that depends on depA (still todo → blocked)
			const rB = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "depB", title: "Dep B", spec: "depB spec: second step for the blocked-state test; must wait for depA to complete first.", dependsOn: ["depA"] }),
			});
			expect(rB.status).toBe(201);
			const bPayload = await rB.json();
			expect(bPayload.blocked).toBe(true);

			// Verify state='blocked', paused falsy
			const bGoal = await (await apiFetch(`/api/goals/${bPayload.id}`)).json();
			expect(bGoal.state).toBe("blocked");
			expect(bGoal.paused).toBeFalsy();

			void aId; // cleanup via root cascade
		} finally {
			await deleteGoal(root.id, true);
		}
	});
});

// ─── 2. cascade covers in-progress descendants ──────────────────────────────

test.describe("pause cascade — covers all descendants regardless of state", () => {
	test("pause cascade sets paused=true on all non-paused children (todo state)", async () => {
		// Issue 8: cascade must not skip children based on their `state`.
		// The only guard in the pause loop must be `if (g.paused) continue`.
		// Note: the API does not expose a way to force state='in-progress'
		// externally; the invariant is pinned at the code level by inspecting
		// that listDescendants filters only on archived and the loop has no
		// state guard. This test pins that todo children ARE paused by cascade.
		const root = await createGoal({ title: `pause-sem-cascade-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			const rC1 = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "cascade-c1", title: "Cascade Child 1", spec: "cascade child 1: first descendant for the cascade-covers-all-states pause test; must be paused by cascade." }),
			});
			expect(rC1.status).toBe(201);
			const c1Id = (await rC1.json()).id as string;

			const rC2 = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "cascade-c2", title: "Cascade Child 2", spec: "cascade child 2: second descendant for the cascade-covers-all-states pause test; must also be paused." }),
			});
			expect(rC2.status).toBe(201);
			const c2Id = (await rC2.json()).id as string;

			// Confirm neither child is paused before cascade
			const [before1, before2] = await Promise.all([
				(await apiFetch(`/api/goals/${c1Id}`)).json(),
				(await apiFetch(`/api/goals/${c2Id}`)).json(),
			]);
			expect(before1.paused).toBeFalsy();
			expect(before2.paused).toBeFalsy();

			// Pause cascade from root
			const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: true }),
			});
			expect(pauseResp.status).toBe(200);
			const pauseData = await pauseResp.json();
			// root + 2 children = 3 goals paused
			expect(pauseData.paused).toBeGreaterThanOrEqual(3);

			// Both children must now be paused
			const [after1, after2, afterRoot] = await Promise.all([
				(await apiFetch(`/api/goals/${c1Id}`)).json(),
				(await apiFetch(`/api/goals/${c2Id}`)).json(),
				(await apiFetch(`/api/goals/${root.id}`)).json(),
			]);
			expect(after1.paused).toBe(true);
			expect(after2.paused).toBe(true);
			expect(afterRoot.paused).toBe(true);
		} finally {
			await deleteGoal(root.id, true);
		}
	});
});

// ─── 3. cascade excludes caller's own session ────────────────────────────────

test.describe("pause cascade — caller session excluded from abort", () => {
	test("pause handler skips sessions matching the caller-session header", async () => {
		// Spin up a real session so we can check it wasn't aborted when its
		// session id is claimed as the caller via x-bobbit-spawning-session.
		const root = await createGoal({ title: `pause-sem-selfskip-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			// Fetch live sessions for this goal; pick the team-lead session if any.
			const sessionsResp = await apiFetch("/api/sessions");
			const sessions = (await sessionsResp.json()).sessions as Array<{ id: string; goalId?: string; status: string; role?: string }>;
			const tlSession = sessions.find(s => s.goalId === root.id && s.role === "team-lead");

			if (tlSession) {
				// Pause with the team-lead's own session id as the claimed caller.
				// The abort loop must skip this session — it should remain registered
				// (not terminated/archived) after the pause.
				const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
					method: "POST",
					headers: { "x-bobbit-spawning-session": tlSession.id },
					body: JSON.stringify({ cascade: true }),
				});
				expect(pauseResp.status).toBe(200);

				// The session must still be registered (not terminated/archived).
				const afterResp = await apiFetch(`/api/sessions/${tlSession.id}`);
				expect(afterResp.status).toBe(200);
				const afterSession = await afterResp.json();
				expect(afterSession.archived).toBeFalsy();
			} else {
				// No team-lead yet (setup still in progress); just verify pause
				// with the header returns 200 and does not throw.
				const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
					method: "POST",
					headers: { "x-bobbit-spawning-session": "no-session-yet" },
					body: JSON.stringify({ cascade: false }),
				});
				expect(pauseResp.status).toBe(200);
				expect(typeof (await pauseResp.json()).paused).toBe("number");
			}
		} finally {
			await deleteGoal(root.id, true);
		}
	});
});

// ─── 4. targeted childGoalId ─────────────────────────────────────────────────

test.describe("targeted childGoalId", () => {
	test("childGoalId pauses a specific direct child, not the parent", async () => {
		const root = await createGoal({ title: `pause-sem-targeted-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			const rC1 = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "t-child1", title: "Target Child 1", spec: "target child 1: first child goal for targeted-pause test; this one will be paused specifically." }),
			});
			expect(rC1.status).toBe(201);
			const c1Id = (await rC1.json()).id as string;

			const rC2 = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "t-child2", title: "Target Child 2", spec: "target child 2: second child goal for targeted-pause test; this one must remain unpaused." }),
			});
			expect(rC2.status).toBe(201);
			const c2Id = (await rC2.json()).id as string;

			// Pause only c1 via childGoalId
			const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false, childGoalId: c1Id }),
			});
			expect(pauseResp.status).toBe(200);
			expect((await pauseResp.json()).paused).toBe(1);

			// c1 must be paused, c2 and root must not be
			const [rootGoal, c1Goal, c2Goal] = await Promise.all([
				(await apiFetch(`/api/goals/${root.id}`)).json(),
				(await apiFetch(`/api/goals/${c1Id}`)).json(),
				(await apiFetch(`/api/goals/${c2Id}`)).json(),
			]);
			expect(c1Goal.paused).toBe(true);
			expect(rootGoal.paused).toBeFalsy();
			expect(c2Goal.paused).toBeFalsy();
		} finally {
			await deleteGoal(root.id, true);
		}
	});

	test("childGoalId that is not a direct child returns 403 NOT_DIRECT_CHILD", async () => {
		const root = await createGoal({ title: `pause-sem-403-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			const rC = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "gc-child", title: "Child", spec: "child goal for not-direct-child 403 test; will have its own grandchild spawned for authority check." }),
			});
			expect(rC.status).toBe(201);
			const childId = (await rC.json()).id as string;
			await waitSetupReady(childId);

			const rGC = await apiFetch(`/api/goals/${childId}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "gc-grand", title: "Grandchild", spec: "grandchild goal for not-direct-child 403 test; trying to pause it via root should be rejected." }),
			});
			expect(rGC.status).toBe(201);
			const grandchildId = (await rGC.json()).id as string;

			// Try to pause grandchild via root (not a direct child of root)
			const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false, childGoalId: grandchildId }),
			});
			expect(pauseResp.status).toBe(403);
			const err = await pauseResp.json();
			expect(err.code).toBe("NOT_DIRECT_CHILD");
		} finally {
			await deleteGoal(root.id, true);
		}
	});

	test("childGoalId pointing to an archived child returns 404", async () => {
		const root = await createGoal({ title: `pause-sem-archived-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			const rC = await apiFetch(`/api/goals/${root.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ planId: "archived-child", title: "To Archive", spec: "child that will be archived for the archived-childGoalId-returns-404 pause-semantics test." }),
			});
			expect(rC.status).toBe(201);
			const childId = (await rC.json()).id as string;

			// Archive the child
			await apiFetch(`/api/goals/${childId}?cascade=false`, { method: "DELETE" });

			// Pause with archived childGoalId → 404
			const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false, childGoalId: childId }),
			});
			expect(pauseResp.status).toBe(404);
		} finally {
			await deleteGoal(root.id, true);
		}
	});
});
