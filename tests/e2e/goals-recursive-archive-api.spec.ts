/**
 * E2E tests: DELETE /api/goals/:id?recursive=1 (design §8).
 *
 * Coverage:
 *   - 3-level tree (root → child → grandchild) with `?recursive=1` archives
 *     all 3 entries deepest-first; response shape `{ archived: [...ids] }`.
 *   - Without `?recursive=1`, only the named goal is archived; descendants
 *     remain queryable.
 *   - `?recursive=1` from an intermediate node archives that node + its
 *     descendants only — siblings under the root are untouched.
 *
 * The recursive walk excludes ancestors of the named goal — archiving the
 * mid-level only must leave the root alive.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd } from "./e2e-setup.js";

async function createGoal(opts: { title: string; parentGoalId?: string; projectId: string }): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: opts.title,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId: opts.projectId,
			autoStartTeam: false,
			...(opts.parentGoalId ? { parentGoalId: opts.parentGoalId } : {}),
		}),
	});
	if (resp.status !== 201) {
		const body = await resp.text().catch(() => "");
		throw new Error(`POST /api/goals failed: ${resp.status} ${body}`);
	}
	const goal = await resp.json();
	return goal.id;
}

async function fetchGoal(id: string): Promise<any> {
	const resp = await apiFetch(`/api/goals/${id}`);
	if (resp.status !== 200) {
		const body = await resp.text().catch(() => "");
		throw new Error(`GET /api/goals/${id} failed: ${resp.status} ${body}`);
	}
	return resp.json();
}

async function bestEffortDelete(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => { });
}

test.describe("DELETE /api/goals/:id?recursive=1", () => {
	test("?recursive=1 archives root + child + grandchild deepest-first", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = await createGoal({ title: `Recursive Root ${stamp}`, projectId: projectId! });
		const child = await createGoal({ title: `Recursive Child ${stamp}`, parentGoalId: root, projectId: projectId! });
		const grandchild = await createGoal({ title: `Recursive Grandchild ${stamp}`, parentGoalId: child, projectId: projectId! });
		try {
			// Sanity: tree is registered.
			const tree = await apiFetch(`/api/goals/${root}?include=tree`);
			expect(tree.status).toBe(200);
			const treeJson = await tree.json();
			const ids = (treeJson.descendants ?? []).map((g: any) => g.id);
			expect(ids).toContain(root);
			expect(ids).toContain(child);
			expect(ids).toContain(grandchild);

			// Recursive archive from the root.
			const resp = await apiFetch(`/api/goals/${root}?recursive=1`, { method: "DELETE" });
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(Array.isArray(body.archived)).toBe(true);
			expect(body.archived).toHaveLength(3);
			expect(body.archived).toEqual(expect.arrayContaining([root, child, grandchild]));

			// Deepest-first ordering: grandchild before child before root.
			const archived: string[] = body.archived;
			expect(archived.indexOf(grandchild)).toBeLessThan(archived.indexOf(child));
			expect(archived.indexOf(child)).toBeLessThan(archived.indexOf(root));

			// All three are now archived.
			for (const id of [root, child, grandchild]) {
				const fetched = await fetchGoal(id);
				expect(fetched.archived).toBe(true);
			}
		} finally {
			// Goals are already archived; fire-and-forget defensive cleanup.
			await bestEffortDelete(grandchild);
			await bestEffortDelete(child);
			await bestEffortDelete(root);
		}
	});

	test("without ?recursive=1, only the named goal is archived", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = await createGoal({ title: `NonRecursive Root ${stamp}`, projectId: projectId! });
		const child = await createGoal({ title: `NonRecursive Child ${stamp}`, parentGoalId: root, projectId: projectId! });
		const grandchild = await createGoal({ title: `NonRecursive Grandchild ${stamp}`, parentGoalId: child, projectId: projectId! });
		try {
			// Default DELETE archives only the named goal.
			const resp = await apiFetch(`/api/goals/${root}`, { method: "DELETE" });
			expect(resp.status).toBe(200);
			const body = await resp.json();
			// Default-archive returns `{ ok: true }`, NOT `{ archived: [...] }`.
			expect(body.ok).toBe(true);
			expect(body.archived).toBeUndefined();

			// Root archived; child + grandchild still alive.
			const rootFetched = await fetchGoal(root);
			expect(rootFetched.archived).toBe(true);
			const childFetched = await fetchGoal(child);
			expect(childFetched.archived).not.toBe(true);
			const grandFetched = await fetchGoal(grandchild);
			expect(grandFetched.archived).not.toBe(true);
		} finally {
			await bestEffortDelete(grandchild);
			await bestEffortDelete(child);
			await bestEffortDelete(root);
		}
	});

	test("?recursive=1 from an intermediate node archives only its subtree", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = await createGoal({ title: `Subtree Root ${stamp}`, projectId: projectId! });
		const childA = await createGoal({ title: `Subtree ChildA ${stamp}`, parentGoalId: root, projectId: projectId! });
		const childB = await createGoal({ title: `Subtree ChildB ${stamp}`, parentGoalId: root, projectId: projectId! });
		const grandA = await createGoal({ title: `Subtree GrandA ${stamp}`, parentGoalId: childA, projectId: projectId! });
		try {
			// Recursive archive of childA's subtree only.
			const resp = await apiFetch(`/api/goals/${childA}?recursive=1`, { method: "DELETE" });
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.archived).toHaveLength(2);
			expect(body.archived).toEqual(expect.arrayContaining([childA, grandA]));
			expect(body.archived).not.toContain(root);
			expect(body.archived).not.toContain(childB);

			// Root + childB are still alive; childA + grandA archived.
			expect((await fetchGoal(root)).archived).not.toBe(true);
			expect((await fetchGoal(childB)).archived).not.toBe(true);
			expect((await fetchGoal(childA)).archived).toBe(true);
			expect((await fetchGoal(grandA)).archived).toBe(true);
		} finally {
			await bestEffortDelete(grandA);
			await bestEffortDelete(childA);
			await bestEffortDelete(childB);
			await bestEffortDelete(root);
		}
	});
});
