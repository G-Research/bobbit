/**
 * Finding 2 — the per-root concurrency cap must be THE single scheduler for
 * ALL child-team start paths, not just the harness. These tests drive the REST
 * surface (`tryHandleNestedGoalRoute`) with a REAL `ChildTeamScheduler` wired
 * into the `verificationHarness` stub (exactly as production wires the harness's
 * scheduler) and assert:
 *
 *   - cap=1 + several `goal_spawn_child` calls → only ONE team starts; the rest
 *     are created capacity-blocked (`state='blocked'`, `capacityBlocked:true`)
 *     and enqueued. A merge (integrate-child) releases the permit and starts the
 *     next one. Peak concurrent teams never exceeds the cap.
 *   - integrate-child auto-unblock of SEVERAL dependents respects the cap: one
 *     merge that satisfies multiple dependents starts only `cap` of them at once.
 *
 * Mirrors the in-memory harness pattern from nested-goal-routes-findings.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
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
import { ChildTeamScheduler } from "../src/server/agent/child-team-scheduler.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";
import { SessionSecretStore } from "../src/server/auth/session-secret.ts";

const TL = "tl-session";

interface Harness {
	tmpRoot: string;
	goalStore: GoalStore;
	goalManager: GoalManager;
	parent: PersistedGoal;
	started: string[];
	peak: () => number;
	scheduler: ChildTeamScheduler;
	teamLeadByGoal: Record<string, string | null>;
	authAs(sessionId: string): Record<string, string>;
	cleanup(): void;
	call(method: string, pathname: string, body?: unknown, headers?: Record<string, string | string[] | undefined>): Promise<{ status: number; payload: any }>;
}

async function makeHarness(cap: number): Promise<Harness> {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nested-conc-"));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	const goalStore = new GoalStore(stateDir);
	const cookieStore = new CookieStore(stateDir);
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
	]);
	const goalManager = new GoalManager(goalStore, wf);
	const gateStore = new GateStore(stateDir);
	const planMutationStore = new PlanMutationStore(stateDir, { startSweep: false });

	const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
	goalStore.update(parent.id, { maxConcurrentChildren: cap } as any);

	// createGoal stamps setupStatus='preparing' for children so the route's
	// "would start a team" branch fires (the non-git tmp cwd would otherwise
	// resolve to 'ready' and skip the start path entirely).
	const realCreate = goalManager.createGoal.bind(goalManager);
	(goalManager as any).createGoal = async (title: string, cwd: string, opts?: any) => {
		const g = await realCreate(title, cwd, opts);
		if (opts?.parentGoalId) {
			goalStore.update(g.id, { setupStatus: "preparing" } as any);
			return goalStore.get(g.id)!;
		}
		return g;
	};
	// mergeChild is a git op — stub a clean merge.
	(goalManager as any).mergeChild = async () => ({ merged: true, alreadyMerged: false, conflict: false, pushed: false, output: "" });

	const started: string[] = [];
	const running = new Set<string>();
	let peak = 0;

	const scheduler = new ChildTeamScheduler({
		resolveCap: (rootGoalId) => goalManager.resolveRootMaxConcurrentChildren(rootGoalId),
		getChild: (childGoalId) => goalStore.get(childGoalId),
		startChildTeam: (childGoalId) => {
			started.push(childGoalId);
			running.add(childGoalId);
			peak = Math.max(peak, running.size);
			// Simulate the scheduler's real closure flipping blocked→todo.
			const g = goalStore.get(childGoalId);
			if (g?.state === "blocked") goalStore.update(childGoalId, { state: "todo" } as any);
		},
	});

	const teamLeadByGoal: Record<string, string | null> = {};
	const ctx = {
		goalStore, goalManager, gateStore, workflowStore: wf, planMutationStore,
		project: { id: "p" } as any, projectConfigStore: cfg,
	};
	const projectContextManager: any = { getContextForGoal: () => ctx, all: () => [ctx] };
	const teamManager: any = {
		startTeam: async () => ({}),
		teardownTeam: async () => {},
		getTeamState: (gid: string) => (gid in teamLeadByGoal ? { teamLeadSessionId: teamLeadByGoal[gid] } : undefined),
	};
	const sessionSecretStore = new SessionSecretStore();
	const sessionManager: any = {
		getSession: () => undefined, deliverLiveSteer: async () => {}, enqueuePrompt: async () => {},
		getAllSessionsRaw: () => [], abortSessionTurn: async () => {}, sessionSecretStore,
	};
	const verificationHarness: any = {
		getActiveVerifications: () => [],
		cancelStaleVerifications: async () => {},
		resolvePlanStepChild: () => ({ source: "none", child: undefined }),
		resizeRootSubgoalSemaphore: (rootGoalId: string, newMax: number) => scheduler.resize(rootGoalId, newMax),
		// The two seams Finding 2 routes through:
		requestChildStart: (childGoalId: string) => scheduler.requestStart(childGoalId),
		notifyChildTerminal: (childGoalId: string) => {
			running.delete(childGoalId);
			scheduler.notifyTerminal(childGoalId);
		},
	};

	const deps: NestedGoalRouteDeps = {
		projectContextManager, verificationHarness, teamManager, sessionManager, cookieStore,
		requireSubgoalsEnabled: () => true,
		getGoalAcrossProjects: (gid) => goalStore.get(gid),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {}, jsonError: () => {}, broadcastToAll: () => {},
		getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	};

	async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string | string[] | undefined> = {}) {
		let status = 200; let payload: any;
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
		tmpRoot, goalStore, goalManager, parent, started, peak: () => peak, scheduler, teamLeadByGoal,
		authAs: (sessionId: string) => ({
			"x-bobbit-spawning-session": sessionId,
			"x-bobbit-session-secret": sessionSecretStore.getOrCreateSecret(sessionId),
		}),
		cleanup() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} },
		call,
	};
}

let h: Harness;
afterEach(() => h?.cleanup());

describe("Finding 2 — REST spawn-child respects the per-root concurrency cap (cap=1)", () => {
	beforeEach(async () => { h = await makeHarness(1); h.teamLeadByGoal[h.parent.id] = TL; });

	async function spawn(planId: string, extra: Record<string, unknown> = {}) {
		return h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId, title: `Child ${planId}`,
			spec: `Child ${planId}: implement and verify the slice of work described in the parent goal spec for this plan.`,
			...extra,
		}, h.authAs(TL));
	}

	it("only one of three spawn-child calls starts a team; the rest are capacity-blocked", async () => {
		const r1 = await spawn("p1");
		const r2 = await spawn("p2");
		const r3 = await spawn("p3");

		assert.equal(r1.status, 201);
		assert.equal(r2.status, 201);
		assert.equal(r3.status, 201);
		assert.equal(r1.payload.capacityBlocked, undefined, "first child starts (not capacity-blocked)");
		assert.equal(r2.payload.capacityBlocked, true, "second child is capacity-blocked");
		assert.equal(r3.payload.capacityBlocked, true, "third child is capacity-blocked");

		assert.equal(h.started.length, 1, "exactly one team started under cap=1");
		// The capacity-blocked children are parked state='blocked'.
		assert.equal(h.goalStore.get(r2.payload.id)!.state, "blocked");
		assert.equal(h.goalStore.get(r3.payload.id)!.state, "blocked");
		assert.equal(h.scheduler.pendingCount(h.parent.id), 2);
		assert.equal(h.peak(), 1);
	});

	it("a merge (integrate-child) releases the permit and starts the next queued child", async () => {
		const r1 = await spawn("p1");
		const r2 = await spawn("p2");
		const r3 = await spawn("p3");
		assert.equal(h.started.length, 1);
		const firstStarted = h.started[0];

		// Merge the running child → releases the permit → next queued starts.
		const m = await h.call("POST", `/api/goals/${h.parent.id}/integrate-child/${firstStarted}`, { force: true }, h.authAs(TL));
		assert.equal(m.payload.merged, true);
		assert.equal(h.started.length, 2, "merging the running child admits exactly one more");

		// Merge the second → the third (last queued) starts.
		const secondStarted = h.started[1];
		const m2 = await h.call("POST", `/api/goals/${h.parent.id}/integrate-child/${secondStarted}`, { force: true }, h.authAs(TL));
		assert.equal(m2.payload.merged, true);
		assert.equal(h.started.length, 3);
		assert.equal(h.scheduler.pendingCount(h.parent.id), 0);

		// All three IDs are distinct and peak concurrency never exceeded the cap.
		assert.equal(new Set([r1.payload.id, r2.payload.id, r3.payload.id]).size, 3);
		assert.equal(h.peak(), 1, "peak concurrent teams must never exceed cap=1");
	});
});

describe("Finding 2 — integrate-child auto-unblock of several dependents respects the cap (cap=1)", () => {
	beforeEach(async () => { h = await makeHarness(1); h.teamLeadByGoal[h.parent.id] = TL; });

	async function spawn(planId: string, extra: Record<string, unknown> = {}) {
		return h.call("POST", `/api/goals/${h.parent.id}/spawn-child`, {
			planId, title: `Child ${planId}`,
			spec: `Child ${planId}: implement and verify the slice of work described in the parent goal spec for this plan.`,
			...extra,
		}, h.authAs(TL));
	}

	it("one merge that satisfies two dependents starts only ONE of them; the other stays parked", async () => {
		// c1 (no deps) starts immediately under cap=1.
		const c1 = await spawn("p1");
		assert.equal(h.started.length, 1);
		// c2, c3 both depend on p1 → created deps-blocked (not capacity-blocked,
		// not started). They carry dependsOnPlanIds=[p1].
		const c2 = await spawn("p2", { dependsOn: ["p1"] });
		const c3 = await spawn("p3", { dependsOn: ["p1"] });
		assert.equal(c2.payload.blocked, true);
		assert.equal(c3.payload.blocked, true);
		assert.equal(h.started.length, 1, "deps-blocked children do not start");

		// Merge c1 → both c2 and c3 become dep-satisfied, but the cap=1 must
		// admit only ONE; the other parks capacity-blocked.
		await h.call("POST", `/api/goals/${h.parent.id}/integrate-child/${c1.payload.id}`, { force: true }, h.authAs(TL));
		assert.equal(h.started.length, 2, "exactly one dependent starts on the unblock under cap=1");
		assert.equal(h.scheduler.pendingCount(h.parent.id), 1, "the other dependent is parked capacity-blocked");
		assert.equal(h.peak(), 1, "auto-unblock must never exceed the cap");

		// Merge the now-running dependent → the last one starts.
		const secondStarted = h.started[1];
		await h.call("POST", `/api/goals/${h.parent.id}/integrate-child/${secondStarted}`, { force: true }, h.authAs(TL));
		assert.equal(h.started.length, 3, "the final dependent starts once a permit frees");
		assert.equal(h.peak(), 1);
		void c2; void c3;
	});
});
