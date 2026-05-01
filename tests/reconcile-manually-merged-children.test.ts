/**
 * Pinned regression: manually-merged child reconciliation.
 *
 * Live test (PR #409): the user manually resolved a merge conflict
 * via `git merge` in the terminal for the storage-sqlite-and-markdown
 * leaf (9dbbce41). The merge commit landed on the v0.1-foundation
 * branch but the child goal record stayed `state: complete,
 * archived: false` indefinitely — none of the three Bobbit-driven
 * merge paths (runSubgoalStep, eager-merge IIFE, integrate-child
 * REST) got retriggered after the manual merge.
 *
 * Fix: on every `execution` gate signal (manual or auto), reconcile
 * by checking `git merge-base --is-ancestor <child-branch> HEAD` for
 * each non-archived child whose ready-to-merge has passed. This
 * tests the pure planning logic — the integration code (server.ts)
 * runs the actual git command + archive.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isReconcileCandidate,
	shouldArchiveAfterAncestryCheck,
	listReconcileCandidates,
	type ReconcileChildLike,
	type ReconcileGateInput,
} from "../src/server/agent/reconcile-manually-merged-children.js";

const child = (over: Partial<ReconcileChildLike> & Pick<ReconcileChildLike, "id">): ReconcileChildLike => ({
	parentGoalId: "p1",
	archived: false,
	branch: "goal/test-branch",
	state: "complete",
	...over,
});

const gates = (over: Array<Partial<ReconcileGateInput> & Pick<ReconcileGateInput, "gateId">>): ReconcileGateInput[] =>
	over.map(g => ({ status: "passed" as const, ...g })) as ReconcileGateInput[];

describe("isReconcileCandidate predicate", () => {
	it("the canonical case: non-archived child of parent with ready-to-merge passed and a branch", () => {
		const c = child({ id: "c1" });
		const g = gates([{ gateId: "ready-to-merge", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), true);
	});

	it("REJECTS child of a different parent", () => {
		const c = child({ id: "c1", parentGoalId: "other" });
		const g = gates([{ gateId: "ready-to-merge", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS already-archived child (idempotency: don't re-process)", () => {
		const c = child({ id: "c1", archived: true });
		const g = gates([{ gateId: "ready-to-merge", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS child with no branch", () => {
		const c = child({ id: "c1", branch: undefined });
		const g = gates([{ gateId: "ready-to-merge", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS child whose ready-to-merge has NOT passed (still pending)", () => {
		// Defensive: if the child's work isn't actually integration-
		// ready, even if ancestry happens to match (e.g. branch is
		// historically descended), don't archive.
		const c = child({ id: "c1" });
		const g = gates([{ gateId: "ready-to-merge", status: "pending" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS child whose ready-to-merge failed", () => {
		const c = child({ id: "c1" });
		const g = gates([{ gateId: "ready-to-merge", status: "failed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS child with no ready-to-merge gate at all (only design-doc / implementation gates)", () => {
		const c = child({ id: "c1" });
		const g = gates([{ gateId: "design-doc", status: "passed" }, { gateId: "implementation", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});

	it("REJECTS the parent goal itself (defensive — should never happen)", () => {
		const c = child({ id: "p1", parentGoalId: undefined });
		const g = gates([{ gateId: "ready-to-merge", status: "passed" }]);
		assert.equal(isReconcileCandidate("p1", c, g), false);
	});
});

describe("shouldArchiveAfterAncestryCheck predicate", () => {
	it("archives when isAncestor === true (branch IS reachable from parent HEAD)", () => {
		assert.equal(shouldArchiveAfterAncestryCheck(true), true);
	});

	it("does NOT archive when isAncestor === false (NOT yet merged)", () => {
		assert.equal(shouldArchiveAfterAncestryCheck(false), false);
	});

	it("does NOT archive on null (git command failed; defensive — don't archive on uncertainty)", () => {
		assert.equal(shouldArchiveAfterAncestryCheck(null), false);
	});
});

describe("listReconcileCandidates filter", () => {
	const r2mPassed = gates([{ gateId: "ready-to-merge", status: "passed" }]);
	const r2mPending = gates([{ gateId: "ready-to-merge", status: "pending" }]);

	it("returns only the qualifying children", () => {
		const children = [
			child({ id: "live-passed", branch: "goal/a" }),                      // qualifies
			child({ id: "archived", archived: true }),                           // archived
			child({ id: "no-branch", branch: undefined }),                       // no branch
			child({ id: "wrong-parent", parentGoalId: "other" }),                // diff parent
			child({ id: "r2m-pending", branch: "goal/b" }),                      // gate not passed
		];
		const gatesByChild = new Map<string, ReconcileGateInput[]>();
		for (const c of children) {
			gatesByChild.set(c.id, c.id === "r2m-pending" ? r2mPending : r2mPassed);
		}
		const result = listReconcileCandidates("p1", children, gatesByChild);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "live-passed");
	});

	it("returns [] when no children at all", () => {
		assert.deepEqual(listReconcileCandidates("p1", [], new Map()), []);
	});

	it("returns [] when the parent has no qualifying children (all live but none ready-to-merge)", () => {
		const children = [
			child({ id: "c1", branch: "goal/a" }),
			child({ id: "c2", branch: "goal/b" }),
		];
		const gatesByChild = new Map<string, ReconcileGateInput[]>();
		for (const c of children) {
			gatesByChild.set(c.id, r2mPending);
		}
		assert.deepEqual(listReconcileCandidates("p1", children, gatesByChild), []);
	});

	it("returns multiple candidates when multiple children all qualify (e.g. user batch-resolved 3 conflicts)", () => {
		const children = [
			child({ id: "c1", branch: "goal/a" }),
			child({ id: "c2", branch: "goal/b" }),
			child({ id: "c3", branch: "goal/c" }),
		];
		const gatesByChild = new Map<string, ReconcileGateInput[]>();
		for (const c of children) {
			gatesByChild.set(c.id, r2mPassed);
		}
		const result = listReconcileCandidates("p1", children, gatesByChild);
		assert.equal(result.length, 3);
		assert.deepEqual(result.map(c => c.id).sort(), ["c1", "c2", "c3"]);
	});
});
