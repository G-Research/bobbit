/**
 * Unit tests for plan-synthesis dedupe-by-planId (bug fix).
 *
 * Pins: when multiple child goals share `spawnedFromPlanId` (e.g. archive
 * + unarchive/re-spawn), `buildPlanSteps` must emit ONE PlanStep per
 * unique planId. The winner is picked by the canonical tier resolver in
 * `plan-node-state.ts::resolvePlanNodeChild`:
 *   1. live + in-progress + !paused
 *   2. archived + complete
 *   3. live + other
 *   4. archived + non-complete
 *
 * Applies to BOTH paths:
 *   - Living-plan path (no formalSteps)
 *   - Formal-plan path (formalSteps provided)
 *
 * Synth fallback (`synth:<id>`) is per-child and must NOT collapse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildPlanSteps,
	type FormalPlanStep,
	type SynthesisGoal,
} from "../src/app/plan-synthesis.ts";

function child(over: Partial<SynthesisGoal> & { id: string; createdAt: number }): SynthesisGoal {
	return {
		id: over.id,
		parentGoalId: over.parentGoalId ?? "root",
		spawnedFromPlanId: over.spawnedFromPlanId,
		createdAt: over.createdAt,
		state: over.state ?? "todo",
		archived: over.archived,
		paused: over.paused,
		title: over.title ?? `Child ${over.id}`,
		workflowId: over.workflowId,
		dependsOnPlanIds: over.dependsOnPlanIds,
	};
}

describe("plan-synthesis — dedupe by planId (living-plan)", () => {
	it("4 children sharing planId 'p1' collapse to ONE row; live in-progress wins", () => {
		const archivedComplete = child({ id: "a", createdAt: 100, spawnedFromPlanId: "p1", state: "complete", archived: true, title: "archived-complete" });
		const archivedShelved = child({ id: "b", createdAt: 200, spawnedFromPlanId: "p1", state: "shelved", archived: true, title: "archived-shelved" });
		const liveInProgress = child({ id: "c", createdAt: 300, spawnedFromPlanId: "p1", state: "in-progress", title: "live-in-progress" });
		const liveTodo = child({ id: "d", createdAt: 400, spawnedFromPlanId: "p1", state: "todo", title: "live-todo" });
		const steps = buildPlanSteps({
			childGoals: [archivedComplete, archivedShelved, liveInProgress, liveTodo],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].planId, "p1");
		// Tier 1 winner: live + in-progress + !paused
		assert.equal(steps[0].childGoalId, "c");
		assert.equal(steps[0].title, "live-in-progress");
	});

	it("archived-complete wins over live-todo when no live in-progress exists (tier 2 > tier 3)", () => {
		const archivedComplete = child({ id: "a", createdAt: 100, spawnedFromPlanId: "p1", state: "complete", archived: true });
		const liveTodo = child({ id: "b", createdAt: 200, spawnedFromPlanId: "p1", state: "todo" });
		const steps = buildPlanSteps({ childGoals: [archivedComplete, liveTodo] });
		assert.equal(steps.length, 1);
		assert.equal(steps[0].childGoalId, "a");
	});

	it("paused live in-progress falls to tier 3 (loses to archived complete)", () => {
		const archivedComplete = child({ id: "a", createdAt: 100, spawnedFromPlanId: "p1", state: "complete", archived: true });
		const livePausedInProgress = child({ id: "b", createdAt: 200, spawnedFromPlanId: "p1", state: "in-progress", paused: true });
		const steps = buildPlanSteps({ childGoals: [archivedComplete, livePausedInProgress] });
		assert.equal(steps.length, 1);
		assert.equal(steps[0].childGoalId, "a");
	});

	it("orphan children (no spawnedFromPlanId) get unique synth:<id> rows (NOT collapsed)", () => {
		const orphanA = child({ id: "a", createdAt: 100 });
		const orphanB = child({ id: "b", createdAt: 200 });
		const steps = buildPlanSteps({ childGoals: [orphanA, orphanB] });
		assert.equal(steps.length, 2);
		assert.deepEqual(steps.map(s => s.planId).sort(), ["synth:a", "synth:b"]);
	});

	it("dependsOn from winner's row carries through (not the loser's)", () => {
		const loser = child({ id: "a", createdAt: 100, spawnedFromPlanId: "p2", state: "complete", archived: true, dependsOnPlanIds: ["LEGACY"] });
		const winner = child({ id: "b", createdAt: 200, spawnedFromPlanId: "p2", state: "in-progress", dependsOnPlanIds: ["p1"] });
		const root = child({ id: "r", createdAt: 50, spawnedFromPlanId: "p1", state: "complete" });
		const steps = buildPlanSteps({ childGoals: [root, loser, winner] });
		const p2 = steps.find(s => s.planId === "p2")!;
		assert.equal(p2.childGoalId, "b");
		assert.deepEqual(p2.dependsOn, ["p1"]);
	});
});

describe("plan-synthesis — dedupe by planId (formal-plan)", () => {
	it("formal step 'p1' with 4 sharing children → single row, tier-1 winner", () => {
		const formal: FormalPlanStep[] = [{ planId: "p1", title: "P1" }];
		const archivedComplete = child({ id: "a", createdAt: 100, spawnedFromPlanId: "p1", state: "complete", archived: true });
		const archivedShelved = child({ id: "b", createdAt: 200, spawnedFromPlanId: "p1", state: "shelved", archived: true });
		const liveInProgress = child({ id: "c", createdAt: 300, spawnedFromPlanId: "p1", state: "in-progress" });
		const liveTodo = child({ id: "d", createdAt: 400, spawnedFromPlanId: "p1", state: "todo" });
		const steps = buildPlanSteps({
			formalSteps: formal,
			childGoals: [archivedComplete, archivedShelved, liveInProgress, liveTodo],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].planId, "p1");
		assert.equal(steps[0].childGoalId, "c");
		assert.equal(steps[0].title, "P1"); // title comes from the formal step, not the child
	});
});
