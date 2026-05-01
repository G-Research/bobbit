/**
 * E2E tests: classifier-driven divergence-policy enforcement on
 *   - PATCH /api/goals/:id/plan
 *   - POST  /api/goals/:id/spawn-child
 *
 * Implements Phase 5 task 5.2 (`docs/design/nested-goals.md` §4.3 decision
 * matrix). Every cell of the matrix is exercised:
 *
 *   classifier output | strict      | balanced       | autonomous
 *   noop              | allow       | allow          | allow
 *   fix-up            | prompt      | auto-approve   | auto-approve
 *   expansion         | prompt      | prompt         | prompt (+ WS)
 *   restructure       | reject (paused-required) → prompt | prompt | prompt
 *   criteria-drop     | reject (no policy override)
 *
 *   replanCount > 5   | 409 replan-cap (any class except noop)
 *
 * Plus pre-freeze applies (matrix bypassed) and an end-to-end reject-on-
 * criteria-drop adherence check.
 *
 * The tests use a custom `parent`-shaped workflow with a pre-frozen
 * `execution` gate (already-frozen fixture) so the matrix is consulted
 * without driving the upstream `goal-plan` LLM-reviewed gate.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd, readE2EToken, wsBase } from "./e2e-setup.js";
import { TEST_DEFAULT_COMPONENT, testWorkflows } from "./seed-workflows.js";
import WebSocket from "ws";

const FRESH_WORKFLOW_ID = "classifier-fresh";
const FROZEN_WORKFLOW_ID = "classifier-frozen";

function subgoalStep(planId: string, opts: {
	title?: string;
	spec?: string;
	phase?: number;
	workflowId?: string;
} = {}): Record<string, unknown> {
	const title = opts.title ?? planId;
	return {
		name: title,
		type: "subgoal",
		phase: opts.phase ?? 1,
		subgoal: {
			planId,
			title,
			spec: opts.spec ?? `Spec for ${title}.`,
			workflowId: opts.workflowId,
		},
	};
}

async function seedWorkflows(projectId: string): Promise<void> {
	const wfs = {
		...testWorkflows(),
		[FRESH_WORKFLOW_ID]: {
			id: FRESH_WORKFLOW_ID,
			name: "Classifier (Fresh)",
			description: "Fixture for §4.3 matrix — execution gate not frozen.",
			gates: [{ id: "execution", name: "Execution", verify: [] }],
		},
		[FROZEN_WORKFLOW_ID]: {
			id: FROZEN_WORKFLOW_ID,
			name: "Classifier (Frozen)",
			description: "Fixture for §4.3 matrix — execution gate pre-frozen.",
			gates: [{
				id: "execution",
				name: "Execution",
				metadata: { frozen: "true", frozenAt: "1234567890" },
				verify: [],
			}],
		},
	};
	const resp = await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ components: [TEST_DEFAULT_COMPONENT], workflows: wfs }),
	});
	if (resp.status !== 200) {
		throw new Error(`PUT /api/projects/${projectId}/config failed: ${resp.status}`);
	}
}

async function createGoal(opts: {
	workflowId: string;
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	spec?: string;
	paused?: boolean;
	titleHint?: string;
}): Promise<string> {
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Classifier ${opts.titleHint ?? opts.workflowId} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: opts.workflowId,
			projectId,
			autoStartTeam: false,
			spec: opts.spec ?? "Test root spec.",
			divergencePolicy: opts.divergencePolicy,
		}),
	});
	if (resp.status !== 201) {
		const body = await resp.text().catch(() => "");
		throw new Error(`POST /api/goals failed: ${resp.status} ${body}`);
	}
	const goal = await resp.json();
	if (opts.paused) {
		const r = await apiFetch(`/api/goals/${goal.id}/pause`, { method: "POST" });
		if (r.status !== 200) throw new Error(`pause failed: ${r.status}`);
	}
	return goal.id;
}

async function deleteGoal(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
}

async function patchPlan(goalId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const resp = await apiFetch(`/api/goals/${goalId}/plan`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
	const j = await resp.json().catch(() => ({}));
	return { status: resp.status, body: j };
}

async function spawnChild(parentId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const resp = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	const j = await resp.json().catch(() => ({}));
	return { status: resp.status, body: j };
}

async function getGoal(id: string): Promise<any> {
	const r = await apiFetch(`/api/goals/${id}`);
	return r.json();
}

async function getExecVerify(goalId: string): Promise<any[]> {
	const g = await getGoal(goalId);
	const exec = g.workflow?.gates.find((x: any) => x.id === "execution");
	return exec?.verify ?? [];
}

/**
 * Open a viewer-only WebSocket. Returns:
 *   - `waitFor(pred)`  — resolve on first matching event (or reject on timeout).
 *   - `expectNone(ms)` — resolve after `ms` ms IF no matching event arrived;
 *                       reject otherwise. Used for negative assertions.
 *   - `close()`        — close the socket.
 *
 * The wait helpers are event-driven (no `setTimeout(resolve, ...)` polling).
 * `expectNone` does use a deadline timer to bound the negative assertion,
 * but it only races with predicate hits — it never sleeps unconditionally.
 */
async function openWsViewer(): Promise<{
	waitFor: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
	expectNone: (pred: (m: any) => boolean, withinMs?: number) => Promise<void>;
	close: () => void;
}> {
	const events: any[] = [];
	const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void; rej: (e: Error) => void }> = [];
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
			if (!msg) return;
			events.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});
		ws.on("error", (err) => { clearTimeout(t); reject(err); });
	});
	return {
		waitFor(pred, timeoutMs = 5_000) {
			const existing = events.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((res, rej) => {
				const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
				waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
			});
		},
		expectNone(pred, withinMs = 600) {
			// Resolve when the deadline passes WITHOUT a match. Reject if a
			// match arrives. Already-received matching events fail immediately.
			const existing = events.find(pred);
			if (existing) return Promise.reject(new Error("expectNone: matching event already arrived"));
			return new Promise((res, rej) => {
				const t = setTimeout(() => {
					const idx = waiters.findIndex(w => w.pred === pred);
					if (idx >= 0) waiters.splice(idx, 1);
					res();
				}, withinMs);
				waiters.push({
					pred,
					res: () => { clearTimeout(t); rej(new Error("expectNone: matching event arrived")); },
					rej,
				});
			});
		},
		close: () => ws.close(),
	};
}

/**
 * Seed the goal's snapshotted execution gate directly via the in-process
 * GoalManager, bypassing the classifier. The frozen-fixture workflow starts
 * post-freeze, so a normal PATCH would be subject to the matrix. We need a
 * way to install a `before` plan against which mutations can be classified.
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

test.describe("§4.3 decision matrix — PATCH /plan", () => {
	test.beforeAll(async () => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await seedWorkflows(pid!);
	});

	// ── pre-freeze: matrix bypassed ─────────────────────────────────
	test("pre-freeze: applies any non-criteria-drop mutation, no replan bump", async () => {
		const goalId = await createGoal({ workflowId: FRESH_WORKFLOW_ID });
		try {
			const before = [subgoalStep("p1"), subgoalStep("p2")];
			const r1 = await patchPlan(goalId, { planSteps: before });
			expect(r1.status).toBe(200);
			expect(r1.body.replanCount).toBe(0);
			// Pre-freeze still allows restructure (would prompt post-freeze).
			const r2 = await patchPlan(goalId, { planSteps: [subgoalStep("p1")] });
			expect(r2.status).toBe(200);
			expect(r2.body.replanCount).toBe(0);
		} finally { await deleteGoal(goalId); }
	});

	// ── noop: allow under every policy ──────────────────────────────
	for (const policy of ["strict", "balanced", "autonomous"] as const) {
		test(`noop applies under ${policy} (post-freeze)`, async ({ gateway }) => {
			const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			try {
				const seed = [subgoalStep("p1")];
				await seedFrozenPlanInProc(gateway, goalId, seed);
				// Send the same plan back — classifier reports `noop`. Auto-applies
				// without a replanCount bump under every policy.
				const { status, body } = await patchPlan(goalId, {
					planSteps: seed,
					replanReason: "noop",
				});
				expect(status).toBe(200);
				expect(body.replanCount).toBe(0);
			} finally { await deleteGoal(goalId); }
		});
	}

	// ── fix-up: strict prompts; balanced/autonomous auto-approve ───
	test("fix-up under strict → 409 prompt + buffers + broadcasts goal_mutation_pending", async ({ gateway }) => {
		const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: "strict" });
		const viewer = await openWsViewer();
		try {
			const before = [subgoalStep("p1", { phase: 1 })];
			await seedFrozenPlanInProc(gateway, goalId, before);
			const after = [...before, subgoalStep("p2", { phase: 1, title: "leaf" })];
			const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "add leaf" });
			expect(status).toBe(409);
			expect(body.error).toBe("mutation-rejected");
			expect(body.classification).toBe("fix-up");
			expect(body.requiresApproval).toBe(true);
			expect(body.policy).toBe("strict");
			expect(typeof body.requestId).toBe("string");
			const evt = await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
			expect(evt.requestId).toBe(body.requestId);
			expect(evt.classification).toBe("fix-up");
			// Plan was NOT applied yet.
			const verify = await getExecVerify(goalId);
			expect(verify).toHaveLength(1);
		} finally { viewer.close(); await deleteGoal(goalId); }
	});

	for (const policy of ["balanced", "autonomous"] as const) {
		test(`fix-up under ${policy} → auto-approve (200 + replan bump)`, async ({ gateway }) => {
			const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			try {
				const before = [subgoalStep("p1", { phase: 1 })];
				await seedFrozenPlanInProc(gateway, goalId, before);
				const after = [...before, subgoalStep("p2", { phase: 1, title: "leaf" })];
				const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "add leaf" });
				expect(status).toBe(200);
				expect(body.plan).toHaveLength(2);
				expect(body.replanCount).toBe(1);
				const verify = await getExecVerify(goalId);
				expect(verify).toHaveLength(2);
			} finally { await deleteGoal(goalId); }
		});
	}

	// ── expansion: prompt under ALL policies ───────────────────────
	for (const policy of ["strict", "balanced", "autonomous"] as const) {
		test(`expansion under ${policy} → 409 prompt + broadcasts goal_mutation_pending`, async ({ gateway }) => {
			const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			const viewer = await openWsViewer();
			try {
				const before = [subgoalStep("p1", { phase: 1 })];
				await seedFrozenPlanInProc(gateway, goalId, before);
				// Adding a step at phase 2 (new top-level phase) → expansion.
				const after = [...before, subgoalStep("p2", { phase: 2, title: "new-branch" })];
				const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "expand" });
				expect(status).toBe(409);
				expect(body.error).toBe("mutation-rejected");
				expect(body.classification).toBe("expansion");
				expect(body.requiresApproval).toBe(true);
				expect(body.policy).toBe(policy);
				expect(typeof body.requestId).toBe("string");
				const evt = await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
				expect(evt.requestId).toBe(body.requestId);
				// Plan NOT applied.
				const verify = await getExecVerify(goalId);
				expect(verify).toHaveLength(1);
			} finally { viewer.close(); await deleteGoal(goalId); }
		});
	}

	// ── restructure: strict requires goal.paused, else 409 reject ──
	test("restructure under strict (paused=false) → 409 reject (restructure-requires-pause), no buffer", async ({ gateway }) => {
		const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: "strict" });
		const viewer = await openWsViewer();
		try {
			const before = [subgoalStep("p1"), subgoalStep("p2")];
			await seedFrozenPlanInProc(gateway, goalId, before);
			// Removing p2 → restructure.
			const after = [subgoalStep("p1")];
			const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "shrink" });
			expect(status).toBe(409);
			expect(body.error).toBe("mutation-rejected");
			expect(body.classification).toBe("restructure");
			expect(body.requiresApproval).toBe(false);
			expect(body.reason).toBe("restructure-requires-pause");
			expect(body.policy).toBe("strict");
			// Negative assertion: NO mutation-pending broadcast fires.
			await viewer.expectNone(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
			const verify = await getExecVerify(goalId);
			expect(verify).toHaveLength(2);
		} finally { viewer.close(); await deleteGoal(goalId); }
	});

	test("restructure under strict (paused=true) → 409 prompt + buffers + broadcasts", async ({ gateway }) => {
		const goalId = await createGoal({
			workflowId: FROZEN_WORKFLOW_ID,
			divergencePolicy: "strict",
			paused: true,
		});
		const viewer = await openWsViewer();
		try {
			const before = [subgoalStep("p1"), subgoalStep("p2")];
			await seedFrozenPlanInProc(gateway, goalId, before);
			const after = [subgoalStep("p1")];
			const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "shrink" });
			expect(status).toBe(409);
			expect(body.classification).toBe("restructure");
			expect(body.requiresApproval).toBe(true);
			expect(typeof body.requestId).toBe("string");
			await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
		} finally { viewer.close(); await deleteGoal(goalId); }
	});

	for (const policy of ["balanced", "autonomous"] as const) {
		test(`restructure under ${policy} → 409 prompt + buffers + broadcasts (paused not required)`, async ({ gateway }) => {
			const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			const viewer = await openWsViewer();
			try {
				const before = [subgoalStep("p1"), subgoalStep("p2")];
				await seedFrozenPlanInProc(gateway, goalId, before);
				const after = [subgoalStep("p1")];
				const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "shrink" });
				expect(status).toBe(409);
				expect(body.classification).toBe("restructure");
				expect(body.requiresApproval).toBe(true);
				await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
			} finally { viewer.close(); await deleteGoal(goalId); }
		});
	}

	// ── criteria-drop: rejected under every policy, no buffer ──────
	for (const policy of ["strict", "balanced", "autonomous"] as const) {
		test(`criteria-drop under ${policy} → 409 reject with droppedCriteria, no buffer`, async ({ gateway }) => {
			// Root goal carries an acceptance criterion. The mutation removes the
			// only step whose spec covered it, so the classifier must surface
			// criteria-drop. The root spec must NOT also contain the criterion
			// (otherwise the substring match passes via base coverage).
			const criterion = "ZZZ-marker-criterion-not-anywhere-else";
			const rootSpec = "# Root\n\nA generic spec without the marker text.\n";
			const goalId = await createGoal({
				workflowId: FROZEN_WORKFLOW_ID,
				divergencePolicy: policy,
				spec: rootSpec,
			});
			const viewer = await openWsViewer();
			try {
				const before = [
					subgoalStep("p1", { spec: `Covers ${criterion}.` }),
				];
				await seedFrozenPlanInProc(gateway, goalId, before);
				// Inject the acceptance criterion onto the goal record (parser would
				// usually populate this from `## Acceptance criteria` in the spec).
				const ctx = (gateway as any).projectContextManager.getContextForGoal(goalId);
				ctx.goalStore.update(goalId, { acceptanceCriteria: [criterion] });
				// Remove the only covering step.
				const after = [subgoalStep("p2", { spec: "Unrelated spec." })];
				const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "drop coverage" });
				expect(status).toBe(409);
				expect(body.error).toBe("mutation-rejected");
				expect(body.classification).toBe("criteria-drop");
				expect(body.requiresApproval).toBe(false);
				expect(Array.isArray(body.droppedCriteria)).toBe(true);
				expect(body.droppedCriteria).toContain(criterion);
				await viewer.expectNone(m => m.type === "goal_mutation_pending" && m.goalId === goalId);
			} finally { viewer.close(); await deleteGoal(goalId); }
		});
	}

	// ── replan-cap: 409 regardless of class ────────────────────────
	test("replanCount >= 5 → 409 replan-cap (post-freeze, non-noop)", async ({ gateway }) => {
		const goalId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: "balanced" });
		try {
			const before = [subgoalStep("p1", { phase: 1 })];
			await seedFrozenPlanInProc(gateway, goalId, before);
			// Crank replanCount up to 5 so the next mutation hits the cap.
			const ctx = (gateway as any).projectContextManager.getContextForGoal(goalId);
			ctx.goalStore.update(goalId, { replanCount: 5 });
			const after = [...before, subgoalStep("p2", { phase: 1, title: "leaf" })];
			const { status, body } = await patchPlan(goalId, { planSteps: after, replanReason: "more" });
			expect(status).toBe(409);
			expect(body.error).toBe("replan-cap");
			expect(body.replanCount).toBe(5);
		} finally { await deleteGoal(goalId); }
	});
});

test.describe("§4.3 decision matrix — POST /spawn-child", () => {
	test.beforeAll(async () => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await seedWorkflows(pid!);
	});

	// The synthetic subgoal step the server fabricates for spawn-child is at
	// phase=0. Two natural classifications fall out depending on the seed:
	//   - empty seed   → expansion (per the "empty before → always expansion"
	//                   special case in the classifier).
	//   - seed at phase=1 + new step at phase=0 → fix-up (added phase ≤ max).

	// Empty seed → expansion → prompt under all three policies.
	for (const policy of ["strict", "balanced", "autonomous"] as const) {
		test(`spawn-child empty-seed post-freeze under ${policy} → expansion 409 prompt`, async ({ gateway }) => {
			const parentId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			const viewer = await openWsViewer();
			try {
				// Frozen fixture's execution.verify is already []. Empty before → expansion.
				const { status, body } = await spawnChild(parentId, {
					title: "new branch",
					spec: "Branching the plan post-freeze.",
					workflowId: "general",
					planId: "empty-seed-1",
				});
				expect(status).toBe(409);
				expect(body.error).toBe("mutation-rejected");
				expect(body.classification).toBe("expansion");
				expect(body.requiresApproval).toBe(true);
				expect(body.policy).toBe(policy);
				expect(typeof body.requestId).toBe("string");
				await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === parentId);
				// No child created.
				const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
				const childGoals = ctx.goalStore.getAll().filter((g: any) => g.parentGoalId === parentId);
				expect(childGoals).toHaveLength(0);
			} finally {
				viewer.close();
				const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
				if (ctx) {
					for (const g of ctx.goalStore.getAll()) {
						if (g.parentGoalId === parentId) await deleteGoal(g.id);
					}
				}
				await deleteGoal(parentId);
			}
		});
	}

	test("spawn-child fix-up under strict → 409 prompt", async ({ gateway }) => {
		const parentId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: "strict" });
		const viewer = await openWsViewer();
		try {
			await seedFrozenPlanInProc(gateway, parentId, [subgoalStep("seed", { phase: 1 })]);
			const { status, body } = await spawnChild(parentId, {
				title: "leaf child",
				spec: "Adding a leaf at phase 0.",
				workflowId: "general",
				planId: "fix-up-strict-1",
			});
			expect(status).toBe(409);
			expect(body.classification).toBe("fix-up");
			expect(body.requiresApproval).toBe(true);
			await viewer.waitFor(m => m.type === "goal_mutation_pending" && m.goalId === parentId);
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			const childGoals = ctx.goalStore.getAll().filter((g: any) => g.parentGoalId === parentId);
			expect(childGoals).toHaveLength(0);
		} finally {
			viewer.close();
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			if (ctx) {
				for (const g of ctx.goalStore.getAll()) {
					if (g.parentGoalId === parentId) await deleteGoal(g.id);
				}
			}
			await deleteGoal(parentId);
		}
	});

	for (const policy of ["balanced", "autonomous"] as const) {
		test(`spawn-child fix-up under ${policy} → auto-approve (201 + child created)`, async ({ gateway }) => {
			const parentId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: policy });
			try {
				await seedFrozenPlanInProc(gateway, parentId, [subgoalStep("seed", { phase: 1 })]);
				const { status, body } = await spawnChild(parentId, {
					title: "leaf child",
					spec: "Adding a leaf at phase 0.",
					workflowId: "general",
					planId: `fix-up-${policy}-1`,
				});
				expect(status).toBe(201);
				expect(body.childGoalId).toBeTruthy();
				await deleteGoal(body.childGoalId);
			} finally { await deleteGoal(parentId); }
		});
	}

	test("spawn-child pre-freeze applies (no execution gate frozen)", async () => {
		// Fresh fixture — execution gate is not frozen. Matrix is bypassed
		// (any class except criteria-drop resolves to apply).
		const parentId = await createGoal({ workflowId: FRESH_WORKFLOW_ID, divergencePolicy: "strict" });
		try {
			const { status, body } = await spawnChild(parentId, {
				title: "first child",
				spec: "Some work",
				workflowId: "general",
				planId: "pre-freeze-1",
			});
			expect(status).toBe(201);
			expect(body.childGoalId).toBeTruthy();
			expect(body.planId).toBe("pre-freeze-1");
			await deleteGoal(body.childGoalId);
		} finally { await deleteGoal(parentId); }
	});

	test("spawn-child post-freeze criteria-drop → 409 reject (no buffer)", async ({ gateway }) => {
		const criterion = "QQQ-criterion-only-on-existing-step";
		const parentId = await createGoal({
			workflowId: FROZEN_WORKFLOW_ID,
			divergencePolicy: "balanced",
			spec: "# Root\nNo marker text here.\n",
		});
		try {
			// Seed: a step that covers the criterion.
			await seedFrozenPlanInProc(gateway, parentId, [
				subgoalStep("seed", { spec: `Covers ${criterion}.`, phase: 1 }),
			]);
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			ctx.goalStore.update(parentId, { acceptanceCriteria: [criterion] });
			// Spawn a NEW child whose spec doesn't mention the criterion.
			// Adherence check looks at the union of all surviving subgoal specs
			// in `after` — since seed's spec still covers it, criteria stays
			// covered. To force a drop, we modify the seed step in place via
			// ctx (simulating a replan that removed coverage). Easier:
			// use a fresh parent whose seed DOES NOT cover the criterion in
			// the first place — the classifier still reports expansion since
			// the new child also doesn't cover it, but the criterion is
			// uncovered AFTER the mutation.
			ctx.goalStore.update(parentId, {
				workflow: (() => {
					const g = ctx.goalStore.get(parentId);
					const ex = g.workflow.gates.find((x: any) => x.id === "execution");
					ex.verify = [subgoalStep("seed", { spec: "no marker.", phase: 1 })];
					return g.workflow;
				})(),
			});
			const { status, body } = await spawnChild(parentId, {
				title: "unrelated",
				spec: "still no marker.",
				workflowId: "general",
				planId: "criteria-drop-1",
			});
			expect(status).toBe(409);
			expect(body.error).toBe("mutation-rejected");
			expect(body.classification).toBe("criteria-drop");
			expect(body.requiresApproval).toBe(false);
			expect(body.droppedCriteria).toContain(criterion);
		} finally {
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			if (ctx) {
				for (const g of ctx.goalStore.getAll()) {
					if (g.parentGoalId === parentId) await deleteGoal(g.id);
				}
			}
			await deleteGoal(parentId);
		}
	});

	test("spawn-child post-freeze replanCount >= 5 → 409 replan-cap", async ({ gateway }) => {
		const parentId = await createGoal({ workflowId: FROZEN_WORKFLOW_ID, divergencePolicy: "balanced" });
		try {
			await seedFrozenPlanInProc(gateway, parentId, [subgoalStep("seed", { phase: 1 })]);
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			ctx.goalStore.update(parentId, { replanCount: 5 });
			const { status, body } = await spawnChild(parentId, {
				title: "extra child",
				spec: "more work",
				workflowId: "general",
				planId: "cap-1",
			});
			expect(status).toBe(409);
			expect(body.error).toBe("replan-cap");
			expect(body.replanCount).toBe(5);
		} finally {
			const ctx = (gateway as any).projectContextManager.getContextForGoal(parentId);
			if (ctx) {
				for (const g of ctx.goalStore.getAll()) {
					if (g.parentGoalId === parentId) await deleteGoal(g.id);
				}
			}
			await deleteGoal(parentId);
		}
	});
});

// User-feedback regression: a team-lead on a `feature`-workflow goal
// who calls `goal_plan_status` against the default `execution` gateId
// used to get the bare error `Gate "execution" not found in goal
// workflow`. The new shape includes `availableGateIds` so the team-lead
// can immediately see whether to retry against e.g. `implementation`
// or surface a workflow mismatch.
const FEATURE_NO_EXEC_WORKFLOW_ID = "feature-no-execution";

test.describe("plan 404 — missing gate surfaces availableGateIds", () => {
	test.beforeAll(async () => {
		// Need the existing FROZEN/FRESH workflows AND a feature-style workflow
		// without `execution` so we can hit the missing-gate branch.
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();
		await seedWorkflows(pid!);

		const featureLikeWorkflow = {
			id: FEATURE_NO_EXEC_WORKFLOW_ID,
			name: "Feature (no execution gate)",
			description: "Mimics built-in feature workflow shape — design-doc, implementation, ready-to-merge; no execution.",
			gates: [
				{ id: "design-doc", name: "Design Document", dependsOn: [], content: true },
				{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["implementation"] },
			],
		};
		// Re-PUT the project config WITH the existing fixture workflows from
		// `seedWorkflows` PLUS our new one. Mirrors the existing fixture's
		// PUT shape so we don't drop FRESH/FROZEN.
		const wfsResp = await apiFetch(`/api/workflows?projectId=${pid}`);
		const wfsBody = await wfsResp.json().catch(() => ({ workflows: [] }));
		const existing: any[] = Array.isArray(wfsBody.workflows) ? wfsBody.workflows : [];
		const mergedRecord: Record<string, unknown> = {};
		for (const w of existing) {
			if (w.id !== FEATURE_NO_EXEC_WORKFLOW_ID) mergedRecord[w.id] = w;
		}
		mergedRecord[FEATURE_NO_EXEC_WORKFLOW_ID] = featureLikeWorkflow;
		const putResp = await apiFetch(`/api/projects/${pid}/config`, {
			method: "PUT",
			body: JSON.stringify({ components: [TEST_DEFAULT_COMPONENT], workflows: mergedRecord }),
		});
		expect(putResp.status).toBe(200);
	});

	test("GET /api/goals/:id/plan 404 includes structured availableGateIds list", async () => {
		const goalId = await createGoal({
			workflowId: FEATURE_NO_EXEC_WORKFLOW_ID,
			divergencePolicy: "strict",
			titleHint: "plan-404-get",
		});
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/plan`);
			const body = await resp.json().catch(() => ({}));
			expect(resp.status).toBe(404);
			// Prose still names the missing gate.
			expect(body.error).toContain('Gate "execution" not found in goal workflow');
			// Prose embeds a hint listing the actual gates.
			expect(body.error).toContain("Available gates:");
			expect(body.error).toContain("design-doc");
			expect(body.error).toContain("implementation");
			expect(body.error).toContain("ready-to-merge");
			// Structured fields let tool extensions parse without regex.
			expect(body.gateId).toBe("execution");
			expect(Array.isArray(body.availableGateIds)).toBe(true);
			expect(body.availableGateIds).toEqual([
				"design-doc",
				"implementation",
				"ready-to-merge",
			]);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("PATCH /api/goals/:id/plan 404 mirrors the GET shape", async () => {
		const goalId = await createGoal({
			workflowId: FEATURE_NO_EXEC_WORKFLOW_ID,
			divergencePolicy: "strict",
			titleHint: "plan-404-patch",
		});
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/plan`, {
				method: "PATCH",
				body: JSON.stringify({ planSteps: [] }),
			});
			const body = await resp.json().catch(() => ({}));
			expect(resp.status).toBe(404);
			expect(body.error).toContain('Gate "execution" not found in goal workflow');
			expect(body.error).toContain("Available gates:");
			expect(body.gateId).toBe("execution");
			expect(body.availableGateIds).toEqual([
				"design-doc",
				"implementation",
				"ready-to-merge",
			]);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("explicit ?gateId=foo on a workflow that doesn't have `foo` returns same shape", async () => {
		// Sanity: the 404 path is gateId-agnostic. A team-lead targeting an
		// arbitrary gate (e.g. `goal-plan` on a feature workflow) gets the
		// same structured response.
		const goalId = await createGoal({
			workflowId: FEATURE_NO_EXEC_WORKFLOW_ID,
			divergencePolicy: "strict",
			titleHint: "plan-404-custom",
		});
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/plan?gateId=goal-plan`);
			const body = await resp.json().catch(() => ({}));
			expect(resp.status).toBe(404);
			expect(body.gateId).toBe("goal-plan");
			expect(body.availableGateIds).toEqual([
				"design-doc",
				"implementation",
				"ready-to-merge",
			]);
		} finally {
			await deleteGoal(goalId);
		}
	});
});
