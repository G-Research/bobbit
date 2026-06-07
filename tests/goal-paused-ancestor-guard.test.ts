/**
 * Finding 1 — `requireAncestorsNotPaused` walks the parentGoalId ancestor
 * chain and throws `GoalPausedError(<first paused id>)` if the goal itself OR
 * any ancestor is paused. Backs the `POST /api/goals` child-creation guard
 * (a paused parent — or grandparent — must block a new descendant), closing
 * the bypass where that path validated parent existence + nesting only, then
 * created/auto-started the child regardless of pause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requireAncestorsNotPaused, GoalPausedError } from "../src/server/agent/goal-paused-guard.ts";

interface G { id: string; paused?: boolean; parentGoalId?: string; }

function lookupOf(goals: G[]): (id: string) => G | undefined {
	const m = new Map(goals.map(g => [g.id, g]));
	return (id) => m.get(id);
}

describe("requireAncestorsNotPaused", () => {
	it("no-op when neither the goal nor any ancestor is paused", () => {
		const lookup = lookupOf([
			{ id: "root" },
			{ id: "mid", parentGoalId: "root" },
			{ id: "leaf", parentGoalId: "mid" },
		]);
		assert.doesNotThrow(() => requireAncestorsNotPaused("leaf", lookup));
	});

	it("throws when the direct parent is paused", () => {
		const lookup = lookupOf([
			{ id: "root" },
			{ id: "parent", parentGoalId: "root", paused: true },
		]);
		assert.throws(() => requireAncestorsNotPaused("parent", lookup), (err: unknown) => {
			assert.ok(err instanceof GoalPausedError);
			assert.equal((err as GoalPausedError).goalId, "parent");
			assert.equal((err as GoalPausedError).code, "GOAL_PAUSED");
			assert.equal((err as GoalPausedError).status, 409);
			return true;
		});
	});

	it("throws with the paused ANCESTOR's id when a grandparent is paused", () => {
		const lookup = lookupOf([
			{ id: "root", paused: true },
			{ id: "mid", parentGoalId: "root" },
			{ id: "leaf", parentGoalId: "mid" },
		]);
		assert.throws(() => requireAncestorsNotPaused("leaf", lookup), (err: unknown) => {
			assert.ok(err instanceof GoalPausedError);
			assert.equal((err as GoalPausedError).goalId, "root", "reports the paused ancestor, not the leaf");
			return true;
		});
	});

	it("a missing goal terminates the walk without throwing", () => {
		const lookup = lookupOf([{ id: "orphan", parentGoalId: "gone" }]);
		assert.doesNotThrow(() => requireAncestorsNotPaused("orphan", lookup));
	});

	it("a cyclic parent chain is cycle-guarded (no infinite loop)", () => {
		const lookup = lookupOf([
			{ id: "a", parentGoalId: "b" },
			{ id: "b", parentGoalId: "a" },
		]);
		assert.doesNotThrow(() => requireAncestorsNotPaused("a", lookup));
	});

	it("a cyclic chain still detects a paused node before looping out", () => {
		const lookup = lookupOf([
			{ id: "a", parentGoalId: "b" },
			{ id: "b", parentGoalId: "a", paused: true },
		]);
		assert.throws(() => requireAncestorsNotPaused("a", lookup), GoalPausedError);
	});
});
