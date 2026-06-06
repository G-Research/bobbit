/**
 * Finding 1 — `POST /api/goals` with `parentGoalId` must enforce the same
 * paused guarantee `/spawn-child` and the harness `runSubgoalStep` already do.
 *
 * Previously this path validated parent existence + nesting only, then created
 * and could auto-start the child — bypassing the pause cascade. These tests pin
 * that creating a child under a paused parent (or any paused ANCESTOR) is
 * refused with `409 GOAL_PAUSED` and no child is created.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	defaultProjectId,
	nonGitCwd,
} from "./e2e-setup.js";

async function createGoalRaw(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: "Parent goal for the paused-parent child-creation guard E2E — padded to satisfy the spec minimum length.",
			projectId: await defaultProjectId(),
			...body,
		}),
	});
	const text = await resp.text();
	let parsed: any;
	try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
	return { status: resp.status, body: parsed };
}

async function pauseGoal(id: string): Promise<number> {
	const resp = await apiFetch(`/api/goals/${id}/pause`, {
		method: "POST",
		body: JSON.stringify({ cascade: false }),
	});
	return resp.status;
}

test.describe("POST /api/goals child-creation paused guard (Finding 1)", () => {
	test("creating a child under a paused parent → 409 GOAL_PAUSED @smoke", async () => {
		const parent = await createGoalRaw({ title: `paused-parent ${Date.now()}` });
		expect(parent.status).toBe(201);
		const parentId = parent.body.id as string;
		try {
			expect(await pauseGoal(parentId)).toBe(200);

			const child = await createGoalRaw({
				title: "child under paused parent",
				parentGoalId: parentId,
				spec: "Child whose creation must be refused because its parent goal is paused — padded to meet the minimum spec length.",
			});
			expect(child.status).toBe(409);
			expect(child.body.code).toBe("GOAL_PAUSED");
			expect(child.body.goalId).toBe(parentId);
			// No child must have been created.
			expect(child.body.id).toBeUndefined();
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("creating a child under a goal whose ANCESTOR is paused → 409 GOAL_PAUSED", async () => {
		const root = await createGoalRaw({ title: `paused-ancestor root ${Date.now()}` });
		expect(root.status).toBe(201);
		const rootId = root.body.id as string;
		let midId: string | undefined;
		try {
			// mid is a live (unpaused) child of root.
			const mid = await createGoalRaw({
				title: "mid child (unpaused)",
				parentGoalId: rootId,
				spec: "Intermediate goal that is itself not paused; its parent (root) will be paused to exercise the ancestor walk.",
			});
			expect(mid.status).toBe(201);
			midId = mid.body.id as string;

			// Pause the ROOT (the grandparent of the would-be grandchild).
			expect(await pauseGoal(rootId)).toBe(200);

			// Creating a child under the (unpaused) mid must still be refused
			// because a paused ANCESTOR (root) sits above it.
			const grandchild = await createGoalRaw({
				title: "grandchild under paused ancestor",
				parentGoalId: midId,
				spec: "Grandchild whose creation must be refused because a paused ancestor (root) sits above its unpaused parent (mid).",
			});
			expect(grandchild.status).toBe(409);
			expect(grandchild.body.code).toBe("GOAL_PAUSED");
			// The guard reports the paused ancestor's id (root), not mid.
			expect(grandchild.body.goalId).toBe(rootId);
		} finally {
			await deleteGoal(rootId);
		}
	});

	test("creating a child under an unpaused parent still succeeds (no false positive)", async () => {
		const parent = await createGoalRaw({ title: `unpaused-parent ${Date.now()}` });
		expect(parent.status).toBe(201);
		const parentId = parent.body.id as string;
		let childId: string | undefined;
		try {
			const child = await createGoalRaw({
				title: "child under unpaused parent",
				parentGoalId: parentId,
				spec: "A child created under an unpaused parent must succeed — this guards against a false-positive pause rejection.",
			});
			expect(child.status).toBe(201);
			childId = child.body.id as string;
			expect(childId).toBeTruthy();
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parentId);
		}
	});
});
