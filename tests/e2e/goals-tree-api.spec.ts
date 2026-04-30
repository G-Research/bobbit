/**
 * E2E tests: GET /api/goals/:id?include=tree — narrow + broad goal-tree
 * projection landed by F1.
 *
 * The endpoint returns:
 *   { goal, descendants: PersistedGoal[], gatesByGoal: Record<goalId, GateState[]> }
 *
 * `descendants` is the flat tree of all goals where `rootGoalId === id`,
 * sorted by `(parentGoalId nulls-first, createdAt ASC)` — see
 * docs/design/nested-goals.md §8.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, defaultProjectId } from "./e2e-setup.js";

async function postGoal(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const resp = await apiFetch("/api/goals", { method: "POST", body: JSON.stringify(body) });
	const json = await resp.json().catch(() => ({}));
	return { status: resp.status, body: json };
}

async function deleteGoal(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("GET /api/goals/:id?include=tree", () => {
	test("returns the goal and an empty descendant list for a leaf top-level goal", async () => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		const top = await postGoal({
			title: `tree-top-${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			autoStartTeam: false,
			projectId: pid,
		});
		expect(top.status).toBe(201);
		try {
			const resp = await apiFetch(`/api/goals/${top.body.id}?include=tree`);
			expect(resp.status).toBe(200);
			const data = await resp.json();
			expect(data.goal.id).toBe(top.body.id);
			expect(Array.isArray(data.descendants)).toBe(true);
			// `getDescendants(rootId)` includes the root itself.
			expect(data.descendants.length).toBe(1);
			expect(data.descendants[0].id).toBe(top.body.id);
			expect(typeof data.gatesByGoal).toBe("object");
		} finally {
			await deleteGoal(top.body.id);
		}
	});

	test("returns root + children sorted nulls-first / createdAt ASC; includes per-goal gates", async () => {
		const pid = await defaultProjectId();
		const top = await postGoal({
			title: `tree-root-${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			autoStartTeam: false,
			projectId: pid,
		});
		expect(top.status).toBe(201);
		const childIds: string[] = [];
		try {
			// Two child goals — order matters for the createdAt-ASC sort.
			const c1 = await postGoal({
				title: `tree-child-1-${Date.now()}`,
				cwd: nonGitCwd(),
				team: false,
				worktree: false,
				autoStartTeam: false,
				projectId: pid,
				parentGoalId: top.body.id,
			});
			expect(c1.status).toBe(201);
			childIds.push(c1.body.id);
			// createdAt is taken from `Date.now()` at goal creation; back-to-back
			// calls within the same millisecond would tie. The createdAt-ASC sort
			// is a tie-breaker against the (already-stable) parentGoalId-nulls-
			// first axis, so a tie is fine — the test asserts presence of all
			// three goals and that the root sorts first; the relative order of
			// c1 vs c2 only matters when their createdAt differs. We assert
			// `c1Idx < c2Idx` only conditionally below.
			const c2 = await postGoal({
				title: `tree-child-2-${Date.now()}`,
				cwd: nonGitCwd(),
				team: false,
				worktree: false,
				autoStartTeam: false,
				projectId: pid,
				parentGoalId: top.body.id,
			});
			expect(c2.status).toBe(201);
			childIds.push(c2.body.id);

			const resp = await apiFetch(`/api/goals/${top.body.id}?include=tree`);
			expect(resp.status).toBe(200);
			const data = await resp.json();
			expect(data.goal.id).toBe(top.body.id);
			const ids = data.descendants.map((d: any) => d.id);
			expect(ids).toContain(top.body.id);
			expect(ids).toContain(c1.body.id);
			expect(ids).toContain(c2.body.id);
			// Root must land first — parentGoalId nulls-first, then createdAt ASC.
			expect(data.descendants[0].id).toBe(top.body.id);
			// Children are after root. createdAt-ASC ordering is a tie-breaker
			// when timestamps differ; if both fall in the same ms (legal), the
			// goal-store insertion order wins and c1 still lands before c2.
			const c1Idx = ids.indexOf(c1.body.id);
			const c2Idx = ids.indexOf(c2.body.id);
			expect(c1Idx).toBeGreaterThan(0);
			expect(c2Idx).toBeGreaterThan(0);
			if (c1.body.createdAt !== c2.body.createdAt) {
				expect(c1Idx).toBeLessThan(c2Idx);
			}

			// gatesByGoal is keyed by goalId; values may be empty arrays for
			// goals without workflow gates, but the structure is present.
			expect(data.gatesByGoal).toHaveProperty(top.body.id);
			expect(data.gatesByGoal).toHaveProperty(c1.body.id);
			expect(data.gatesByGoal).toHaveProperty(c2.body.id);
			expect(Array.isArray(data.gatesByGoal[top.body.id])).toBe(true);

			// Querying via a child should return the same descendants set
			// (root walk via rootGoalId).
			const childResp = await apiFetch(`/api/goals/${c1.body.id}?include=tree`);
			expect(childResp.status).toBe(200);
			const childData = await childResp.json();
			const childIdsOnly = childData.descendants.map((d: any) => d.id).sort();
			const expected = [top.body.id, c1.body.id, c2.body.id].sort();
			expect(childIdsOnly).toEqual(expected);
		} finally {
			for (const id of childIds) await deleteGoal(id);
			await deleteGoal(top.body.id);
		}
	});

	test("nonexistent goal → 404", async () => {
		const resp = await apiFetch(`/api/goals/no-such-goal?include=tree`);
		expect(resp.status).toBe(404);
	});

	test("absent include=tree returns the legacy goal shape (no descendants/gatesByGoal)", async () => {
		const pid = await defaultProjectId();
		const top = await postGoal({
			title: `tree-legacy-${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			autoStartTeam: false,
			projectId: pid,
		});
		expect(top.status).toBe(201);
		try {
			const resp = await apiFetch(`/api/goals/${top.body.id}`);
			expect(resp.status).toBe(200);
			const data = await resp.json();
			// Legacy shape: returns the goal record itself, not wrapped.
			expect(data.id).toBe(top.body.id);
			expect((data as any).descendants).toBeUndefined();
			expect((data as any).gatesByGoal).toBeUndefined();
		} finally {
			await deleteGoal(top.body.id);
		}
	});
});
