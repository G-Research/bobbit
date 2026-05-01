/**
 * Pure helper: resolve a plan-DAG node's visual state from the live
 * goals tree.
 *
 * Extracted from `goal-dashboard.ts` so it can be unit-tested under
 * `node:test` without pulling the Lit / DOM render chain.
 *
 * Live test (PR #409): every plan node was rendering as "PENDING"
 * even after children completed and merged. Cause: the original code
 * keyed off `step.subgoal.childGoalId`, but the snapshotted plan
 * steps in `goal.inlineWorkflow.gates[execution].verify[]` are
 * frozen at goal-plan time \u2014 the harness records `childGoalId` on the
 * GATE SIGNAL verification record (live), NOT back on the snapshot.
 * So `step.subgoal.childGoalId` was always undefined and the state
 * always fell through to "pending".
 *
 * Fix: walk by `spawnedFromPlanId` on the live goals array (every
 * child carries this once spawned, regardless of whether it spawned
 * via the harness IIFE, the `goal_spawn_child` tool, or a re-signal
 * recovery path). Same idempotency tier (c) the harness's
 * `runSubgoalStep` uses.
 *
 * Multi-spawn handling: if multiple children share a planId (e.g. an
 * old shelved-and-archived attempt + a fresh re-spawn), prefer the
 * non-archived live one. If multiple are live, prefer the most recent
 * by createdAt (defensive \u2014 shouldn't happen post-fix but might
 * during edits / restarts).
 */

export interface PlanStepLike {
	subgoal?: { planId?: string; childGoalId?: string };
}

export interface PlanGoalLike {
	id: string;
	state?: string;
	archived?: boolean;
	spawnedFromPlanId?: string;
	createdAt?: number;
	paused?: boolean;
	pendingMutationCount?: number;
}

export type PlanNodeState = "pending" | "running" | "passed" | "failed" | "needs-input";

/** Resolve a plan-DAG node's visual state. Pure / no I/O.
 *
 *  Lookup tiers (in order of preference):
 *    (a) explicit `step.subgoal.childGoalId` if set (legacy / fresh-
 *        signal path);
 *    (b) walk goals where `g.spawnedFromPlanId === planId` and pick
 *        the best representative (live > archived; newer > older).
 *
 *  State mapping:
 *    - no child found anywhere       \u2192 "pending"
 *    - child.archived && complete    \u2192 "passed"  (auto-archive after
 *                                                  clean merge means
 *                                                  archived+complete
 *                                                  is the success
 *                                                  terminal state)
 *    - child.archived && !complete   \u2192 "failed"  (shelved / aborted /
 *                                                  zombie cleanup)
 *    - child.state === "complete"    \u2192 "passed"  (live but unmerged
 *                                                  \u2014 paused waiting
 *                                                  for parent merge)
 *    - child.state === "in-progress" \u2192 "running"
 *    - child.state === "shelved"     \u2192 "failed"
 *    - else                          \u2192 "pending"
 */
export function resolvePlanNodeState(step: PlanStepLike, goals: PlanGoalLike[]): PlanNodeState {
	const planId = step.subgoal?.planId;
	let child: PlanGoalLike | undefined;

	// Tier (a): explicit linkage (fast path).
	const explicitId = step.subgoal?.childGoalId;
	if (explicitId) {
		child = goals.find(g => g.id === explicitId);
	}

	// Tier (b): walk by spawnedFromPlanId (the actual source of truth
	// post-PR #409 \u2014 mirrors verification-harness's idempotency tier
	// (c) in `runSubgoalStep`).
	//
	// Preference order (live test PR #409: storage-sqlite-and-markdown
	// rendered FAILED because a sibling 'Storage live test' child shared
	// its planId, was archived in-progress, and had a newer createdAt
	// than the real merged child. Most-recent-wins shadowed the success):
	//   1. live in-progress (work is happening now -- highest priority)
	//   2. archived + complete (success terminal -- the merged child)
	//   3. live but other state (todo / shelved)
	//   4. archived non-complete (zombie / aborted -- lowest priority)
	// Within each tier, prefer most-recent createdAt.
	if (!child && planId) {
		const candidates = goals.filter(g => g.spawnedFromPlanId === planId);
		if (candidates.length > 0) {
			const rank = (g: PlanGoalLike): number => {
				if (!g.archived && g.state === "in-progress") return 0;
				if (g.archived && g.state === "complete") return 1;
				if (!g.archived) return 2;
				return 3;
			};
			child = candidates.slice().sort((a, b) => {
				const ra = rank(a);
				const rb = rank(b);
				if (ra !== rb) return ra - rb;
				return (b.createdAt ?? 0) - (a.createdAt ?? 0);
			})[0];
		}
	}

	if (!child) return "pending";

	// Archived children: distinguish auto-archive-after-merge (passed)
	// from shelved/aborted/zombie-cleanup (failed).
	if (child.archived) {
		return child.state === "complete" ? "passed" : "failed";
	}

	// Live but paused or with a pending mutation banner waiting on user
	// approval — surface as "needs-input" (yellow) so the user knows
	// progress is human-blocked rather than agent-driven.
	if (child.paused === true) return "needs-input";
	if ((child.pendingMutationCount ?? 0) > 0) return "needs-input";

	switch (child.state) {
		case "complete": return "passed";
		case "in-progress": return "running";
		case "shelved": return "failed";
		case "todo":
		default: return "pending";
	}
}
