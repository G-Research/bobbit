/**
 * Pinned regression: child goals created by an interrupted spawn (e.g.
 * server restart between goalManager.createGoal() and gate
 * materialisation) leave a "zombie shell" \u2014 a goal record with
 * `state: in-progress` but no workflow gates and no team. From PR #409
 * live test (team-lead-317cdb83).
 *
 * Fix: at goal-plan signal time (when the auto-execution-signal IIFE
 * fires), reconcile zombie shells \u2014 walk children, archive any that
 * are non-archived but have no workflow gates. Idempotent on already-
 * archived goals; one-time hit at freeze / re-signal time.
 *
 * The unit test below pins the pure detection predicate; production
 * code in server.ts mirrors it inside the goal-plan signal handler's
 * pre-IIFE reconciliation loop.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ChildLike {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
	workflow?: { gates?: unknown[] };
}

/**
 * Replicates the production predicate: a child of `parentId` is a
 * zombie iff:
 *   - parentGoalId matches (immediate child only)
 *   - NOT already archived (archived children are filtered everywhere
 *     anyway; re-archiving is a no-op but pointless)
 *   - workflow has no gates (the structural marker of a failed-spawn:
 *     goal record exists, but the workflow snapshot was never populated
 *     because the spawn flow crashed before initGatesForGoal)
 */
function findZombies(parentId: string, goals: readonly ChildLike[]): string[] {
	const out: string[] = [];
	for (const g of goals) {
		if (g.parentGoalId !== parentId) continue;
		if (g.archived) continue;
		const hasGates = (g.workflow?.gates?.length ?? 0) > 0;
		if (hasGates) continue;
		out.push(g.id);
	}
	return out;
}

describe("zombie-shell reconciliation predicate", () => {
	it("returns empty for a healthy children list", () => {
		const goals: ChildLike[] = [
			{ id: "c1", parentGoalId: "p", workflow: { gates: [{ id: "design-doc" }] } },
			{ id: "c2", parentGoalId: "p", workflow: { gates: [{ id: "design-doc" }, { id: "impl" }] } },
		];
		assert.deepEqual(findZombies("p", goals), []);
	});

	it("flags a child with no workflow at all", () => {
		const goals: ChildLike[] = [
			{ id: "zombie-1", parentGoalId: "p" }, // no workflow field
		];
		assert.deepEqual(findZombies("p", goals), ["zombie-1"]);
	});

	it("flags a child with a workflow object but empty gates array", () => {
		// The exact shape we observed in the live test \u2014 createGoal returned,
		// workflow placeholder was set, but initGatesForGoal never ran.
		const goals: ChildLike[] = [
			{ id: "zombie-1", parentGoalId: "p", workflow: { gates: [] } },
		];
		assert.deepEqual(findZombies("p", goals), ["zombie-1"]);
	});

	it("does NOT flag already-archived children (no point re-archiving)", () => {
		const goals: ChildLike[] = [
			{ id: "archived-zombie", parentGoalId: "p", archived: true, workflow: { gates: [] } },
		];
		assert.deepEqual(findZombies("p", goals), []);
	});

	it("does NOT flag children of OTHER parents", () => {
		const goals: ChildLike[] = [
			{ id: "other-zombie", parentGoalId: "different-parent", workflow: { gates: [] } },
		];
		assert.deepEqual(findZombies("p", goals), []);
	});

	it("returns multiple zombies in encounter order", () => {
		const goals: ChildLike[] = [
			{ id: "z1", parentGoalId: "p", workflow: { gates: [] } },
			{ id: "healthy", parentGoalId: "p", workflow: { gates: [{ id: "g" }] } },
			{ id: "z2", parentGoalId: "p" },
			{ id: "z3", parentGoalId: "p", workflow: { gates: [] } },
		];
		assert.deepEqual(findZombies("p", goals), ["z1", "z2", "z3"]);
	});

	it("ignores transitive descendants \u2014 only IMMEDIATE children count", () => {
		// A grandchild zombie is the grandchild's parent's problem, not ours.
		const goals: ChildLike[] = [
			{ id: "child", parentGoalId: "p", workflow: { gates: [{ id: "g" }] } },
			{ id: "grandchild-zombie", parentGoalId: "child", workflow: { gates: [] } },
		];
		assert.deepEqual(findZombies("p", goals), []);
	});

	it("treats `workflow: undefined` and `workflow.gates: undefined` as zombie (defensive)", () => {
		// Both shapes show up in real-world data depending on the
		// interruption point. Either reads as "no gates" via the
		// optional-chain fallback.
		const goals: ChildLike[] = [
			{ id: "z1", parentGoalId: "p" }, // workflow undefined
			{ id: "z2", parentGoalId: "p", workflow: {} }, // gates undefined
			{ id: "z3", parentGoalId: "p", workflow: { gates: undefined as any } },
		];
		assert.deepEqual(findZombies("p", goals), ["z1", "z2", "z3"]);
	});
});
