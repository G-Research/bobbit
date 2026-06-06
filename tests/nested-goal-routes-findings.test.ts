/**
 * Implementation-gate remediation findings on the nested-goal REST surface.
 * Drives `tryHandleNestedGoalRoute` directly with in-memory stubs (same
 * pattern as goal-spawn-child-dependsOn-blocking.test.ts).
 *
 *   G2/C1 — an explicit `workflowId` on spawn-child OVERRIDES the inherited
 *           parent workflow snapshot (previously the inline resolver
 *           preferred parent.workflow and dropped the caller's override).
 *           PATCH /plan preserves a step's TOP-LEVEL workflowId/suggestedRole
 *           into the stored execution plan.
 *   C2/C4 — PATCH /policy integer-normalises maxConcurrentChildren and
 *           resizes the cached per-root subgoal semaphore.
 *   S1    — mutating Children endpoints reject a caller whose
 *           X-Bobbit-Spawning-Session does not match the goal's team-lead;
 *           the team-lead and header-less (human/UI) calls are allowed.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GateStore } from "../src/server/agent/gate-store.ts";
import { PlanMutationStore } from "../src/server/agent/plan-mutation-store.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { tryHandleNestedGoalRoute, type NestedGoalRouteDeps } from "../src/server/agent/nested-goal-routes.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";

interface Harness {
	tmpRoot: string;
	goalStore: GoalStore;
	goalManager: GoalManager;
	parent: PersistedGoal;
	resizeCalls: Array<{ rootGoalId: string; newMax: number }>;
	teamLeadByGoal: Record<string, string | null>;
	/** A valid `bobbit_session` cookie header value for the human/UI path. */
	humanCookieHeader: string;
	cleanup(): void;
	call(
		method: string,
		pathname: string,
		body?: unknown,
		headers?: Record<string, string | string[] | undefined>,
	): Promise<{ status: number; payload: any }>;
}

async function makeHarness(): Promise<Harness> {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nested-findings-"));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	const goalStore = new GoalStore(stateDir);
	const cookieStore = new CookieStore(stateDir);
	const humanCookieHeader = `bobbit_session=${cookieStore.mint()}`;
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{
			id: "feature", name: "Feature", description: "",
			gates: [
				{ id: "implementation", name: "Implementation", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
			],
			createdAt: 0, updatedAt: 0,
		},
		{
			id: "parent", name: "Parent", description: "",
			gates: [
				{ id: "execution", name: "Execution", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["execution"] },
			],
			createdAt: 0, updatedAt: 0,
		},
	]);
	const goalManager = new GoalManager(goalStore, wf);
	const gateStore = new GateStore(stateDir);
	const planMutationStore = new PlanMutationStore(stateDir, { startSweep: false });

	const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "parent" });

	// No-op heavy side effects.
	(goalManager as any).setupWorktreeAndStartTeam = async (gid: string) => {
		await goalManager.updateGoal(gid, { setupStatus: "ready" } as any);
	};

	const resizeCalls: Array<{ rootGoalId: string; newMax: number }> = [];
	const teamLeadByGoal: Record<string, string | null> = {};

	const ctx = {
		goalStore, goalManager, gateStore, workflowStore: wf,
		planMutationStore,
		project: { id: "p" } as any,
		projectConfigStore: cfg,
	};
	const projectContextManager: any = {
		getContextForGoal: () => ctx,
		all: () => [ctx],
	};
	const teamManager: any = {
		startTeam: async () => ({}),
		teardownTeam: async () => {},
		getTeamState: (gid: string) =>
			gid in teamLeadByGoal ? { teamLeadSessionId: teamLeadByGoal[gid] } : undefined,
	};
	const sessionManager: any = {
		getSession: () => undefined,
		deliverLiveSteer: async () => {},
		enqueuePrompt: async () => {},
		getAllSessionsRaw: () => [],
		abortSessionTurn: async () => {},
	};
	const verificationHarness: any = {
		getActiveVerifications: () => [],
		cancelStaleVerifications: async () => {},
		resolvePlanStepChild: () => ({ source: "none", child: undefined }),
		resizeRootSubgoalSemaphore: (rootGoalId: string, newMax: number) => {
			resizeCalls.push({ rootGoalId, newMax });
			return true;
		},
	};

	const deps: NestedGoalRouteDeps = {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		cookieStore,
		requireSubgoalsEnabled: () => true,
		getGoalAcrossProjects: (gid) => goalStore.get(gid),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {},
		jsonError: () => {},
		broadcastToAll: () => {},
		getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	};

	async function call(
		method: string,
		pathname: string,
		body?: unknown,
		headers: Record<string, string | string[] | undefined> = {},
	): Promise<{ status: number; payload: any }> {
		let status = 200;
		let payload: any = undefined;
		const localDeps: NestedGoalRouteDeps = {
			...deps,
			json: (b, s) => { status = s ?? 200; payload = b; },
			jsonError: (s, err, extra) => { status = s; payload = { error: String((err as any)?.message ?? err), ...(extra ?? {}) }; },
		};
		const req = { method, headers, _body: body } as any as http.IncomingMessage;
		const url = new URL(`http://x${pathname}`);
		const handled = await tryHandleNestedGoalRoute(req, url, localDeps);
		if (!handled) throw new Error(`route not handled: ${method} ${pathname}`);
		return { status, payload };
	}

	return {
		tmpRoot, goalStore, goalManager, parent, resizeCalls, teamLeadByGoal,
		humanCookieHeader,
		cleanup() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} },
		call,
	};
}

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });

// spawn-child / plan PATCH / policy are ORCHESTRATION-class endpoints: the
// cookie does NOT bypass, so these tests authorize as the goal's team-lead via
// a matching X-Bobbit-Spawning-Session header. (Operator-class endpoints —
// pause/resume/decision/archive — keep the cookie; covered separately below.)
const TL = "tl-session";
const tlHeaders = { "x-bobbit-spawning-session": TL };

describe("G2/C1 — spawn-child workflow override", () => {
	it("an explicit workflowId overrides the inherited parent workflow snapshot", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "p-wf",
			title: "Child with explicit workflow",
			spec: "Child spec: this child explicitly requests the 'feature' workflow, overriding the parent's 'parent' meta-workflow snapshot.",
			workflowId: "feature",
		}, tlHeaders);
		assert.equal(r.status, 201);
		const child = h.goalStore.get(r.payload.id)!;
		assert.equal(child.workflowId, "feature", "child must adopt the explicitly-requested workflow id");
		// The child must NOT inherit the parent's execution-gated meta-workflow.
		assert.equal(child.workflow?.id, "feature");
		assert.equal(child.workflow?.gates.some(g => g.id === "execution"), false,
			"child must not carry the parent's execution gate when overriding");
	});

	it("inherits the parent workflow (stripped) when no workflowId is given", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "p-inherit",
			title: "Inheriting child",
			spec: "Child spec: no explicit workflow, so it should inherit the parent's snapshot with parent-only subgoal steps stripped.",
		}, tlHeaders);
		assert.equal(r.status, 201);
		const child = h.goalStore.get(r.payload.id)!;
		assert.equal(child.workflowId, "parent", "child inherits the parent workflow id by default");
	});
});

describe("G2/C1 — PATCH /plan preserves top-level workflowId + suggestedRole", () => {
	it("stores a proposed step's top-level workflowId/suggestedRole in execution.verify[]", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/plan`, {
			proposedSteps: [
				{
					planId: "s1",
					title: "Step 1",
					spec: "Step one spec describing the work for the first child in the plan in enough detail.",
					workflowId: "feature",
					suggestedRole: "test-engineer",
					phase: 0,
				},
			],
		}, tlHeaders);
		// Empty current plan + one added step at phase 0 → fix-up, applied under balanced.
		assert.equal(r.status, 200, JSON.stringify(r.payload));
		assert.equal(r.payload.applied, true);
		const stored = h.goalStore.get(h.parent.id)!;
		const execGate = stored.workflow!.gates.find(g => g.id === "execution")!;
		const step = execGate.verify!.find(v => v.subgoal?.planId === "s1")!;
		assert.equal(step.subgoal?.workflowId, "feature", "top-level workflowId must survive into the stored plan");
		assert.equal(step.subgoal?.suggestedRole, "test-engineer", "top-level suggestedRole must survive into the stored plan");
	});
});

describe("PATCH /plan — rejects duplicate planIds (400 DUPLICATE_PLAN_ID)", () => {
	it("returns 400 DUPLICATE_PLAN_ID when two proposed steps share a planId", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/plan`, {
			proposedSteps: [
				{
					planId: "dup",
					title: "Step A",
					spec: "Step A spec describing the work for the first child in the plan in enough detail to pass validation.",
					phase: 0,
				},
				{
					planId: "dup",
					title: "Step B",
					spec: "Step B spec describing the work for the second child — same planId must be rejected, not collapsed.",
					phase: 0,
				},
			],
		}, tlHeaders);
		assert.equal(r.status, 400, JSON.stringify(r.payload));
		assert.equal(r.payload.code, "DUPLICATE_PLAN_ID");
		assert.equal(r.payload.planId, "dup");
		// The duplicate must NOT have been persisted into the plan.
		const stored = h.goalStore.get(h.parent.id)!;
		const execGate = stored.workflow!.gates.find(g => g.id === "execution");
		const verifyLen = execGate?.verify?.length ?? 0;
		assert.equal(verifyLen, 0, "no plan step should be persisted when validation fails");
	});
});

describe("C2/C4 — PATCH /policy integer clamp + live semaphore resize", () => {
	it("floors a fractional maxConcurrentChildren and resizes the cached semaphore", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/policy`, { maxConcurrentChildren: 1.5 }, tlHeaders);
		assert.equal(r.status, 200);
		assert.equal(h.goalStore.get(h.parent.id)!.maxConcurrentChildren, 1, "1.5 must be floored to 1");
		assert.equal(h.resizeCalls.length, 1, "the cached root semaphore must be resized");
		assert.deepEqual(h.resizeCalls[0], { rootGoalId: h.parent.id, newMax: 1 });
	});

	it("rejects a value that floors below 1", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/policy`, { maxConcurrentChildren: 0.5 }, tlHeaders);
		assert.equal(r.status, 400);
		assert.equal(h.resizeCalls.length, 0);
	});

	it("does not resize when only divergencePolicy changes", async () => {
		h.teamLeadByGoal[h.parent.id] = TL;
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/policy`, { divergencePolicy: "strict" }, tlHeaders);
		assert.equal(r.status, 200);
		assert.equal(h.resizeCalls.length, 0);
	});
});

describe("S1 — ORCHESTRATION authorization on spawn-child / policy (cookie does NOT bypass)", () => {
	it("REJECTS a human/UI cookie-only spawn-child with 403 NOT_TEAM_LEAD (orchestration: cookie does NOT bypass)", async () => {
		// spawn-child is an orchestration verb. The cookie is mintable by any
		// holder of the shared admin token, so it must NOT authorize an
		// orchestration mutation — only a team-lead-matching header does.
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "ui-spawn",
			title: "UI spawned",
			spec: "A human/UI cookie must NOT spawn children — orchestration is team-lead-only and the cookie does not bypass.",
		}, { cookie: h.humanCookieHeader });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
	});

	it("rejects a header-less, cookie-less caller with 403 NOT_TEAM_LEAD (closes the absent-header bypass)", async () => {
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "bypass-spawn",
			title: "Bypass attempt",
			spec: "An agent that simply omits the spawning-session header must NOT be treated as a trusted human anymore.",
		}); // no headers, no cookie
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
	});

	it("allows the team-lead (matching X-Bobbit-Spawning-Session)", async () => {
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "tl-spawn",
			title: "TL spawned",
			spec: "Spawned by the parent goal's team-lead agent via the children tool extension with a matching header.",
		}, { "x-bobbit-spawning-session": "tl-session" });
		assert.equal(r.status, 201);
	});

	it("rejects a non-team-lead caller with 403 NOT_TEAM_LEAD", async () => {
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "rogue-spawn",
			title: "Rogue spawned",
			spec: "An unrelated agent with gateway credentials should NOT be able to spawn children under this goal.",
		}, { "x-bobbit-spawning-session": "some-other-agent" });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
	});

	it("rejects a non-team-lead caller on PATCH /policy", async () => {
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("PATCH", `/api/goals/${h.parent.id}/policy`,
			{ maxConcurrentChildren: 2 },
			{ "x-bobbit-spawning-session": "intruder" });
		assert.equal(r.status, 403);
		assert.equal(h.resizeCalls.length, 0, "no side effect on rejected policy change");
	});

	it("rejects a non-human caller on a teamless goal with 403 NOT_TEAM_LEAD", async () => {
		// No entry in teamLeadByGoal → getTeamState returns undefined. A teamless
		// goal has no legitimate agent caller, so a forged header is denied.
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "no-team",
			title: "No-team spawn",
			spec: "A teamless goal has nothing to match against, so a non-human caller with a forged header must be denied.",
		}, { "x-bobbit-spawning-session": "whoever" });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
	});

	it("REJECTS a human/UI cookie on a teamless goal (orchestration: cookie does NOT bypass) → 403", async () => {
		// No entry in teamLeadByGoal → getTeamState returns undefined. Even a
		// verified cookie cannot spawn children — orchestration is team-lead-only.
		const r = await h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId: "no-team-human",
			title: "No-team human spawn",
			spec: "A human/UI cookie must NOT spawn children on a teamless goal — orchestration is team-lead-only.",
		}, { cookie: h.humanCookieHeader });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
	});
});

describe("S1 — OPERATOR authorization on pause (cookie IS accepted)", () => {
	it("allows a human/UI cookie to pause (operator verb) → 200", async () => {
		// pause is an operator verb the web UI drives, so the verified cookie
		// authorizes it even with no team-lead established.
		const r = await h.call("POST", `/api/goals/${h.parent.id}/pause`, { cascade: false }, { cookie: h.humanCookieHeader });
		assert.equal(r.status, 200, JSON.stringify(r.payload));
		assert.equal(h.goalStore.get(h.parent.id)!.paused, true, "the goal must be paused");
	});

	it("rejects a non-team-lead agent caller pausing (no cookie, mismatched header) → 403", async () => {
		h.teamLeadByGoal[h.parent.id] = "tl-session";
		const r = await h.call("POST", `/api/goals/${h.parent.id}/pause`, { cascade: false }, { "x-bobbit-spawning-session": "intruder" });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "NOT_TEAM_LEAD");
		assert.notEqual(h.goalStore.get(h.parent.id)!.paused, true, "a rejected pause must not change state");
	});
});
