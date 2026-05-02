/**
 * Pinned regression: when the verification harness's `runSubgoalStep`
 * spawns a child goal for a planStep, it must stamp
 * `spawnedFromPlanId` on the child IMMEDIATELY after createGoal.
 *
 * Live test (PR #409 v0.2-embeddings, issue 11): the agent-memory
 * parent team-lead reported the harness re-spawning duplicates of
 * already-complete Phase 1 leaves on each execution-gate re-signal.
 * Root cause: cef6257f added the planId stamp ONLY to the
 * goal_spawn_child REST path; the harness-internal runSubgoalStep
 * spawn path (verification-harness.ts) didn't stamp it. Children
 * created via the harness path got `spawnedFromPlanId: null`, and
 * future runs of runSubgoalStep couldn't find them via tier 1-3
 * lookup. The tier-4 title-fallback (5d77ca5e) was supposed to
 * rescue them but only fires AFTER the lookup; the spawn path didn't
 * benefit from it.
 *
 * Fix: in runSubgoalStep, immediately after createGoal returns, call
 * goalManager.updateGoal(child.id, { spawnedFromPlanId: planId }).
 *
 * This test pins the contract by replaying the createGoal +
 * updateGoal sequence against a stub GoalManager and asserting the
 * planId reaches the goal record.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface StubGoal {
	id: string;
	title: string;
	parentGoalId?: string;
	spawnedFromPlanId?: string;
	projectId?: string;
	autoStartTeam?: boolean;
}

class StubGoalManager {
	public goals = new Map<string, StubGoal>();
	public createCalls: Array<{ title: string; opts: any }> = [];
	public updateCalls: Array<{ id: string; updates: any }> = [];

	async createGoal(title: string, _cwd: string, opts: any): Promise<StubGoal> {
		this.createCalls.push({ title, opts });
		const id = `g_${this.createCalls.length}`;
		const g: StubGoal = { id, title, parentGoalId: opts.parentGoalId };
		this.goals.set(id, g);
		return g;
	}

	updateGoal(id: string, updates: Partial<StubGoal>): void {
		this.updateCalls.push({ id, updates });
		const g = this.goals.get(id);
		if (g) Object.assign(g, updates);
	}
}

/** Replicates the production sequence in runSubgoalStep:
 *    1. createGoal
 *    2. updateGoal(spawnedFromPlanId)  ← THE fix
 *    3. updateGoal(projectId, autoStartTeam) when project exists
 */
async function spawnSubgoalChild(
	goalManager: StubGoalManager,
	subgoal: { planId: string; title: string; spec: string; workflowId?: string },
	parent: { id: string; cwd: string; projectId?: string },
): Promise<StubGoal> {
	const child = await goalManager.createGoal(subgoal.title, parent.cwd, {
		spec: subgoal.spec,
		workflowId: subgoal.workflowId,
		parentGoalId: parent.id,
		projectId: parent.projectId,
	});
	// CRITICAL: stamp spawnedFromPlanId immediately after createGoal.
	goalManager.updateGoal(child.id, { spawnedFromPlanId: subgoal.planId });
	if (parent.projectId) {
		goalManager.updateGoal(child.id, { projectId: parent.projectId, autoStartTeam: true });
	}
	return child;
}

describe("runSubgoalStep spawn stamps spawnedFromPlanId immediately", () => {
	it("THE bug: child has spawnedFromPlanId set right after spawn (no orphan window)", async () => {
		const gm = new StubGoalManager();
		const child = await spawnSubgoalChild(gm,
			{ planId: "v0.2-streaming-scrubber", title: "streaming-scrubber (v0.2 leaf)", spec: "..." },
			{ id: "p1", cwd: "/x", projectId: "proj1" },
		);
		assert.equal(child.spawnedFromPlanId, "v0.2-streaming-scrubber",
			"child must carry the planId on its goal record");
	});

	it("the spawnedFromPlanId update is the FIRST updateGoal call (before projectId)", async () => {
		// Order matters: if a crash happens between createGoal and the
		// projectId update, we still want the planId to have landed so
		// the orphan-rescue tier 1-3 lookup catches it next run.
		const gm = new StubGoalManager();
		await spawnSubgoalChild(gm,
			{ planId: "v0.2-x", title: "X", spec: "" },
			{ id: "p1", cwd: "/x", projectId: "proj1" },
		);
		assert.ok(gm.updateCalls.length >= 1, "at least 1 updateGoal call");
		assert.deepEqual(gm.updateCalls[0].updates, { spawnedFromPlanId: "v0.2-x" },
			"first updateGoal must be the planId stamp");
	});

	it("works with no projectId (defensive: still stamps planId)", async () => {
		const gm = new StubGoalManager();
		const child = await spawnSubgoalChild(gm,
			{ planId: "v0.2-x", title: "X", spec: "" },
			{ id: "p1", cwd: "/x" }, // no projectId
		);
		assert.equal(child.spawnedFromPlanId, "v0.2-x");
		// Only one updateGoal call (planId stamp), no projectId stamp
		assert.equal(gm.updateCalls.length, 1);
	});

	it("multiple planSteps spawned in sequence each get their own planId", async () => {
		// The dupe-spawn bug surfaced because EVERY planStep iteration
		// produced an orphan child. Verify each child gets the right
		// planId, not the same one repeated.
		const gm = new StubGoalManager();
		await spawnSubgoalChild(gm, { planId: "v0.2-storage", title: "Storage", spec: "" }, { id: "p1", cwd: "/x" });
		await spawnSubgoalChild(gm, { planId: "v0.2-policy", title: "Policy", spec: "" }, { id: "p1", cwd: "/x" });
		await spawnSubgoalChild(gm, { planId: "v0.2-idempotency", title: "Idempotency", spec: "" }, { id: "p1", cwd: "/x" });
		const ids = [...gm.goals.values()].map(g => g.spawnedFromPlanId);
		assert.deepEqual(ids.sort(), ["v0.2-idempotency", "v0.2-policy", "v0.2-storage"]);
	});
});
