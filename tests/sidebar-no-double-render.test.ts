/**
 * Pure unit tests for `computeSpawnedClaim` — the deterministic
 * claim/exclude pair that prevents the sidebar from rendering a goal in
 * two places simultaneously.
 *
 * Path A (`renderGoalGroup` → `renderTeamGroup` in render-helpers.ts)
 * emits spawned children under their team-lead. Path B
 * (`buildNestedGoalForest`) emits goals at the project root / under
 * their parent in the nested forest. `computeSpawnedClaim` returns the
 * exact id-set Path A will claim, so Path B can subtract it.
 *
 * Cases pinned here mirror the design doc — including the live "Justin
 * Time" repro (terminated team-lead retained in liveSessions still
 * claims its children in Path A; Path B's old heuristic missed this).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeSpawnedClaim,
	selectSpawnedChildren,
	type SpawnedChildLike,
	type SessionLike,
} from "../src/app/sidebar-spawned-children.ts";

interface TestGoal extends SpawnedChildLike {
	id: string;
}

function g(over: Partial<TestGoal> & { id: string }): TestGoal {
	return {
		parentGoalId: undefined,
		spawnedBySessionId: undefined,
		archived: false,
		createdAt: 0,
		...over,
	};
}

function s(over: Partial<SessionLike> & { id: string }): SessionLike {
	return { ...over };
}

describe("computeSpawnedClaim — deterministic dedup of Path A vs Path B", () => {
	it("(1) live spawned child with stamped spawnedBySessionId is claimed", () => {
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2 }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", goalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("C"), "spawned child should be claimed by Path A");
		assert.equal(claim.size, 1);
	});

	it("(2) live unstamped child claimed via parent-lead fallback", () => {
		const goals = [
			g({ id: "P", createdAt: 1 }),
			// No spawnedBySessionId — claimed via parent-lead strict-attribution.
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 2 }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", teamGoalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("C"), "unstamped child should be claimed via parent-lead fallback");
	});

	it("(3) archived spawned child claimed when showArchived=true", () => {
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2, archived: true }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", goalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], true);
		assert.ok(claim.has("C"), "archived child should be claimed when showArchived=true");
	});

	it("(4) archived child not in input ⇒ not claimed (and won't render in forest either)", () => {
		// When showArchived=false, the archived goal is excluded from the
		// goals-for-forest pool upstream. computeSpawnedClaim respects this
		// via selectSpawnedChildren's archived filter.
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2, archived: true }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", goalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(!claim.has("C"), "archived child should NOT be claimed when showArchived=false");
	});

	it("(5) terminated team-lead still claims its children — status-agnostic (Justin Time repro)", () => {
		// The user's exact repro: a stale team-lead session retained in
		// gatewaySessions but with status="terminated". Path A's
		// `goalSessions.find(s => s.role === "team-lead")` doesn't filter
		// on status, so it still claims the children. The OLD heuristic
		// dedup excluded terminated sessions from teamLeadIdsAttributable
		// and leaked the children into the forest.
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2 }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", status: "terminated", goalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("C"), "child of terminated-but-listed team-lead must still be claimed");
	});

	it("(6) grandchild: TL_A→G_A; G_A→G_B (TL_B); G_B→G_C — both G_B and G_C claimed by their own parent's lead", () => {
		const goals = [
			g({ id: "G_A", createdAt: 1 }),
			g({ id: "G_B", parentGoalId: "G_A", spawnedBySessionId: "TL_A", createdAt: 2 }),
			g({ id: "G_C", parentGoalId: "G_B", spawnedBySessionId: "TL_B", createdAt: 3 }),
		];
		const live = [
			s({ id: "TL_A", role: "team-lead", goalId: "G_A" }),
			s({ id: "TL_B", role: "team-lead", goalId: "G_B" }),
		];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("G_B"), "G_B claimed by TL_A");
		assert.ok(claim.has("G_C"), "G_C claimed by TL_B");
		assert.ok(!claim.has("G_A"), "root goal G_A is not a spawned child of anything in the input pool");
	});

	it("(7) spawned child with no team-lead anywhere ⇒ not claimed (renders top-level via forest)", () => {
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_GONE", createdAt: 2 }),
		];
		// TL_GONE not in liveSessions or archivedSessions — Path A can't
		// render it, so Path B is the fallback and must NOT exclude it.
		const claim = computeSpawnedClaim(goals, [], [], false);
		assert.ok(!claim.has("C"), "child with no surviving lead should fall back to forest render");
	});

	it("(8) sibling goal of unrelated parent ⇒ not claimed", () => {
		const goals = [
			g({ id: "P1", createdAt: 1 }),
			g({ id: "P2", createdAt: 2 }),
			g({ id: "S", parentGoalId: "P2", spawnedBySessionId: "TL_P2", createdAt: 3 }),
		];
		const live = [
			s({ id: "TL_P1", role: "team-lead", goalId: "P1" }),
			s({ id: "TL_P2", role: "team-lead", goalId: "P2" }),
		];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("S"), "S claimed by P2's lead");
		assert.ok(!claim.has("P1"));
		assert.ok(!claim.has("P2"));
	});

	it("archived team-lead claims archived spawned children when showArchived=true", () => {
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_ARC", createdAt: 2, archived: true }),
		];
		const live: SessionLike[] = [];
		const archived = [s({ id: "TL_ARC", role: "team-lead", teamGoalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, archived, true);
		assert.ok(claim.has("C"));
	});

	it("regression: claim set is a deterministic upper bound on Path A's emission for every (parent, lead) tuple", () => {
		// For any (parent, lead) tuple the renderer evaluates,
		// selectSpawnedChildren(...) ⊆ computeSpawnedClaim(...).
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C1", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2 }),
			g({ id: "C2", parentGoalId: "P", spawnedBySessionId: undefined, createdAt: 3 }),
			g({ id: "C3", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 4, archived: true }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", goalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], true);
		const aEmits = selectSpawnedChildren(goals, "P", "TL_P", true, "TL_P");
		for (const c of aEmits) {
			assert.ok(claim.has(c.id), `Path A emits ${c.id} but claim set lacks it`);
		}
	});

	it("teamGoalId is honoured as a parent-pointer alongside goalId", () => {
		// render-helpers' goalSessions filter accepts (s.goalId === goal.id || s.teamGoalId === goal.id).
		// Mirror that here.
		const goals = [
			g({ id: "P", createdAt: 1 }),
			g({ id: "C", parentGoalId: "P", spawnedBySessionId: "TL_P", createdAt: 2 }),
		];
		const live = [s({ id: "TL_P", role: "team-lead", teamGoalId: "P" })];
		const claim = computeSpawnedClaim(goals, live, [], false);
		assert.ok(claim.has("C"));
	});
});
