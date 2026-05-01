/**
 * Pinned regression: a parent-pattern team-lead orchestrates a tree of
 * child goals via `goal_spawn_child` rather than `team_spawn`. While the
 * children are running, the parent legitimately has zero direct workers
 * and the team-lead session sits idle waiting on child progress.
 *
 * Before this fix, the 5-minute idle nudge timer fired regardless of
 * child state, dragging the team-lead into pointless `task_list` /
 * `gate_list` calls every nudge cycle. The agent-memory v0.1-foundation
 * team-lead reported this twice during a healthy phase-tree run.
 *
 * Fix: extract the "any non-terminal child?" predicate into a pure
 * helper `anyInFlightChild` and make `team-manager.ts::shouldSkipNudge`
 * consult it. A team-lead with at least one in-flight child skips the
 * nudge entirely.
 *
 * See:
 *   - src/server/agent/team-manager-helpers.ts::anyInFlightChild
 *   - src/server/agent/team-manager.ts::shouldSkipNudge / hasInFlightChildren
 *   - PR #409 live integration test — team-lead-317cdb83 consolidated bug report
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { anyInFlightChild, type InFlightCandidateGoal } from "../src/server/agent/team-manager-helpers.ts";

const PARENT = "parent-1";

function goal(partial: Partial<InFlightCandidateGoal> & { parentGoalId?: string }): InFlightCandidateGoal {
	return {
		parentGoalId: partial.parentGoalId,
		archived: partial.archived ?? false,
		state: partial.state ?? "in-progress",
	};
}

describe("anyInFlightChild", () => {
	it("returns false on an empty goal list", () => {
		assert.equal(anyInFlightChild(PARENT, []), false);
	});

	it("returns true when at least one immediate child is in-progress", () => {
		const goals = [goal({ parentGoalId: PARENT, state: "in-progress" })];
		assert.equal(anyInFlightChild(PARENT, goals), true);
	});

	it("returns true when the only child is in `todo` state (still in flight)", () => {
		const goals = [goal({ parentGoalId: PARENT, state: "todo" })];
		assert.equal(anyInFlightChild(PARENT, goals), true);
	});

	it("returns false when all children are `complete`", () => {
		const goals = [
			goal({ parentGoalId: PARENT, state: "complete" }),
			goal({ parentGoalId: PARENT, state: "complete" }),
		];
		assert.equal(anyInFlightChild(PARENT, goals), false);
	});

	it("returns false when all children are `shelved`", () => {
		const goals = [goal({ parentGoalId: PARENT, state: "shelved" })];
		assert.equal(anyInFlightChild(PARENT, goals), false);
	});

	it("ignores archived children even when they appear non-terminal", () => {
		const goals = [goal({ parentGoalId: PARENT, state: "in-progress", archived: true })];
		assert.equal(anyInFlightChild(PARENT, goals), false);
	});

	it("ignores children of OTHER parents", () => {
		const goals = [goal({ parentGoalId: "different-parent", state: "in-progress" })];
		assert.equal(anyInFlightChild(PARENT, goals), false);
	});

	it("returns true when one child is in-flight and a sibling is complete", () => {
		// Mixed-progress phase tree — the headline case from the live test.
		const goals = [
			goal({ parentGoalId: PARENT, state: "complete" }),
			goal({ parentGoalId: PARENT, state: "in-progress" }),
			goal({ parentGoalId: PARENT, state: "todo" }),
		];
		assert.equal(anyInFlightChild(PARENT, goals), true);
	});

	it("treats undefined `state` as in-flight (defensive default)", () => {
		// Defensive: a goal without an explicit state shouldn't accidentally
		// trip the nudge — we'd rather over-suppress than fire spuriously.
		const goals: InFlightCandidateGoal[] = [{ parentGoalId: PARENT }];
		assert.equal(anyInFlightChild(PARENT, goals), true);
	});

	it("treats unknown future states as in-flight", () => {
		// If a future state name is added (e.g. "paused"), the predicate
		// should suppress the nudge until we explicitly classify it. Listed
		// terminals are an allowlist, not a denylist.
		const goals: InFlightCandidateGoal[] = [{ parentGoalId: PARENT, state: "paused" }];
		assert.equal(anyInFlightChild(PARENT, goals), true);
	});

	it("ignores transitive descendants — only IMMEDIATE children count", () => {
		// A grandchild's progress doesn't satisfy the parent's nudge gate.
		// Each level of the tree manages its own idle policy.
		const goals: InFlightCandidateGoal[] = [
			{ parentGoalId: PARENT, state: "complete", archived: false },
			{ parentGoalId: "some-child", state: "in-progress", archived: false }, // grandchild of PARENT
		];
		assert.equal(anyInFlightChild(PARENT, goals), false);
	});
});
