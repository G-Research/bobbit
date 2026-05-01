/**
 * Pinned regression: pre-freeze child goals spawned via
 * `goal_spawn_child(workflowId, planId)` were structurally orphaned
 * from their planStep counterparts in the parent's frozen execution
 * gate.
 *
 * Symptom (from agent-memory v0.1-foundation team-lead, PR #409
 * integration test):
 *   1. team-lead spawned domain-and-ports child via
 *      `goal_spawn_child({ planId: "v0.1-domain-and-ports", ... })`
 *      BEFORE freezing the plan.
 *   2. Later signalled goal-plan with the planStep
 *      `{ planId: "v0.1-domain-and-ports", ... }` in execution.verify[].
 *   3. Child completed all gates including ready-to-merge.
 *   4. `goal_plan_status` returned the planSteps with `child: undefined`
 *      on the matching step \u2014 the linkage was lost.
 *   5. Phase 2 children (which depend on Phase 1 merging) never
 *      auto-spawned because the harness couldn't see Phase 1 was done.
 *
 * Fix: persist `spawnedFromPlanId` on the child goal record at
 * spawn-time, then have GET /api/goals/:id/plan look up children by
 * `(parentGoalId, spawnedFromPlanId)` as a fallback when the gate
 * signal record's `subgoal.childGoalId` linkage hasn't been populated
 * yet (which it won't be, when execution-gate has never been run).
 *
 * The harness's `runSubgoalStep` idempotency check now uses the same
 * fallback so a frozen plan's execution gate, on first run, re-binds
 * to pre-freeze children instead of spawning duplicates.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

let stateDir: string;

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawned-from-plan-"));
});

function makeGoal(overrides: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	return {
		id: overrides.id,
		title: overrides.title ?? `goal-${overrides.id}`,
		cwd: overrides.cwd ?? "/tmp/g",
		state: overrides.state ?? "in-progress",
		spec: overrides.spec ?? "",
		createdAt: overrides.createdAt ?? Date.now(),
		updatedAt: overrides.updatedAt ?? Date.now(),
		setupStatus: "ready",
		rootGoalId: overrides.rootGoalId ?? overrides.id,
		mergeTarget: "master",
		...overrides,
	} as PersistedGoal;
}

describe("PersistedGoal.spawnedFromPlanId", () => {
	it("persists across put / get on the GoalStore", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({
			id: "child-1",
			parentGoalId: "parent-1",
			rootGoalId: "parent-1",
			mergeTarget: "parent",
			spawnedFromPlanId: "phase-1-foo",
		}));

		const reloaded = store.get("child-1");
		assert.equal(reloaded?.spawnedFromPlanId, "phase-1-foo");
	});

	it("survives serialise/deserialise across a fresh store instance", () => {
		{
			const store = new GoalStore(stateDir);
			store.put(makeGoal({
				id: "child-1",
				parentGoalId: "parent-1",
				rootGoalId: "parent-1",
				mergeTarget: "parent",
				spawnedFromPlanId: "phase-1-foo",
			}));
		}
		// Second store reads from disk.
		const reloaded = new GoalStore(stateDir);
		assert.equal(reloaded.get("child-1")?.spawnedFromPlanId, "phase-1-foo");
	});

	it("update() can backfill spawnedFromPlanId on an existing goal record", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({
			id: "child-1",
			parentGoalId: "parent-1",
			rootGoalId: "parent-1",
			mergeTarget: "parent",
		}));
		assert.equal(store.get("child-1")?.spawnedFromPlanId, undefined);

		const ok = store.update("child-1", { spawnedFromPlanId: "phase-1-foo" });
		assert.equal(ok, true);
		assert.equal(store.get("child-1")?.spawnedFromPlanId, "phase-1-foo");
	});

	it("standalone children spawned without a planId leave the field undefined", () => {
		// Ad-hoc decomposition (not part of a frozen plan) shouldn't
		// fabricate a synthetic planId on the child record.
		const store = new GoalStore(stateDir);
		store.put(makeGoal({
			id: "ad-hoc-child",
			parentGoalId: "parent-1",
			rootGoalId: "parent-1",
			mergeTarget: "parent",
			// no spawnedFromPlanId
		}));
		assert.equal(store.get("ad-hoc-child")?.spawnedFromPlanId, undefined);
	});

	it("multiple children with distinct planIds coexist on the same parent", () => {
		const store = new GoalStore(stateDir);
		const planIds = ["phase-1-a", "phase-1-b", "phase-2-c"];
		for (let i = 0; i < planIds.length; i++) {
			store.put(makeGoal({
				id: `child-${i}`,
				parentGoalId: "parent-1",
				rootGoalId: "parent-1",
				mergeTarget: "parent",
				spawnedFromPlanId: planIds[i],
			}));
		}

		const children = store.getAll().filter(g => g.parentGoalId === "parent-1");
		assert.equal(children.length, 3);
		const byPlan = new Map(children.map(c => [c.spawnedFromPlanId, c.id]));
		assert.equal(byPlan.get("phase-1-a"), "child-0");
		assert.equal(byPlan.get("phase-1-b"), "child-1");
		assert.equal(byPlan.get("phase-2-c"), "child-2");
	});
});

describe("planStep.child fallback lookup by spawnedFromPlanId", () => {
	// This describes the lookup logic in
	// `server.ts::GET /api/goals/:id/plan` and
	// `verification-harness.ts::runSubgoalStep` step (1c).
	//
	// We test the lookup as a pure function over the goalStore's `getAll()`
	// output, mirroring the production filter (parentGoalId match,
	// non-archived, spawnedFromPlanId match).
	function findChildByPlanId(
		parentId: string,
		planId: string,
		goals: PersistedGoal[],
	): PersistedGoal | undefined {
		for (const g of goals) {
			if (g.parentGoalId !== parentId) continue;
			if (g.archived) continue;
			if (g.spawnedFromPlanId !== planId) continue;
			return g;
		}
		return undefined;
	}

	it("matches a non-archived child whose spawnedFromPlanId equals the planStep planId", () => {
		const goals = [
			makeGoal({ id: "p", rootGoalId: "p" }),
			makeGoal({
				id: "c1",
				parentGoalId: "p",
				rootGoalId: "p",
				mergeTarget: "parent",
				spawnedFromPlanId: "phase-1-foo",
			}),
		];
		const found = findChildByPlanId("p", "phase-1-foo", goals);
		assert.equal(found?.id, "c1");
	});

	it("returns undefined when no child has the matching planId", () => {
		const goals = [
			makeGoal({
				id: "c1",
				parentGoalId: "p",
				spawnedFromPlanId: "phase-1-other",
			}),
		];
		assert.equal(findChildByPlanId("p", "phase-1-foo", goals), undefined);
	});

	it("ignores children of OTHER parents", () => {
		const goals = [
			makeGoal({
				id: "c1",
				parentGoalId: "different-parent",
				spawnedFromPlanId: "phase-1-foo",
			}),
		];
		assert.equal(findChildByPlanId("p", "phase-1-foo", goals), undefined);
	});

	it("ignores ARCHIVED children even with matching planId", () => {
		// Defensive: an archived (cancelled) child shouldn't pin a planStep.
		const goals = [
			makeGoal({
				id: "c1",
				parentGoalId: "p",
				archived: true,
				spawnedFromPlanId: "phase-1-foo",
			}),
		];
		assert.equal(findChildByPlanId("p", "phase-1-foo", goals), undefined);
	});

	it("ignores children with no spawnedFromPlanId (ad-hoc decomposition)", () => {
		const goals = [
			makeGoal({
				id: "ad-hoc",
				parentGoalId: "p",
				// no spawnedFromPlanId
			}),
		];
		assert.equal(findChildByPlanId("p", "phase-1-foo", goals), undefined);
	});
});
