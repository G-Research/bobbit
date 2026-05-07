/**
 * paused-children-not-in-flight rule — Paused children must NOT suppress the parent's idle nudge.
 *
 * `anyInFlightChild(parentGoalId, goals)` returns true iff any child of
 * `parentGoalId` is non-archived, state=in-progress, AND not paused. The
 * paused exclusion is the load-bearing rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anyInFlightChild } from "../src/server/agent/team-manager-helpers.js";
import type { PersistedGoal } from "../src/server/agent/goal-store.js";

function makeGoal(overrides: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	return {
		title: `Goal ${overrides.id}`,
		cwd: "/tmp/test",
		state: "in-progress",
		spec: "spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		setupStatus: "ready",
		...overrides,
	};
}

describe("anyInFlightChild — paused-children-not-in-flight rule", () => {
	it("returns false when there are no children at all", () => {
		const goals = [makeGoal({ id: "parent-1" })];
		assert.equal(anyInFlightChild("parent-1", goals), false);
	});

	it("returns true when a single non-paused in-progress child exists", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-1", parentGoalId: "parent-1" } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), true);
	});

	it("returns false when the only child is paused", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-1", parentGoalId: "parent-1", paused: true } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), false,
			"paused child must NOT count as in-flight (parent must be allowed to nudge / act)");
	});

	it("returns true when one sibling is paused but another is active (mixed-progress)", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-paused", parentGoalId: "parent-1", paused: true } as any),
			makeGoal({ id: "child-active", parentGoalId: "parent-1" } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), true,
			"mixed paused+active means at least one sibling is making progress — parent IS still in-flight");
	});

	it("ignores archived children", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-1", parentGoalId: "parent-1", archived: true } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), false);
	});

	it("ignores children in non-in-progress states (todo / complete / shelved)", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "todo", parentGoalId: "parent-1", state: "todo" } as any),
			makeGoal({ id: "complete", parentGoalId: "parent-1", state: "complete" } as any),
			makeGoal({ id: "shelved", parentGoalId: "parent-1", state: "shelved" } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), false);
	});

	it("ignores grandchildren (only direct children count)", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-1", parentGoalId: "parent-1" } as any),
			// Grandchild — parentGoalId is the child, not the root.
			makeGoal({ id: "grandchild-1", parentGoalId: "child-1" } as any),
		];
		// Direct child is in-flight, so the parent IS in-flight regardless of
		// the grandchild's state.
		assert.equal(anyInFlightChild("parent-1", goals), true);
		// But for the grandchild's grandparent (a non-existent edge), no
		// direct children exist.
		assert.equal(anyInFlightChild("does-not-exist", goals), false);
	});

	it("does NOT count the parent goal itself when it appears in the list", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			// Hypothetical pathological self-reference — defensively excluded.
			makeGoal({ id: "parent-1", parentGoalId: "parent-1" } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), false,
			"parent must not be counted as its own in-flight child");
	});

	it("a child paused via `paused: false` (explicit false) still counts as in-flight", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			makeGoal({ id: "child-1", parentGoalId: "parent-1", paused: false } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), true);
	});

	it("treats a missing `paused` field as not paused (back-compat)", () => {
		const goals = [
			makeGoal({ id: "parent-1" }),
			// No `paused` field at all — the field is optional.
			makeGoal({ id: "child-1", parentGoalId: "parent-1" } as any),
		];
		assert.equal(anyInFlightChild("parent-1", goals), true);
	});
});
