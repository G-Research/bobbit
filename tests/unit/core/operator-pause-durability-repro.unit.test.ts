import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";

import { GoalStore, type PersistedGoal } from "../../../src/server/agent/goal-store.ts";
import { GoalManager } from "../../../src/server/agent/goal-manager.ts";
import { ChildTeamScheduler } from "../../../src/server/agent/child-team-scheduler.ts";
import { tryHandleNestedGoalRoute, type NestedGoalRouteDeps } from "../../../src/server/agent/nested-goal-routes.ts";
import { createMemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

type GoalWithPauseSource = PersistedGoal & { pauseSource?: "operator" | "legacy-deps" };
type RouteResult = { handled: boolean; status: number; payload: unknown };

function goal(id: string, overrides: Partial<GoalWithPauseSource> = {}): GoalWithPauseSource {
	return {
		id,
		title: id,
		cwd: `/memfs/${id}`,
		state: "todo",
		spec: `${id} specification`,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

async function restartWith(goals: GoalWithPauseSource[]): Promise<GoalStore> {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/operator-pause-durability/state");
	memfs.mkdirSync(stateDir);
	const beforeRestart = new GoalStore(stateDir, memfs);
	for (const persistedGoal of goals) beforeRestart.put(persistedGoal);
	await beforeRestart.flush();

	const afterRestart = new GoalStore(stateDir, memfs);
	new GoalManager(afterRestart);
	return afterRestart;
}

function createResumeRouteFixture() {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/operator-pause-resume/state");
	memfs.mkdirSync(stateDir);
	const goalStore = new GoalStore(stateDir, memfs);
	const goalManager = new GoalManager(goalStore);
	const parent = goal("parent", { branch: "goal/parent", worktreePath: "/memfs/parent" });
	const dependency = goal("dependency", {
		parentGoalId: parent.id,
		rootGoalId: parent.id,
		spawnedFromPlanId: "dependency-plan",
		branch: "goal/dependency",
		worktreePath: "/memfs/dependency",
	});
	const pausedSibling = goal("operator-paused-sibling", {
		parentGoalId: parent.id,
		rootGoalId: parent.id,
		spawnedFromPlanId: "dependent-plan",
		state: "blocked",
		paused: true,
		pauseSource: "operator",
		dependsOnPlanIds: ["dependency-plan"],
	});
	const unresolvedDependency = goal("unresolved-dependency", {
		parentGoalId: parent.id,
		rootGoalId: parent.id,
		spawnedFromPlanId: "unresolved-dependency-plan",
		branch: "goal/unresolved-dependency",
		worktreePath: "/memfs/unresolved-dependency",
	});
	const unresolvedPausedSibling = goal("unresolved-operator-paused-sibling", {
		parentGoalId: parent.id,
		rootGoalId: parent.id,
		spawnedFromPlanId: "unresolved-dependent-plan",
		state: "blocked",
		paused: true,
		pauseSource: "operator",
		dependsOnPlanIds: ["unresolved-dependency-plan"],
	});
	for (const persistedGoal of [parent, dependency, pausedSibling, unresolvedDependency, unresolvedPausedSibling]) {
		goalStore.put(persistedGoal);
	}
	(goalManager as any).mergeChild = async () => ({ merged: true, alreadyMerged: false, conflict: false, output: "" });

	const started: string[] = [];
	const makeScheduler = () => new ChildTeamScheduler({
		resolveCap: () => 1,
		getChild: (goalId) => goalStore.get(goalId),
		startChildTeam: (goalId) => { started.push(goalId); },
	});
	let scheduler = makeScheduler();
	const context = { goalStore, goalManager, gateStore: {}, project: { id: "project" } };
	const deps = {
		projectContextManager: { getContextForGoal: () => context, all: () => [context] },
		verificationHarness: {
			getActiveVerifications: () => [],
			cancelStaleVerifications: async () => {},
			resolvePlanStepChild: () => ({ source: "none", child: undefined }),
			get childTeamScheduler() { return scheduler; },
			requestChildStart: (goalId: string) => scheduler.requestStart(goalId),
			notifyChildTerminal: (goalId: string) => scheduler.notifyTerminal(goalId),
		},
		teamManager: { teardownTeam: async () => {}, getTeamState: () => ({ teamLeadSessionId: "team-lead" }) },
		sessionManager: {
			getAllSessionsRaw: () => [], getSession: () => undefined, deliverLiveSteer: async () => {}, enqueuePrompt: async () => {},
			sessionSecretStore: { resolveSessionIdBySecret: () => "team-lead" },
		},
		cookieStore: { verify: () => false },
		requireSubgoalsEnabled: () => true,
		getGoalAcrossProjects: (goalId: string) => goalStore.get(goalId),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {},
		jsonError: () => {},
		broadcastToAll: () => {},
		getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	} as unknown as NestedGoalRouteDeps;

	async function post(pathname: string, body: unknown): Promise<RouteResult> {
		let status = 0;
		let payload: unknown;
		const handled = await tryHandleNestedGoalRoute(
			{
				method: "POST",
				headers: { "x-bobbit-spawning-session": "team-lead", "x-bobbit-session-secret": "unforgeable-team-lead-secret" },
				_body: body,
			} as any as http.IncomingMessage,
			new URL(`http://test${pathname}`),
			{
				...deps,
				json: (responseBody, responseStatus) => { payload = responseBody; status = responseStatus ?? 200; },
				jsonError: (responseStatus, error) => { payload = { error }; status = responseStatus; },
			},
		);
		return { handled, status, payload };
	}

	return {
		parent,
		dependency,
		pausedSibling,
		unresolvedPausedSibling,
		goalStore,
		started,
		post,
		getScheduler: () => scheduler,
		recreateScheduler: () => { scheduler = makeScheduler(); },
	};
}

describe("operator pause durability", () => {
	it("OPERATOR_PAUSE_DURABILITY preserves an operator pause with unresolved dependencies after GoalManager re-init", async () => {
		const store = await restartWith([
			goal("unresolved-dependency", {
				parentGoalId: "parent",
				spawnedFromPlanId: "dependency-plan",
			}),
			goal("operator-paused-child", {
				parentGoalId: "parent",
				state: "blocked",
				paused: true,
				pauseSource: "operator",
				dependsOnPlanIds: ["dependency-plan"],
			}),
		]);

		const restored = store.get("operator-paused-child") as GoalWithPauseSource;
		assert.equal(
			restored.paused,
			true,
			"OPERATOR_PAUSE_DURABILITY: GoalManager re-init must preserve an operator pause despite unresolved dependencies",
		);
		assert.equal(restored.pauseSource, "operator", "operator pause provenance must survive re-init");
	});

	it("keeps the legacy no-provenance dependency-pause migration so old records are not stranded", async () => {
		const store = await restartWith([
			goal("legacy-unresolved-dependency", {
				parentGoalId: "parent",
				spawnedFromPlanId: "dependency-plan",
			}),
			goal("legacy-dependency-paused-child", {
				parentGoalId: "parent",
				state: "todo",
				paused: true,
				dependsOnPlanIds: ["dependency-plan"],
			}),
		]);

		const migrated = store.get("legacy-dependency-paused-child")!;
		assert.equal(migrated.state, "blocked", "legacy dependency pause must migrate to scheduler-blocked state");
		assert.equal(migrated.paused, false, "legacy dependency pause must clear paused so it can auto-start after deps resolve");
	});
});

describe("integrate-child respects operator pause", () => {
	it("POST /resume re-drives a live paused queue entry without duplicate starts", async () => {
		const fx = createResumeRouteFixture();
		const integration = await fx.post(`/api/goals/${fx.parent.id}/integrate-child/${fx.dependency.id}`, { force: true });
		expect(integration.handled).toBe(true);
		assert.equal(integration.status, 200, "dependency merge should complete before evaluating the auto-unblock scan");
		assert.deepEqual(fx.started, [], "the operator-paused sibling must not start during dependency auto-unblock");
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 1, "the live scheduler retains the paused sibling queue entry");

		const resume = await fx.post(`/api/goals/${fx.parent.id}/resume`, { cascade: false, childGoalId: fx.pausedSibling.id });
		expect(resume.handled).toBe(true);
		assert.equal(resume.status, 200, `resume route should succeed: ${JSON.stringify(resume.payload)}`);
		assert.deepEqual(resume.payload, { resumed: 1 });
		assert.deepEqual(
			fx.started,
			[fx.pausedSibling.id],
			"OPERATOR_PAUSE_RESUME_LIVE_QUEUE: POST /resume must drain its existing live queue entry exactly once",
		);
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 0, "live queue drain must remove the existing pending entry");
	});

	it("OPERATOR_PAUSE_AUTOUNBLOCK rebuilds a lost queue after restart and never reconstructs unresolved work", async () => {
		const fx = createResumeRouteFixture();
		const integration = await fx.post(`/api/goals/${fx.parent.id}/integrate-child/${fx.dependency.id}`, { force: true });
		expect(integration.handled).toBe(true);
		assert.equal(integration.status, 200, "dependency merge should complete before evaluating the auto-unblock scan");
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 1, "the dependency-resolved paused sibling is queued before restart");
		assert.equal(fx.goalStore.get(fx.pausedSibling.id)!.paused, true, "operator pause remains durable before queue reconstruction");
		assert.equal(fx.goalStore.get(fx.pausedSibling.id)!.state, "blocked", "operator-paused sibling remains blocked before resume");

		fx.recreateScheduler();
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 0, "a simulated restart loses the volatile scheduler queue");

		const resume = await fx.post(`/api/goals/${fx.parent.id}/resume`, { cascade: false, childGoalId: fx.pausedSibling.id });
		expect(resume.handled).toBe(true);
		assert.equal(resume.status, 200, `resume route should succeed: ${JSON.stringify(resume.payload)}`);
		assert.deepEqual(resume.payload, { resumed: 1 });
		assert.equal(fx.goalStore.get(fx.pausedSibling.id)!.paused, false, "resume route clears the durable operator pause");
		assert.deepEqual(
			fx.started,
			[fx.pausedSibling.id],
			"OPERATOR_PAUSE_RESTART_REBUILD: resume must reconstruct and immediately start a dependency-resolved child after queue loss",
		);
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 0, "reconstruction must not leave a duplicate queue entry");

		fx.recreateScheduler();
		const resumeUnresolved = await fx.post(`/api/goals/${fx.parent.id}/resume`, { cascade: false, childGoalId: fx.unresolvedPausedSibling.id });
		expect(resumeUnresolved.handled).toBe(true);
		assert.equal(resumeUnresolved.status, 200, `unresolved resume route should succeed: ${JSON.stringify(resumeUnresolved.payload)}`);
		assert.deepEqual(resumeUnresolved.payload, { resumed: 1 });
		assert.equal(fx.goalStore.get(fx.unresolvedPausedSibling.id)!.paused, false, "resume clears the operator pause for an unresolved child");
		assert.equal(fx.goalStore.get(fx.unresolvedPausedSibling.id)!.state, "blocked", "an unresolved child remains dependency-blocked");
		assert.deepEqual(fx.started, [fx.pausedSibling.id], "OPERATOR_PAUSE_RESUME_UNRESOLVED: resume must not start a child with unresolved dependencies");
		assert.equal(fx.getScheduler().pendingCount(fx.parent.id), 0, "unresolved work must not be reconstructed into the ready queue");
	});
});
