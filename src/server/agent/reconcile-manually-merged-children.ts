/**
 * Reconcile manually-merged children: detect children whose branches
 * are merged into their parent's branch via `git merge` outside of
 * Bobbit's three auto-archive paths (runSubgoalStep, eager-merge IIFE,
 * integrate-child REST), and archive them.
 *
 * Live test (PR #409): the user manually resolved a merge conflict
 * via `git merge` in the terminal for the storage-sqlite-and-markdown
 * child (9dbbce41). The merge commit landed on the v0.1-foundation
 * branch but the child goal record stayed `state: complete,
 * archived: false` indefinitely \u2014 because none of the three Bobbit-
 * driven merge paths got retriggered after the manual merge.
 *
 * Strategy: for each non-archived child of the given parent goal
 * whose `ready-to-merge` gate has passed, check whether the child's
 * branch tip is reachable from the parent's branch HEAD via
 * `git merge-base --is-ancestor`. If yes \u2192 the merge already
 * happened, archive the child.
 *
 * This module is the PURE planning logic only \u2014 it returns the list
 * of child goal IDs that should be archived. The caller (server.ts /
 * verification-harness.ts) is responsible for actually invoking
 * `teamManager.teardownTeam` + `goalManager.archiveGoal`.
 *
 * Pure-function design lets us unit-test the decision tree without
 * shelling out to git or wiring up the team manager.
 */

export interface ReconcileChildLike {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
	branch?: string;
	state?: string;
}

export interface ReconcileGateInput {
	gateId: string;
	status: "pending" | "running" | "passed" | "failed";
}

/**
 * Decide whether a single child should be considered for manual-merge
 * reconciliation. Checked criteria:
 *   - child must be non-archived (idempotency \u2014 archived already
 *     means processed)
 *   - child must have a branch (otherwise there's nothing to merge)
 *   - child must NOT be the parent itself (defensive)
 *   - child's `ready-to-merge` gate must have passed (otherwise the
 *     work isn't actually integration-ready and a stray ancestor
 *     check could falsely archive a child whose work was reverted
 *     and isn't really done)
 *
 * Returns true iff the child qualifies for the git ancestry check.
 */
export function isReconcileCandidate(
	parentGoalId: string,
	child: ReconcileChildLike,
	childGates: ReconcileGateInput[],
): boolean {
	if (child.parentGoalId !== parentGoalId) return false;
	if (child.archived) return false;
	if (!child.branch) return false;
	if (child.id === parentGoalId) return false;
	const r2m = childGates.find(g => g.gateId === "ready-to-merge");
	if (!r2m || r2m.status !== "passed") return false;
	return true;
}

/**
 * Decide whether to archive a candidate child given the result of the
 * git ancestry check. Pulled out as its own predicate so the unit
 * tests don't need to mock git \u2014 the integration code computes
 * `isAncestor` once and feeds the result here.
 *
 *   isAncestor === true  \u2192 child branch tip is reachable from parent
 *                          branch HEAD \u2192 archive
 *   isAncestor === false \u2192 NOT yet merged (or merge was reverted) \u2192
 *                          leave alone
 *   isAncestor === null  \u2192 git command failed (ref missing,
 *                          permission, etc.) \u2192 leave alone
 *                          (defensive: never archive on a failed
 *                          ancestry check)
 */
export function shouldArchiveAfterAncestryCheck(isAncestor: boolean | null): boolean {
	return isAncestor === true;
}

/**
 * Build the list of child IDs that qualify for manual-merge
 * reconciliation, given a snapshot of the children + their gates.
 * The caller must then run the git ancestry check for each and feed
 * the result into `shouldArchiveAfterAncestryCheck` before invoking
 * `archiveGoal`. (We can't bundle git into this pure helper because
 * we want it testable under node:test without git fixtures.)
 */
export function listReconcileCandidates(
	parentGoalId: string,
	children: ReconcileChildLike[],
	gatesByChild: Map<string, ReconcileGateInput[]>,
): ReconcileChildLike[] {
	const candidates: ReconcileChildLike[] = [];
	for (const c of children) {
		const childGates = gatesByChild.get(c.id) ?? [];
		if (isReconcileCandidate(parentGoalId, c, childGates)) {
			candidates.push(c);
		}
	}
	return candidates;
}
