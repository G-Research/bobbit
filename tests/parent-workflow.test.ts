/**
 * Tests for the `parent` builtin workflow + the `goal-plan` freeze hook.
 *
 * Covers (Phase 3 task 3.4 of nested goals — see
 * docs/design/nested-goals.md §6, §6.1, §14.4):
 *
 *   1. `buildDefaultWorkflows()` returns a `parent` workflow with the
 *      expected gate chain (charter → plan-review → goal-plan →
 *      execution → integration → ready-to-merge), a self-documenting
 *      top-level description, per-gate `description` strings, and the
 *      execution gate's verify[] starts EMPTY.
 *   2. The freeze-hook contract: stamping `metadata.frozen = "true"` on
 *      the goal's snapshotted execution gate is idempotent and lives on
 *      the persisted goal (NOT on the canonical builtin).
 *
 * The freeze logic itself lives inside the `gate_signal` block in
 * `server.ts`. Rather than booting the full HTTP gateway, this test
 * exercises the equivalent mutation against an isolated `GoalStore` —
 * the same shape the server-side block runs (find execution gate, stamp
 * metadata, persist via goalStore.update). A regression in the server
 * block would still fail the dedicated server-side e2e tests added in
 * later phases; this unit test guards the contract shape.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDefaultWorkflows } from "../src/server/state-migration/seed-default-workflows.ts";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { Workflow } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parent-workflow-test-"));
});

// ── 1. Workflow shape snapshot ─────────────────────────────────────────

describe("buildDefaultWorkflows() — `parent` workflow", () => {
	it("returns a `parent` entry with the expected metadata", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		assert.ok(wfs.parent, "parent workflow missing from defaults");
		assert.equal(wfs.parent.id, "parent");
		assert.equal(wfs.parent.name, "Parent Goal");
		// 3-5 sentence self-documenting description (§14.4).
		assert.ok(typeof wfs.parent.description === "string");
		assert.ok(
			(wfs.parent.description ?? "").length > 200,
			"description must be substantive (3-5 sentences)",
		);
		assert.match(wfs.parent.description!, /child subgoals/i);
		assert.match(wfs.parent.description!, /maxConcurrentChildren/);
		assert.match(wfs.parent.description!, /ready-to-merge/);
	});

	it("has the expected gate chain in order", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const ids = wfs.parent.gates.map(g => g.id);
		assert.deepEqual(ids, [
			"charter",
			"plan-review",
			"goal-plan",
			"execution",
			"integration",
			"ready-to-merge",
		]);
	});

	it("chains dependsOn correctly", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const byId = new Map(wfs.parent.gates.map(g => [g.id, g]));
		assert.deepEqual(byId.get("charter")!.depends_on ?? [], []);
		assert.deepEqual(byId.get("plan-review")!.depends_on, ["charter"]);
		assert.deepEqual(byId.get("goal-plan")!.depends_on, ["plan-review"]);
		assert.deepEqual(byId.get("execution")!.depends_on, ["goal-plan"]);
		assert.deepEqual(byId.get("integration")!.depends_on, ["execution"]);
		assert.deepEqual(
			byId.get("ready-to-merge")!.depends_on,
			["integration"],
			"parent has no documentation gate — ready-to-merge depends on integration",
		);
	});

	it("marks goal-plan as a manual gate with no verify steps", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const goalPlan = wfs.parent.gates.find(g => g.id === "goal-plan")!;
		assert.equal(goalPlan.manual, true);
		assert.ok(
			!goalPlan.verify || goalPlan.verify.length === 0,
			"goal-plan must have no verify[] (manual signal only)",
		);
	});

	it("starts execution.verify[] empty (populated later by goal_plan_propose)", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const exec = wfs.parent.gates.find(g => g.id === "execution")!;
		assert.deepEqual(exec.verify ?? [], []);
	});

	it("ships content+inject_downstream on charter and plan-review", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const charter = wfs.parent.gates.find(g => g.id === "charter")!;
		assert.equal(charter.content, true);
		assert.equal(charter.inject_downstream, true);
		const planReview = wfs.parent.gates.find(g => g.id === "plan-review")!;
		assert.equal(planReview.content, true);
		assert.equal(planReview.inject_downstream, true);
	});

	it("plan-review verify[] has DAG + completeness LLM reviews on different phases", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const planReview = wfs.parent.gates.find(g => g.id === "plan-review")!;
		const verify = planReview.verify!;
		assert.equal(verify.length, 2);
		const dag = verify.find(s => s.name === "DAG correctness")!;
		assert.equal(dag.type, "llm-review");
		assert.equal(dag.role, "architect");
		assert.match(dag.prompt!, /phase numbers form a valid DAG/);
		const completeness = verify.find(s => s.name === "Spec completeness")!;
		assert.equal(completeness.type, "llm-review");
		assert.equal(completeness.role, "spec-auditor");
		assert.equal(completeness.phase, 1);
		assert.match(completeness.prompt!, /acceptance criteria/i);
	});

	it("charter verify[] uses CHARTER_PROMPT shape", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const charter = wfs.parent.gates.find(g => g.id === "charter")!;
		const review = charter.verify![0];
		assert.equal(review.type, "llm-review");
		assert.equal(review.role, "architect");
		assert.match(review.prompt!, /3-7 acceptance criteria/);
		assert.match(review.prompt!, /natural decomposition/);
	});

	it("integration verify[] runs build/check/unit/e2e + code review", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		const integ = wfs.parent.gates.find(g => g.id === "integration")!;
		const names = (integ.verify ?? []).map(s => s.name);
		assert.deepEqual(names, [
			"Build",
			"Type check",
			"Unit tests",
			"E2E tests",
			"Code quality review",
		]);
	});

	it("attaches a non-empty description to every gate (§14.4)", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		for (const gate of wfs.parent.gates) {
			assert.ok(
				typeof gate.description === "string" && gate.description.length > 50,
				`gate ${gate.id} missing self-documenting description`,
			);
		}
	});

	it("does not regress the four pre-existing builtin workflows", () => {
		const wfs = buildDefaultWorkflows("bobbit");
		for (const id of ["general", "feature", "bug-fix", "quick-fix"]) {
			assert.ok(wfs[id], `builtin workflow "${id}" missing`);
		}
	});
});

// ── 2. Freeze hook contract on goal-plan signal ────────────────────────

/**
 * Helper that mirrors the inline freeze block from the gate_signal
 * accept path in server.ts. Stamps `metadata.frozen="true"` and
 * `frozenAt=<timestamp>` onto the goal's snapshotted execution gate.
 * Idempotent: a second call leaves the original `frozenAt` intact.
 */
function applyGoalPlanFreezeForTest(store: GoalStore, goalId: string): boolean {
	const goal = store.get(goalId);
	if (!goal || !goal.workflow) return false;
	const execGate = goal.workflow.gates.find(g => g.id === "execution");
	if (!execGate) return false;
	if (!execGate.metadata) execGate.metadata = {};
	if (execGate.metadata.frozen === "true") return true;
	execGate.metadata.frozen = "true";
	execGate.metadata.frozenAt = String(Date.now());
	store.update(goalId, { workflow: goal.workflow });
	return true;
}

function makeGoalWithParentWorkflow(): { store: GoalStore; goalId: string } {
	const store = new GoalStore(tmpRoot);
	const seeded = buildDefaultWorkflows("bobbit");
	// Convert the SeededWorkflow into a runtime Workflow snapshot. The
	// runtime `WorkflowGate.dependsOn` is camelCase; the seeded `depends_on`
	// is snake_case. Mirrors what `goal-manager.createGoal` does when it
	// snapshots a workflow.
	const snapshot: Workflow = {
		id: seeded.parent.id,
		name: seeded.parent.name,
		description: seeded.parent.description ?? "",
		createdAt: 0,
		updatedAt: 0,
		gates: seeded.parent.gates.map(g => ({
			id: g.id,
			name: g.name,
			dependsOn: g.depends_on ?? [],
			content: g.content,
			injectDownstream: g.inject_downstream,
			manual: g.manual,
			description: g.description,
			metadata: g.metadata,
			// SeededVerifyStep is structurally compatible with VerifyStep
			// for the fields we care about here.
			verify: g.verify as unknown as Workflow["gates"][number]["verify"],
		})),
	};
	const goalId = "goal-test-1";
	const goal: PersistedGoal = {
		id: goalId,
		title: "Test parent goal",
		cwd: tmpRoot,
		state: "in-progress",
		spec: "## Acceptance criteria\n\n- Build it.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		workflowId: "parent",
		workflow: snapshot,
	};
	store.put(goal);
	return { store, goalId };
}

describe("goal-plan freeze hook (server.ts gate_signal block)", () => {
	it("stamps metadata.frozen=\"true\" on the snapshotted execution gate", () => {
		const { store, goalId } = makeGoalWithParentWorkflow();
		const before = store.get(goalId)!;
		const execBefore = before.workflow!.gates.find(g => g.id === "execution")!;
		assert.equal(execBefore.metadata?.frozen, undefined, "fresh goal must not be frozen");

		applyGoalPlanFreezeForTest(store, goalId);

		const after = store.get(goalId)!;
		const execAfter = after.workflow!.gates.find(g => g.id === "execution")!;
		assert.equal(execAfter.metadata?.frozen, "true");
		assert.ok(
			execAfter.metadata?.frozenAt && /^\d+$/.test(execAfter.metadata.frozenAt),
			"frozenAt must be a numeric epoch-ms string",
		);
	});

	it("does NOT mutate other gates' metadata", () => {
		const { store, goalId } = makeGoalWithParentWorkflow();
		applyGoalPlanFreezeForTest(store, goalId);
		const after = store.get(goalId)!;
		for (const g of after.workflow!.gates) {
			if (g.id === "execution") continue;
			// Some gates may have a non-empty `metadata` schema (e.g.
			// reproducing-test); none of them should have a `frozen` key.
			if (g.metadata) {
				assert.notEqual(g.metadata.frozen, "true", `gate ${g.id} accidentally frozen`);
			}
		}
	});

	it("is idempotent — second call preserves the original frozenAt", async () => {
		const { store, goalId } = makeGoalWithParentWorkflow();
		applyGoalPlanFreezeForTest(store, goalId);
		const firstStamp = store.get(goalId)!
			.workflow!.gates.find(g => g.id === "execution")!.metadata!.frozenAt;
		assert.ok(firstStamp);
		// Sleep a tick to guarantee Date.now() would differ.
		await new Promise(r => setTimeout(r, 5));
		applyGoalPlanFreezeForTest(store, goalId);
		const secondStamp = store.get(goalId)!
			.workflow!.gates.find(g => g.id === "execution")!.metadata!.frozenAt;
		assert.equal(secondStamp, firstStamp, "frozenAt must not be overwritten");
	});

	it("persists the stamp through goalStore.put/update (survives reload)", () => {
		const { store, goalId } = makeGoalWithParentWorkflow();
		applyGoalPlanFreezeForTest(store, goalId);

		// Reload from disk via a fresh store instance.
		const reloaded = new GoalStore(tmpRoot);
		const goal = reloaded.get(goalId);
		assert.ok(goal, "goal must persist across GoalStore reload");
		const exec = goal!.workflow!.gates.find(g => g.id === "execution")!;
		assert.equal(exec.metadata?.frozen, "true");
		assert.ok(exec.metadata?.frozenAt);
	});

	it("does not stamp the canonical builtin (parent.yaml shape stays clean)", () => {
		const { store, goalId } = makeGoalWithParentWorkflow();
		applyGoalPlanFreezeForTest(store, goalId);
		// Re-derive the builtin snapshot — it must remain unstamped.
		const fresh = buildDefaultWorkflows("bobbit");
		const exec = fresh.parent.gates.find(g => g.id === "execution")!;
		assert.equal(exec.metadata, undefined,
			"canonical builtin must not carry frozen metadata");
	});

	it("returns false / no-op when goal has no execution gate", () => {
		const store = new GoalStore(tmpRoot);
		const goalId = "goal-no-exec";
		const goal: PersistedGoal = {
			id: goalId,
			title: "No exec gate",
			cwd: tmpRoot,
			state: "in-progress",
			spec: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			workflowId: "feature",
			workflow: {
				id: "feature",
				name: "Feature",
				description: "",
				createdAt: 0,
				updatedAt: 0,
				gates: [
					{ id: "design-doc", name: "Design", dependsOn: [] },
				],
			},
		};
		store.put(goal);
		const result = applyGoalPlanFreezeForTest(store, goalId);
		assert.equal(result, false);
	});
});
