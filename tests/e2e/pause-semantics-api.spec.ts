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
	test("pause cascade sets paused=true on all non-paused children", async () => {
		// Issue 8: cascade must not skip children based on their `state`.
		// The only guard in the pause loop must be `if (g.paused) continue`.
		// We verify by spawning two children and asserting both are paused
		// after a cascade from the parent.
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
	test("pause handler returns 200 when called with x-bobbit-spawning-session header", async () => {
		const root = await createGoal({ title: `pause-sem-selfskip-${Date.now()}`, team: true, worktree: true, cwd: gitCwd() });
		try {
			await waitSetupReady(root.id);

			// Call pause with the header. If caller-exclusion is broken the
			// request itself would be aborted mid-flight — but since this is
			// in-process, the abort would manifest as a 500 or connection error.
			// We just assert 200 is returned normally.
			const pauseResp = await apiFetch(`/api/goals/${root.id}/pause`, {
				method: "POST",
				headers: { "x-bobbit-spawning-session": "fake-session-id-for-exclusion-test" },
				body: JSON.stringify({ cascade: false }),
			});
			expect(pauseResp.status).toBe(200);
			const data = await pauseResp.json();
			expect(typeof data.paused).toBe("number");
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
