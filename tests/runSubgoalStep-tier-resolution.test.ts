/**
 * Phase 3 / Lesson 4.19 — `resolvePlanStepChild` tier preference.
 *
 * SUBGOALS-SPEC §4.19: success-aware tier preference.
 *   1. Live in-progress
 *   1.5 Cached pointer (resolved tier-1 / tier-2)
 *   2. Archived + state=complete  (success terminal)
 *   3. Live other (todo / paused)
 *   4. Archived + non-complete (shelved dupe — invalidated)
 *   5. Rescue: parentGoalId+title match for goals with undefined planId.
 *      On hit, planId is back-filled.
 *
 * Tie-break within a tier: most recent createdAt.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("resolvePlanStepChild — tier preference (Lesson 4.19)", () => {
	it("Tier 1: live in-progress wins over archived complete and live todo", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p1";
		// Tier 2 candidate (archived + complete, older)
		const archived = fx.goalStore.put({
			id: "tier2", title: "T2", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);
		// Tier 1 candidate (live + in-progress, newer)
		fx.goalStore.put({
			id: "tier1", title: "T1", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);
		// Tier 3 candidate (live + todo)
		fx.goalStore.put({
			id: "tier3", title: "T3", cwd: fx.tmpRoot,
			state: "todo", spec: "", createdAt: 10, updatedAt: 10,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "live-active", `expected live-active, got ${r.source}`);
		assert.equal(r.child?.id, "tier1");
		void archived;
	});

	it("Tier 2: archived+complete returns success terminal (passed=true) when no live in-progress exists", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p1";
		fx.goalStore.put({
			id: "complete-1", title: "Done", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);

		const step = buildSubgoalStep({ planId, title: "Done" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true, "archived+complete must short-circuit to passed=true");
		assert.match(result.output, /already complete/i);
		// And no spawn happened.
		assert.equal(fx.calls.find(c => c.kind === "createGoal"), undefined);
	});

	it("Tier 3: live other (todo) is preferred over archived non-complete", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p1";
		fx.goalStore.put({
			id: "shelved-old", title: "S", cwd: fx.tmpRoot,
			state: "shelved", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);
		fx.goalStore.put({
			id: "todo-live", title: "T", cwd: fx.tmpRoot,
			state: "todo", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.source, "live-other");
		assert.equal(r.child?.id, "todo-live");
	});

	it("Tier 4: archived non-complete invalidates → spawn fresh (Lesson 4.2)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "phase-2-stale";
		fx.goalStore.put({
			id: "stale", title: "Was a child", cwd: fx.tmpRoot,
			state: "shelved", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);

		const step = buildSubgoalStep({ planId, title: "Phase 2 spec" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true);
		// Spawn happened — there are now TWO children on disk: the original
		// archived+shelved one (left untouched), and the freshly spawned one
		// (which the fixture immediately merges + archives as complete).
		const matching = fx.goalStore.getAll().filter(g =>
			g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId,
		);
		assert.equal(matching.length, 2, `expected 2 children, got ${matching.length}`);
		const fresh = matching.find(g => g.id !== "stale");
		assert.ok(fresh, "fresh child must exist after invalidating archived non-complete");
		assert.equal(fresh!.state, "complete");
		// Original stranded one is untouched.
		const stale = fx.goalStore.get("stale");
		assert.equal(stale?.state, "shelved");
	});

	it("Tier 5 rescue: parentGoalId+title match on undefined planId → backfills spawnedFromPlanId", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "rescued-plan-id";
		const stranded = {
			id: "stranded", title: "Stranded by older code", cwd: fx.tmpRoot,
			state: "in-progress" as const, spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id,
			// spawnedFromPlanId intentionally undefined — this is a child stranded
			// by a pre-fix code path.
		};
		fx.goalStore.put(stranded as any);

		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId, {
			expectedTitle: "Stranded by older code",
		});
		assert.equal(r.source, "rescue");
		assert.equal(r.child?.id, "stranded");
		// Wait one tick for the async backfill update to flush.
		await new Promise(res => setImmediate(res));
		const reloaded = fx.goalStore.get("stranded");
		assert.equal(reloaded?.spawnedFromPlanId, planId, "rescue path must back-fill spawnedFromPlanId");
	});

	it("returns source='none' when no candidate matches", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		const r = fx.harness.resolvePlanStepChild(fx.parent.id, "no-such-plan");
		assert.equal(r.source, "none");
		assert.equal(r.child, undefined);
	});

	it("Tier 1 tie-break: most recent createdAt wins among multiple live in-progress siblings", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "tie";
		fx.goalStore.put({
			id: "older", title: "O", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);
		fx.goalStore.put({
			id: "newer", title: "N", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 100, updatedAt: 100,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId);
		assert.equal(r.child?.id, "newer");
	});
});
