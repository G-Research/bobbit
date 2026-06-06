/**
 * Phase 4 — `PATCH /api/goals/:id/plan` decision-matrix coverage.
 *
 * The classifier itself is tested in plan-mutation.test.ts. Here we
 * exercise the handler-level decision matrix: how (kind × policy ×
 * paused) maps to {applied | requiresApproval | 409}. We simulate the
 * handler's branches in-process so the tests run as fast unit tests
 * without an HTTP server.
 *
 * Decision matrix (SUBGOALS-SPEC §3.6, binding):
 *   noop              → applied (any policy)
 *   fix-up + balanced → applied
 *   fix-up + autonomous → applied
 *   fix-up + strict   → requires approval
 *   expansion         → requires approval (any policy)
 *   restructure + paused      → requires approval
 *   restructure + !paused     → 409
 *   criteria-drop     → 409 (any policy)
 *
 * Plus: replanCount > 5 → auto-pause on approve.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyMutation, type ClassifierPlanStep, type MutationKind } from "../src/server/agent/plan-mutation.ts";
import { PlanMutationStore, DEFAULT_MUTATION_TTL_MS, type PendingMutation } from "../src/server/agent/plan-mutation-store.ts";
import { tryHandleNestedGoalRoute } from "../src/server/agent/nested-goal-routes.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";
import { randomUUID } from "node:crypto";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mutation-api-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir);
});

type Verdict =
	| { kind: MutationKind; applied: true }
	| { kind: MutationKind; requiresApproval: true; requestId: string }
	| { kind: MutationKind; status: 409; uncoveredCriteria?: string[] };

interface GoalShape {
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	paused?: boolean;
	replanCount?: number;
}

/** Mirror of the handler's decision matrix. */
function planMutationVerdict(
	current: ClassifierPlanStep[],
	proposed: ClassifierPlanStep[],
	rootSpec: string,
	criteria: string[],
	goal: GoalShape,
	store: PlanMutationStore,
	goalId: string,
): Verdict {
	const v = classifyMutation({ current, proposed, rootAcceptanceCriteria: criteria, rootSpec });
	const policy = goal.divergencePolicy ?? "balanced";
	if (v.kind === "criteria-drop") return { kind: v.kind, status: 409, uncoveredCriteria: v.uncoveredCriteria };
	if (v.kind === "restructure" && !goal.paused) return { kind: v.kind, status: 409 };
	if (v.kind === "noop") return { kind: v.kind, applied: true };
	if (v.kind === "fix-up" && (policy === "balanced" || policy === "autonomous")) return { kind: v.kind, applied: true };
	// expansion always; restructure on paused; fix-up on strict → approval.
	const requestId = randomUUID();
	const now = Date.now();
	const pending: PendingMutation = {
		goalId,
		requestId,
		kind: v.kind,
		proposedSteps: proposed,
		summary: v.summary,
		diff: v.diff,
		createdAt: now,
		expiresAt: now + DEFAULT_MUTATION_TTL_MS,
	};
	store.put(pending);
	return { kind: v.kind, requiresApproval: true, requestId };
}

function step(planId: string, phase: number, spec = `spec-${planId}`, title = `t-${planId}`): ClassifierPlanStep {
	return { planId, phase, spec, title, subgoal: { planId, title, spec } };
}

describe("plan-mutation decision matrix", () => {
	it("noop applied", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const r = planMutationVerdict(cur, cur, "", [], {}, store, "g1");
		assert.equal(r.kind, "noop");
		assert.equal((r as any).applied, true);
	});

	it("fix-up under balanced → applied", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const next = [...cur, step("b", 1)];
		const r = planMutationVerdict(cur, next, "", [], { divergencePolicy: "balanced" }, store, "g1");
		assert.equal(r.kind, "fix-up");
		assert.equal((r as any).applied, true);
	});

	it("fix-up under autonomous → applied", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const next = [...cur, step("b", 1)];
		const r = planMutationVerdict(cur, next, "", [], { divergencePolicy: "autonomous" }, store, "g1");
		assert.equal((r as any).applied, true);
	});

	it("fix-up under strict → requires approval (request stored)", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const next = [...cur, step("b", 1)];
		const r = planMutationVerdict(cur, next, "", [], { divergencePolicy: "strict" }, store, "g1");
		assert.equal(r.kind, "fix-up");
		assert.equal((r as any).requiresApproval, true);
		const reqId = (r as any).requestId as string;
		assert.ok(store.get("g1", reqId));
	});

	it("expansion always requires approval (any policy)", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const next = [...cur, step("b", 2)]; // phase 2 > max(current.phase) = 1.
		for (const policy of ["strict", "balanced", "autonomous"] as const) {
			const r = planMutationVerdict(cur, next, "", [], { divergencePolicy: policy }, store, `g-${policy}`);
			assert.equal(r.kind, "expansion");
			assert.equal((r as any).requiresApproval, true, `${policy}: expansion must always require approval`);
		}
	});

	it("restructure on non-paused goal → 409", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1), step("b", 2)];
		const next = [step("a", 1)]; // b removed.
		const r = planMutationVerdict(cur, next, "", [], { paused: false }, store, "g1");
		assert.equal(r.kind, "restructure");
		assert.equal((r as any).status, 409);
	});

	it("restructure on paused goal → requires approval", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1), step("b", 2)];
		const next = [step("a", 1)];
		const r = planMutationVerdict(cur, next, "", [], { paused: true }, store, "g1");
		assert.equal(r.kind, "restructure");
		assert.equal((r as any).requiresApproval, true);
	});

	it("criteria-drop always 409 (no policy override)", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1, "")];
		const next = [step("a", 1, ""), step("b", 1, "unrelated")];
		for (const policy of ["strict", "balanced", "autonomous"] as const) {
			const r = planMutationVerdict(cur, next, "", ["foo"], { divergencePolicy: policy }, store, `g-${policy}`);
			assert.equal(r.kind, "criteria-drop");
			assert.equal((r as any).status, 409);
		}
	});

	it("auto-pause on replanCount > 5 (the handler flips paused on approve)", () => {
		// Mirror the handler approve logic.
		const goal: GoalShape = { replanCount: 5, paused: false };
		const newReplanCount = (goal.replanCount ?? 0) + 1;
		const updates: { replanCount: number; paused?: boolean } = { replanCount: newReplanCount };
		if (newReplanCount > 5 && !goal.paused) updates.paused = true;
		assert.equal(updates.replanCount, 6);
		assert.equal(updates.paused, true);

		// At replanCount 4 → 5 (not over), no auto-pause.
		const goal2: GoalShape = { replanCount: 4, paused: false };
		const next2 = (goal2.replanCount ?? 0) + 1;
		const u2: { replanCount: number; paused?: boolean } = { replanCount: next2 };
		if (next2 > 5 && !goal2.paused) u2.paused = true;
		assert.equal(u2.replanCount, 5);
		assert.equal(u2.paused, undefined);
	});

	it("approve flow: requestId resolves and request is removed on apply", () => {
		const store = new PlanMutationStore(stateDir);
		const cur = [step("a", 1)];
		const next = [...cur, step("b", 2)];
		const r = planMutationVerdict(cur, next, "", [], { divergencePolicy: "balanced" }, store, "g1");
		const reqId = (r as any).requestId as string;
		assert.ok(store.get("g1", reqId));
		// Mirror approve:
		assert.equal(store.remove("g1", reqId), true);
		assert.equal(store.get("g1", reqId), undefined);
	});
});

/**
 * Gov-1 regression — direct fix-up replans must trip the SAME replan-overflow
 * auto-pause as the approval path. Previously the balanced/autonomous direct
 * apply only bumped replanCount and skipped the `replanCount > 5` auto-pause.
 *
 * These drive the REAL `tryHandleNestedGoalRoute` PATCH /plan handler with
 * mocked deps so the test catches a regression in the shared-helper wiring,
 * not just the decision matrix.
 *
 * Auth: the goal has a team-lead (teamManager.getTeamState → teamLeadSessionId)
 * and the request carries a matching `X-Bobbit-Spawning-Session` header, so the
 * call authenticates legitimately as the goal's team-lead regardless of any
 * concurrent authz tightening (no cookie / human path relied upon).
 */
describe("Gov-1: direct fix-up auto-pause via PATCH /plan handler", () => {
	const TEAM_LEAD = "tl-session-abc";

	function buildGoal(replanCount: number): any {
		const goalId = "g-" + randomUUID().slice(0, 8);
		return {
			id: goalId,
			rootGoalId: goalId,
			workflowId: "parent",
			spec: "",
			acceptanceCriteria: [],
			divergencePolicy: "balanced",
			paused: false,
			replanCount,
			workflow: {
				id: "parent",
				gates: [
					{
						id: "execution",
						verify: [
							{ name: "s-a", type: "subgoal", phase: 1, subgoal: { planId: "a", title: "t-a", spec: "spec-a" } },
						],
					},
				],
			},
		};
	}

	async function patchPlanFixup(
		goal: any,
		callerHeader: string | undefined,
	): Promise<{ responses: { body: any; status: number }[] }> {
		const goalManager: any = {
			updateGoal: async (_id: string, partial: any) => { Object.assign(goal, partial); },
			getGoalStore: () => ({ update: (_id: string, partial: any) => { Object.assign(goal, partial); } }),
		};
		const ctx: any = {
			goalStore: { get: () => goal, getAll: () => [goal] },
			planMutationStore: new PlanMutationStore(stateDir),
			goalManager,
			gateStore: { getGate: () => ({ status: "pending" }) },
			workflowStore: {},
		};
		const responses: { body: any; status: number }[] = [];
		const deps: any = {
			projectContextManager: { getContextForGoal: () => ctx },
			verificationHarness: {
				getActiveVerifications: () => [],
				cancelStaleVerifications: async () => {},
				resolvePlanStepChild: () => ({}),
			},
			teamManager: { getTeamState: () => ({ teamLeadSessionId: TEAM_LEAD }) },
			sessionManager: { getAllSessionsRaw: () => [], abortSessionTurn: async () => {} },
			cookieStore: new CookieStore(stateDir),
			requireSubgoalsEnabled: () => true,
			getGoalAcrossProjects: () => goal,
			getGoalManagerForGoal: () => goalManager,
			readBody: async () => ({ proposedSteps: [step("a", 1), step("b", 1)] }),
			json: (body: any, status = 200) => { responses.push({ body, status }); },
			jsonError: (status: number, err: unknown) => { responses.push({ body: { error: String(err) }, status }); },
			broadcastToAll: () => {},
			getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 3 }),
		};
		const req: any = {
			method: "PATCH",
			headers: callerHeader ? { "x-bobbit-spawning-session": callerHeader } : {},
		};
		const url = new URL(`http://x/api/goals/${goal.id}/plan`);
		const handled = await tryHandleNestedGoalRoute(req, url, deps);
		assert.equal(handled, true);
		return { responses };
	}

	it("balanced fix-up at replanCount===5 → replanCount 6 AND goal paused", async () => {
		const goal = buildGoal(5);
		const { responses } = await patchPlanFixup(goal, TEAM_LEAD);
		const last = responses.at(-1)!;
		assert.equal(last.status, 200);
		assert.equal(last.body.kind, "fix-up");
		assert.equal(last.body.applied, true);
		assert.equal(last.body.replanCount, 6);
		assert.equal(last.body.autoPaused, true);
		assert.equal(goal.replanCount, 6);
		assert.equal(goal.paused, true);
	});

	it("balanced fix-up at replanCount===4 → replanCount 5, NOT paused", async () => {
		const goal = buildGoal(4);
		const { responses } = await patchPlanFixup(goal, TEAM_LEAD);
		const last = responses.at(-1)!;
		assert.equal(last.status, 200);
		assert.equal(last.body.replanCount, 5);
		assert.equal(last.body.autoPaused, false);
		assert.equal(goal.replanCount, 5);
		assert.equal(goal.paused, false);
	});

	it("non-team-lead caller (wrong header) is rejected 403 — no replan applied", async () => {
		const goal = buildGoal(5);
		const { responses } = await patchPlanFixup(goal, "not-the-team-lead");
		const last = responses.at(-1)!;
		assert.equal(last.status, 403);
		assert.equal(last.body.code, "NOT_TEAM_LEAD");
		assert.equal(goal.replanCount, 5);
		assert.equal(goal.paused, false);
	});
});
