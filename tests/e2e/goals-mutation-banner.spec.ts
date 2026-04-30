/**
 * E2E tests: POST /api/goals/:id/mutation/:requestId/decision — Phase 4
 * task 4.3 (nested-goals).
 *
 * Phase 4 owns only the **endpoint** + GoalManager storage. Phase 5 task
 * 5.2 will populate `pendingMutations` from the classifier; here we drive
 * the buffer directly via the in-process `GoalManager` so the storage +
 * apply/reject + broadcast surface can be exercised without a classifier.
 *
 * Coverage:
 *   - approve(plan-replace) → 200 { resolved, applied: { plan } }, broadcasts
 *     `goal_mutation_resolved` AND `goal_plan_proposed`, plan persisted.
 *   - reject               → 200 { resolved }, broadcasts `goal_mutation_resolved`,
 *                            plan untouched.
 *   - stale/unknown requestId → 404 unknown-or-stale-request.
 *   - approve then re-decide → 404 (buffer consumed).
 *   - bad body shape       → 400.
 *   - unknown goal         → 404 Goal not found.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd, readE2EToken, wsBase } from "./e2e-setup.js";
import { TEST_DEFAULT_COMPONENT, testWorkflows } from "./seed-workflows.js";
import WebSocket from "ws";

const PLAN_FRESH_WORKFLOW_ID = "mutation-banner-fresh";

function fakeSubgoalStep(planId: string, title: string): Record<string, unknown> {
	return {
		name: title,
		type: "subgoal",
		phase: 0,
		subgoal: { title, spec: `Spec for ${title}.`, planId },
	};
}

async function seedFreshWorkflow(projectId: string): Promise<void> {
	const wfs = {
		...testWorkflows(),
		[PLAN_FRESH_WORKFLOW_ID]: {
			id: PLAN_FRESH_WORKFLOW_ID,
			name: "Mutation Banner (Fresh)",
			description: "Fixture for POST /mutation/:rid/decision — fresh execution gate.",
			gates: [
				{ id: "execution", name: "Execution", verify: [] },
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
		throw new Error(`PUT /api/projects/${projectId}/config failed: ${resp.status}`);
	}
}

async function createGoalForTest(workflowId: string): Promise<string> {
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Mutation Banner ${workflowId} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId,
			projectId,
			autoStartTeam: false,
		}),
	});
	if (resp.status !== 201) throw new Error(`POST /api/goals failed: ${resp.status}`);
	const goal = await resp.json();
	return goal.id;
}

async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
}

/** Open a viewer-only WebSocket and collect events matching `predicate`. */
async function openWsCollector(
	predicate: (msg: any) => boolean,
): Promise<{ finish: (durationMs?: number) => Promise<any[]> }> {
	const events: any[] = [];
	const ws = new WebSocket(`${wsBase()}/ws/__viewer__`);
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("WS auth timeout")), 5_000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: readE2EToken(), sessionId: "__viewer__" }));
		});
		ws.on("message", (raw: Buffer) => {
			let msg: any;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (msg?.type === "auth_ok") { clearTimeout(t); resolve(); return; }
			if (msg && predicate(msg)) events.push(msg);
		});
		ws.on("error", (err) => { clearTimeout(t); reject(err); });
	});
	return {
		finish: async (durationMs = 500) => {
			await new Promise(r => setTimeout(r, durationMs));
			ws.close();
			return events;
		},
	};
}

/** Helper: reach into the in-process GoalManager and buffer a plan-replace
 *  mutation. Phase 5 task 5.2 will populate this from the classifier; here
 *  we drive it directly so 4.3's surface is testable in isolation. */
async function bufferPlanReplaceMutation(
	gateway: any,
	goalId: string,
	requestId: string,
	planSteps: Record<string, unknown>[],
): Promise<void> {
	const ctx = gateway.projectContextManager.getContextForGoal(goalId);
	if (!ctx) throw new Error(`No project context for goal ${goalId}`);
	ctx.goalManager.bufferMutation(requestId, {
		kind: "plan-replace",
		goalId,
		gateId: "execution",
		planSteps,
		createdAt: Date.now(),
	});
}

test.describe("POST /api/goals/:id/mutation/:requestId/decision", () => {
	test.beforeAll(async () => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await seedFreshWorkflow(pid!);
	});

	test("approve buffered plan-replace → 200, applies plan, broadcasts goal_mutation_resolved", async ({ gateway }) => {
		const goalId = await createGoalForTest(PLAN_FRESH_WORKFLOW_ID);
		try {
			const requestId = `req-approve-${Date.now()}`;
			const planSteps = [
				fakeSubgoalStep("plan-1", "Build API client"),
				fakeSubgoalStep("plan-2", "Wire UI"),
			];
			await bufferPlanReplaceMutation(gateway, goalId, requestId, planSteps);

			const collector = await openWsCollector(
				m => (m.type === "goal_mutation_resolved" || m.type === "goal_plan_proposed") && m.goalId === goalId,
			);

			const resp = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "approve" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.resolved).toBe(true);
			expect(Array.isArray(body.applied?.plan)).toBe(true);
			expect(body.applied.plan).toHaveLength(2);
			expect(body.applied.plan[0].subgoal.planId).toBe("plan-1");

			const events = await collector.finish(800);
			const resolved = events.find(e => e.type === "goal_mutation_resolved" && e.requestId === requestId);
			expect(resolved, "expected goal_mutation_resolved broadcast").toBeTruthy();
			expect(resolved.decision).toBe("approve");
			const planProposed = events.find(e => e.type === "goal_plan_proposed");
			expect(planProposed, "expected goal_plan_proposed mirror broadcast").toBeTruthy();
			expect(planProposed.gateId).toBe("execution");
			expect(planProposed.planSteps).toHaveLength(2);

			// Plan persisted on the goal.
			const fetched = await apiFetch(`/api/goals/${goalId}`);
			const fetchedJson = await fetched.json();
			const exec = fetchedJson.workflow.gates.find((g: any) => g.id === "execution");
			expect(exec.verify).toHaveLength(2);
			expect(exec.verify[0].subgoal.planId).toBe("plan-1");

			// Buffer consumed — re-deciding the same requestId is a 404.
			const second = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "approve" }),
			});
			expect(second.status).toBe(404);
			const secondBody = await second.json();
			expect(secondBody.error).toBe("unknown-or-stale-request");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("reject buffered plan-replace → 200, broadcasts goal_mutation_resolved, plan untouched", async ({ gateway }) => {
		const goalId = await createGoalForTest(PLAN_FRESH_WORKFLOW_ID);
		try {
			const requestId = `req-reject-${Date.now()}`;
			const planSteps = [fakeSubgoalStep("plan-rejected", "Should not land")];
			await bufferPlanReplaceMutation(gateway, goalId, requestId, planSteps);

			const collector = await openWsCollector(
				m => m.type === "goal_mutation_resolved" && m.goalId === goalId,
			);

			const resp = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "reject" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.resolved).toBe(true);
			expect(body.applied).toBeUndefined();

			const events = await collector.finish(600);
			const resolved = events.find(e => e.requestId === requestId);
			expect(resolved, "expected goal_mutation_resolved broadcast").toBeTruthy();
			expect(resolved.decision).toBe("reject");

			// Plan was NOT applied.
			const fetched = await apiFetch(`/api/goals/${goalId}`);
			const fetchedJson = await fetched.json();
			const exec = fetchedJson.workflow.gates.find((g: any) => g.id === "execution");
			expect(exec.verify ?? []).toHaveLength(0);

			// Buffer consumed — re-deciding is a 404.
			const second = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "reject" }),
			});
			expect(second.status).toBe(404);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("unknown requestId → 404 unknown-or-stale-request", async () => {
		const goalId = await createGoalForTest(PLAN_FRESH_WORKFLOW_ID);
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/mutation/never-buffered-${Date.now()}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "approve" }),
			});
			expect(resp.status).toBe(404);
			const body = await resp.json();
			expect(body.error).toBe("unknown-or-stale-request");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("malformed decision body → 400", async ({ gateway }) => {
		const goalId = await createGoalForTest(PLAN_FRESH_WORKFLOW_ID);
		try {
			const requestId = `req-bad-body-${Date.now()}`;
			await bufferPlanReplaceMutation(gateway, goalId, requestId, [fakeSubgoalStep("p1", "x")]);

			const resp = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "maybe" }),
			});
			expect(resp.status).toBe(400);

			// Buffer not consumed by a 400 — we can still approve.
			const recover = await apiFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision: "approve" }),
			});
			expect(recover.status).toBe(200);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("unknown goal → 404 Goal not found", async () => {
		const resp = await apiFetch(
			`/api/goals/00000000-0000-0000-0000-000000000000/mutation/any/decision`,
			{ method: "POST", body: JSON.stringify({ decision: "approve" }) },
		);
		expect(resp.status).toBe(404);
	});
});
