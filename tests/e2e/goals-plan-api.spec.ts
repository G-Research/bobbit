/**
 * E2E tests: PATCH /api/goals/:id/plan — Phase 3 task 3.5 (freeze + OCC),
 * updated by Phase 5 task 5.2 to reflect classifier-driven behaviour.
 *
 * Behaviour:
 *   - Pre-freeze (no metadata.frozen on the gate) → applies freely (matrix bypassed).
 *   - Post-freeze without `replanReason` → 409 { error: "frozen-no-reason" }.
 *   - Post-freeze with `replanReason` → classifier-driven decision matrix
 *     applies (auto-apply / buffer-and-prompt / hard-reject). Auto-applies
 *     bump `replanCount`.
 *   - `expectedReplanCount` mismatch → 409 { error: "stale-plan", currentReplanCount }.
 *
 * Tests covering the matrix cells live in `tests/e2e/goals-classifier-api.spec.ts`.
 * The post-freeze tests below use `divergencePolicy: "balanced"` and `fix-up`
 * shape mutations so they auto-approve and the bump-replanCount /
 * stale-plan / OCC paths can be exercised cleanly.
 *
 * Approach: register two custom workflows on the harness's default project
 * via PUT /api/projects/:id/config — one with an `execution` gate that has
 * no frozen metadata (pre-freeze fixture) and one with the same gate
 * pre-stamped with `metadata.frozen = "true"` (post-freeze fixture). This
 * sidesteps the LLM-reviewed `parent`-workflow chain (charter →
 * plan-review → goal-plan) and lets the test target the PATCH /plan logic
 * in isolation.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, defaultProjectId } from "./e2e-setup.js";
import { TEST_DEFAULT_COMPONENT, testWorkflows } from "./seed-workflows.js";

/** Workflow id with an `execution` gate that is NOT frozen. */
const PLAN_FRESH_WORKFLOW_ID = "plan-test-fresh";
/** Workflow id with an `execution` gate where metadata.frozen === "true". */
const PLAN_FROZEN_WORKFLOW_ID = "plan-test-frozen";

function fakeSubgoalStep(planId: string, title: string): Record<string, unknown> {
	return {
		name: title,
		type: "subgoal",
		phase: 0,
		subgoal: { title, spec: `Spec for ${title}.`, planId },
	};
}

/** Inject the two plan-test workflows into the harness's default project. */
async function seedPlanWorkflows(projectId: string): Promise<void> {
	const wfs = {
		...testWorkflows(),
		[PLAN_FRESH_WORKFLOW_ID]: {
			id: PLAN_FRESH_WORKFLOW_ID,
			name: "Plan Test (Fresh)",
			description: "Fixture for PATCH /plan — fresh execution gate.",
			gates: [
				{
					id: "execution",
					name: "Execution",
					verify: [],
				},
			],
		},
		[PLAN_FROZEN_WORKFLOW_ID]: {
			id: PLAN_FROZEN_WORKFLOW_ID,
			name: "Plan Test (Frozen)",
			description: "Fixture for PATCH /plan — execution gate pre-frozen.",
			gates: [
				{
					id: "execution",
					name: "Execution",
					metadata: { frozen: "true", frozenAt: "1234567890" },
					verify: [],
				},
			],
		},
	};
	const resp = await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({
			components: [TEST_DEFAULT_COMPONENT],
			workflows: wfs,
		}),
	});
	if (resp.status !== 200) {
		const text = await resp.text().catch(() => "<no body>");
		throw new Error(`PUT /api/projects/${projectId}/config failed: ${resp.status} ${text}`);
	}
}

async function createGoal(workflowId: string): Promise<string> {
	return createGoalPolicy(workflowId);
}

async function createGoalPolicy(
	workflowId: string,
	divergencePolicy?: "strict" | "balanced" | "autonomous",
): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Plan API Test ${workflowId} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId,
			autoStartTeam: false,
			divergencePolicy,
		}),
	});
	if (resp.status !== 201) {
		const text = await resp.text().catch(() => "<no body>");
		throw new Error(`POST /api/goals failed: ${resp.status} ${text}`);
	}
	const goal = await resp.json();
	return goal.id;
}

/**
 * Seed the goal's snapshotted execution gate directly via the in-process
 * GoalManager. Phase 5 task 5.2 added classifier consultation: the frozen
 * fixture starts post-freeze with `verify=[]`, so a normal PATCH would
 * classify any addition from empty as `expansion` (always prompts). Tests
 * that need a `fix-up`-shaped baseline pre-seed via this helper.
 */
async function seedFrozenPlanInProc(gateway: any, goalId: string, before: Record<string, unknown>[]): Promise<void> {
	const ctx = gateway.projectContextManager.getContextForGoal(goalId);
	if (!ctx) throw new Error(`No project context for goal ${goalId}`);
	const goal = ctx.goalStore.get(goalId);
	if (!goal?.workflow) throw new Error(`Goal ${goalId} has no workflow snapshot`);
	const exec = goal.workflow.gates.find((g: any) => g.id === "execution");
	if (!exec) throw new Error(`No execution gate on goal ${goalId}`);
	exec.verify = before as any;
	ctx.goalStore.update(goalId, { workflow: goal.workflow });
}

async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => { });
}

async function patchPlan(goalId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const resp = await apiFetch(`/api/goals/${goalId}/plan`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
	const json = await resp.json().catch(() => ({}));
	return { status: resp.status, body: json };
}

test.describe("PATCH /api/goals/:id/plan", () => {
	test.beforeAll(async () => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await seedPlanWorkflows(pid!);
	});

	test("pre-freeze: applies the new plan and does not bump replanCount", async () => {
		const goalId = await createGoal(PLAN_FRESH_WORKFLOW_ID);
		try {
			const planSteps = [
				fakeSubgoalStep("plan-1", "Build API client"),
				fakeSubgoalStep("plan-2", "Wire UI"),
			];
			const { status, body } = await patchPlan(goalId, { planSteps });
			expect(status).toBe(200);
			expect(body.replanCount).toBe(0);
			expect(Array.isArray(body.plan)).toBe(true);
			expect(body.plan).toHaveLength(2);
			expect(body.plan[0].subgoal.planId).toBe("plan-1");
			expect(body.plan[1].subgoal.planId).toBe("plan-2");

			// The plan persists on the goal — re-fetch via /api/goals/:id.
			const fetched = await apiFetch(`/api/goals/${goalId}`);
			expect(fetched.status).toBe(200);
			const fetchedJson = await fetched.json();
			const exec = fetchedJson.workflow.gates.find((g: any) => g.id === "execution");
			expect(exec).toBeTruthy();
			expect(exec.verify).toHaveLength(2);
			expect(exec.verify[0].subgoal.planId).toBe("plan-1");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("post-freeze without replanReason → 409 frozen-no-reason", async () => {
		const goalId = await createGoal(PLAN_FROZEN_WORKFLOW_ID);
		try {
			const { status, body } = await patchPlan(goalId, {
				planSteps: [fakeSubgoalStep("plan-1", "Build API client")],
			});
			expect(status).toBe(409);
			expect(body.error).toBe("frozen-no-reason");

			// The plan must NOT have been written.
			const fetched = await apiFetch(`/api/goals/${goalId}`);
			const fetchedJson = await fetched.json();
			const exec = fetchedJson.workflow.gates.find((g: any) => g.id === "execution");
			expect(exec.verify ?? []).toHaveLength(0);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("post-freeze fix-up under balanced → applies and bumps replanCount", async ({ gateway }) => {
		// Use a balanced-policy goal + fix-up shape (additive leaf at existing
		// phase) so the classifier auto-approves. Pre-seed a non-empty plan so
		// the second PATCH is a true `fix-up` rather than `expansion`-from-empty.
		const goalId = await createGoalPolicy(PLAN_FROZEN_WORKFLOW_ID, "balanced");
		try {
			await seedFrozenPlanInProc(gateway, goalId, [
				fakeSubgoalStep("plan-A", "Stand up service"),
			]);
			const planSteps = [
				fakeSubgoalStep("plan-A", "Stand up service"),
				fakeSubgoalStep("plan-B", "Add CI"),
			];
			const { status, body } = await patchPlan(goalId, {
				planSteps,
				replanReason: "Add CI step.",
			});
			expect(status).toBe(200);
			expect(body.replanCount).toBe(1);
			expect(body.plan).toHaveLength(2);
			expect(body.plan[1].subgoal.planId).toBe("plan-B");

			// Second post-freeze update bumps replanCount again.
			const second = await patchPlan(goalId, {
				planSteps: [
					fakeSubgoalStep("plan-A", "Stand up service"),
					fakeSubgoalStep("plan-B", "Add CI"),
					fakeSubgoalStep("plan-C", "Add metrics"),
				],
				replanReason: "Add metrics step.",
			});
			expect(second.status).toBe(200);
			expect(second.body.replanCount).toBe(2);
			expect(second.body.plan).toHaveLength(3);

			// The persisted goal carries the bumped counter.
			const fetched = await apiFetch(`/api/goals/${goalId}`);
			const fetchedJson = await fetched.json();
			expect(fetchedJson.replanCount).toBe(2);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expectedReplanCount mismatch → 409 stale-plan with currentReplanCount", async ({ gateway }) => {
		const goalId = await createGoalPolicy(PLAN_FROZEN_WORKFLOW_ID, "balanced");
		try {
			// Pre-seed so the first PATCH is a fix-up (auto-approves under balanced).
			await seedFrozenPlanInProc(gateway, goalId, [
				fakeSubgoalStep("plan-seed", "Seed"),
			]);
			// Bump the counter to 1 first.
			const first = await patchPlan(goalId, {
				planSteps: [
					fakeSubgoalStep("plan-seed", "Seed"),
					fakeSubgoalStep("plan-X", "Initial"),
				],
				replanReason: "First write.",
			});
			expect(first.status).toBe(200);
			expect(first.body.replanCount).toBe(1);

			// Caller thinks the counter is still 0 → stale-plan.
			const stale = await patchPlan(goalId, {
				planSteps: [
					fakeSubgoalStep("plan-seed", "Seed"),
					fakeSubgoalStep("plan-X", "Initial"),
					fakeSubgoalStep("plan-Y", "Stale"),
				],
				replanReason: "Should be rejected.",
				expectedReplanCount: 0,
			});
			expect(stale.status).toBe(409);
			expect(stale.body.error).toBe("stale-plan");
			expect(stale.body.currentReplanCount).toBe(1);

			// Correct expectedReplanCount → succeeds.
			const fresh = await patchPlan(goalId, {
				planSteps: [
					fakeSubgoalStep("plan-seed", "Seed"),
					fakeSubgoalStep("plan-X", "Initial"),
					fakeSubgoalStep("plan-Y", "Fresh"),
				],
				replanReason: "Now correct.",
				expectedReplanCount: 1,
			});
			expect(fresh.status).toBe(200);
			expect(fresh.body.replanCount).toBe(2);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("missing planSteps → 400", async () => {
		const goalId = await createGoal(PLAN_FRESH_WORKFLOW_ID);
		try {
			const { status } = await patchPlan(goalId, {});
			expect(status).toBe(400);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("unknown gateId → 404", async () => {
		const goalId = await createGoal(PLAN_FRESH_WORKFLOW_ID);
		try {
			const { status } = await patchPlan(goalId, {
				planSteps: [],
				gateId: "no-such-gate",
			});
			expect(status).toBe(404);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("nonexistent goal → 404", async () => {
		const resp = await apiFetch(`/api/goals/no-such-goal/plan`, {
			method: "PATCH",
			body: JSON.stringify({ planSteps: [] }),
		});
		expect(resp.status).toBe(404);
	});
});
