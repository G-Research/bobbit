/**
 * Phase 3 — Plan freeze on `goal-plan` signal.
 *
 * SUBGOALS-SPEC §3.6: when the team-lead signals goal-plan on a parent-
 * workflow goal, execution.verify[] becomes frozen. Stamp surfaces as
 * `gate.metadata.frozen = "true"` on the per-goal workflow snapshot so the
 * mutation classifier (Phase 4) can read it.
 *
 * Tests the pure helper directly. The server.ts gate-signal route delegates
 * to `computePlanFreezeUpdate` and persists via `goalStore.update`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { Workflow } from "../src/server/agent/workflow-store.ts";
import { computePlanFreezeUpdate } from "../src/server/agent/parent-workflow-freeze.ts";
import { buildParentWorkflow } from "../src/server/state-migration/seed-default-workflows.ts";

function parentGoal(over: Partial<PersistedGoal> = {}): PersistedGoal {
	const seeded = buildParentWorkflow();
	const wf: Workflow = {
		id: "parent",
		name: "Parent",
		description: "",
		gates: seeded.gates.map(g => ({
			id: g.id,
			name: g.name,
			dependsOn: g.depends_on ?? [],
			content: g.content,
			manual: g.manual,
			verify: (g.verify ?? []).map(v => ({
				name: v.name,
				type: v.type,
				prompt: v.prompt,
				role: v.role,
			})),
		})),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	// Sample populated execution.verify[] to ensure freeze touches metadata
	// without disturbing existing verify steps.
	const execGate = wf.gates.find(g => g.id === "execution");
	if (execGate) {
		execGate.verify = [
			{
				name: "Phase 1 leaf",
				type: "subgoal",
				subgoal: { planId: "phase-1-leaf-a", title: "v0.1", spec: "" },
			} as any,
		];
	}
	return {
		id: "g-1",
		title: "Parent goal",
		cwd: "/tmp",
		state: "in-progress",
		spec: "",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		workflowId: "parent",
		workflow: wf,
		...over,
	};
}

describe("computePlanFreezeUpdate", () => {
	it("freezes execution.verify[] when goal-plan is signaled on a parent-workflow goal", () => {
		const goal = parentGoal();
		const result = computePlanFreezeUpdate(goal, "goal-plan");
		assert.equal(result.freeze, true, "must trigger freeze");
		assert.ok(result.workflow);
		const exec = result.workflow!.gates.find(g => g.id === "execution");
		assert.ok(exec, "execution gate must be present in updated snapshot");
		assert.equal(exec!.metadata?.frozen, "true", "execution.metadata.frozen must be 'true'");
		// Original verify[] is preserved.
		assert.equal(exec!.verify?.length, 1, "verify[] preserved across freeze");
		assert.equal(exec!.verify?.[0].name, "Phase 1 leaf");
	});

	it("does NOT freeze when gateId is not goal-plan", () => {
		const goal = parentGoal();
		for (const gid of ["charter", "plan-review", "execution", "integration", "ready-to-merge"]) {
			const r = computePlanFreezeUpdate(goal, gid);
			assert.equal(r.freeze, false, `gateId=${gid} must not trigger freeze`);
			assert.equal(r.workflow, undefined);
		}
	});

	it("does NOT freeze when workflowId is not 'parent'", () => {
		const goal = parentGoal({ workflowId: "feature" });
		const r = computePlanFreezeUpdate(goal, "goal-plan");
		assert.equal(r.freeze, false);
	});

	it("does NOT freeze when goal has no workflow snapshot", () => {
		const goal = parentGoal({ workflow: undefined as any });
		const r = computePlanFreezeUpdate(goal, "goal-plan");
		assert.equal(r.freeze, false);
	});

	it("returns freeze=false when execution gate is missing from the snapshot (defensive)", () => {
		const goal = parentGoal();
		// Hand-craft a parent-workflow snapshot without an execution gate.
		goal.workflow = {
			...goal.workflow!,
			gates: goal.workflow!.gates.filter(g => g.id !== "execution"),
		};
		const r = computePlanFreezeUpdate(goal, "goal-plan");
		assert.equal(r.freeze, false);
	});

	it("idempotent: re-signalling goal-plan with already-frozen execution still returns freeze=true (caller handles dedupe)", () => {
		const goal = parentGoal();
		// First freeze.
		const r1 = computePlanFreezeUpdate(goal, "goal-plan");
		goal.workflow = r1.workflow!;
		// Second freeze (already metadata.frozen=true).
		const r2 = computePlanFreezeUpdate(goal, "goal-plan");
		assert.equal(r2.freeze, true);
		const exec = r2.workflow!.gates.find(g => g.id === "execution");
		assert.equal(exec!.metadata?.frozen, "true");
	});

	it("preserves other gates' verify[] and metadata across the update", () => {
		const goal = parentGoal();
		const beforeCharter = goal.workflow!.gates.find(g => g.id === "charter");
		const r = computePlanFreezeUpdate(goal, "goal-plan");
		const afterCharter = r.workflow!.gates.find(g => g.id === "charter");
		assert.deepEqual(afterCharter, beforeCharter, "charter gate must be unchanged");
	});
});
