/**
 * `DELETE /api/goals/:parentId/archive-child/:childId` — parent-scoped
 * archive route. Pins the security fix that prevents a team-lead from
 * archiving arbitrary goals by supplying their id to the general
 * `DELETE /api/goals/:id` route.
 *
 * Server-side, the new route enforces:
 *   - parent goal exists (404 otherwise).
 *   - child goal exists (404 otherwise).
 *   - `child.parentGoalId === parentId` (403 NOT_DIRECT_CHILD otherwise).
 *
 * Cascade + mergedManually semantics are unchanged — the handler
 * delegates to the same archive logic as the existing DELETE handler
 * after the auth check.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	gitCwd,
} from "./e2e-setup.js";

async function createGoal(opts: { title: string; parentGoalId?: string }): Promise<string> {
	const body: Record<string, unknown> = {
		title: opts.title,
		cwd: gitCwd(),
		autoStartTeam: false,
		workflowId: "feature",
	};
	if (opts.parentGoalId) body.parentGoalId = opts.parentGoalId;
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	return created.id;
}

test.describe("DELETE /api/goals/:parentId/archive-child/:childId", () => {
	test("direct-child success: archives child and returns 200 @smoke", async () => {
		const parentId = await createGoal({ title: `archive-child parent ${Date.now()}` });
		const childId = await createGoal({ title: `archive-child kid ${Date.now()}`, parentGoalId: parentId });
		try {
			const resp = await apiFetch(
				`/api/goals/${parentId}/archive-child/${childId}?cascade=false`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.ok).toBe(true);
			expect(body.archived).toBe(1);

			const verify = await apiFetch(`/api/goals/${childId}`);
			expect(verify.status).toBe(200);
			const childGoal = await verify.json();
			expect(childGoal.archived).toBe(true);
		} finally {
			await deleteGoal(childId).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
		}
	});

	test("non-child rejection: 403 when target is a root/sibling goal", async () => {
		const parentId = await createGoal({ title: `archive-child parent A ${Date.now()}` });
		const otherRoot = await createGoal({ title: `archive-child unrelated root ${Date.now()}` });
		try {
			const resp = await apiFetch(
				`/api/goals/${parentId}/archive-child/${otherRoot}?cascade=false`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_DIRECT_CHILD");

			// Confirm the unrelated goal is still alive.
			const verify = await apiFetch(`/api/goals/${otherRoot}`);
			expect(verify.status).toBe(200);
			const stillAlive = await verify.json();
			expect(stillAlive.archived).not.toBe(true);
		} finally {
			await deleteGoal(otherRoot).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
		}
	});

	test("sibling rejection: child of a different parent is not a direct child", async () => {
		const parentA = await createGoal({ title: `archive-child parent A ${Date.now()}` });
		const parentB = await createGoal({ title: `archive-child parent B ${Date.now()}` });
		const childOfB = await createGoal({ title: `archive-child B kid ${Date.now()}`, parentGoalId: parentB });
		try {
			const resp = await apiFetch(
				`/api/goals/${parentA}/archive-child/${childOfB}?cascade=false`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_DIRECT_CHILD");

			const verify = await apiFetch(`/api/goals/${childOfB}`);
			expect(verify.status).toBe(200);
			const stillAlive = await verify.json();
			expect(stillAlive.archived).not.toBe(true);
		} finally {
			await deleteGoal(childOfB).catch(() => {});
			await deleteGoal(parentB).catch(() => {});
			await deleteGoal(parentA).catch(() => {});
		}
	});

	test("missing child: 404", async () => {
		const parentId = await createGoal({ title: `archive-child parent ${Date.now()}` });
		try {
			const resp = await apiFetch(
				`/api/goals/${parentId}/archive-child/does-not-exist?cascade=false`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(404);
		} finally {
			await deleteGoal(parentId).catch(() => {});
		}
	});

	test("missing parent: 404", async () => {
		const orphan = await createGoal({ title: `archive-child orphan ${Date.now()}` });
		try {
			const resp = await apiFetch(
				`/api/goals/does-not-exist/archive-child/${orphan}?cascade=false`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(404);
		} finally {
			await deleteGoal(orphan).catch(() => {});
		}
	});

	test("cascade=true on direct child archives child + descendants", async () => {
		const parentId = await createGoal({ title: `archive-child parent ${Date.now()}` });
		const childId = await createGoal({ title: `archive-child kid ${Date.now()}`, parentGoalId: parentId });
		const grandchildId = await createGoal({ title: `archive-child grandkid ${Date.now()}`, parentGoalId: childId });
		try {
			const resp = await apiFetch(
				`/api/goals/${parentId}/archive-child/${childId}?cascade=true`,
				{ method: "DELETE" },
			);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.archived).toBeGreaterThanOrEqual(2);

			const childVerify = await (await apiFetch(`/api/goals/${childId}`)).json();
			expect(childVerify.archived).toBe(true);
			const grandVerify = await (await apiFetch(`/api/goals/${grandchildId}`)).json();
			expect(grandVerify.archived).toBe(true);
		} finally {
			await deleteGoal(grandchildId).catch(() => {});
			await deleteGoal(childId).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
		}
	});
});
