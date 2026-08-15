import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";

import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { ChildTeamScheduler } from "../../src/server/agent/child-team-scheduler.ts";
import { tryHandleNestedGoalRoute, type NestedGoalRouteDeps } from "../../src/server/agent/nested-goal-routes.ts";
import { createMemFs } from "../harness/mem-fs.js";

type GoalWithPauseSource = PersistedGoal & { pauseSource?: "operator" | "legacy-deps" };
type RouteResult = { handled: boolean; status: number; payload: any };

function deferred() {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = () => res();
		reject = rej;
	});
	return { promise, resolve, reject };
}

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

function createPauseRouteFixture() {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/operator-pause-fence/state");
	memfs.mkdirSync(stateDir);
	const goalStore = new GoalStore(stateDir, memfs);
	const goalManager = new GoalManager(goalStore);
	const pausedGoal = goal("pause-target");
	goalStore.put(pausedGoal);

	let fenceDepth = 0;
	let failFence: Error | undefined;
	let updateCalls = 0;
	const fenceCalls: Array<{ goalId: string; cause: string; depth: number }> = [];
	const broadcasts: any[] = [];
	const broadcastFenceDepths: number[] = [];
	const abortCalls: string[] = [];
	const verificationHarness: any = {
		acquireGoalLifecycleFence: () => {
			fenceDepth++;
			let released = false;
			return () => {
				if (!released) {
					released = true;
					fenceDepth--;
				}
			};
		},
		fenceAndCancelAllVerifications: (goalId: string, cause: string) => {
			fenceCalls.push({ goalId, cause, depth: fenceDepth });
			if (failFence) throw failFence;
		},
		getActiveVerifications: () => [],
		cancelStaleVerifications: async () => {},
		resolvePlanStepChild: () => ({ source: "none", child: undefined }),
		requestChildStart: () => "started",
		notifyChildTerminal: () => {},
	};
	const originalUpdateGoal = goalManager.updateGoal.bind(goalManager);
	let stallWrite: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
	(goalManager as any).updateGoal = async (...args: Parameters<GoalManager["updateGoal"]>) => {
		updateCalls++;
		if (stallWrite) {
			stallWrite.started.resolve();
			await stallWrite.release.promise;
		}
		return originalUpdateGoal(...args);
	};
	const context = { goalStore, goalManager, gateStore: {}, project: { id: "project" } };
	const deps = {
		projectContextManager: { getContextForGoal: () => context, all: () => [context] },
		verificationHarness,
		teamManager: { teardownTeam: async () => {}, getTeamState: () => undefined },
		sessionManager: {
			getAllSessionsRaw: () => [{ id: "streaming-session", goalId: pausedGoal.id, status: "streaming" }],
			abortSessionTurn: async (sessionId: string) => { abortCalls.push(sessionId); },
			getSession: () => undefined, deliverLiveSteer: async () => {}, enqueuePrompt: async () => {},
			sessionSecretStore: { resolveSessionIdBySecret: () => undefined },
		},
		cookieStore: { verify: (value: string) => value === "human" },
		requireSubgoalsEnabled: () => true,
		getGoalAcrossProjects: (goalId: string) => goalStore.get(goalId),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {},
		jsonError: () => {},
		broadcastToAll: (event: any) => { broadcasts.push(event); broadcastFenceDepths.push(fenceDepth); },
		getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	} as unknown as NestedGoalRouteDeps;

	async function post(): Promise<RouteResult> {
		let status = 0;
		let payload: any;
		const handled = await tryHandleNestedGoalRoute(
			{ method: "POST", headers: { cookie: "bobbit_session=human" }, _body: { cascade: false } } as any as http.IncomingMessage,
			new URL(`http://test/api/goals/${pausedGoal.id}/pause`),
			{
				...deps,
				json: (responseBody, responseStatus) => { payload = responseBody; status = responseStatus ?? 200; },
				jsonError: (responseStatus, error) => { payload = { error }; status = responseStatus; },
			},
		);
		return { handled, status, payload };
	}

	return {
		goal: pausedGoal,
		goalStore,
		post,
		fenceCalls,
		broadcasts,
		broadcastFenceDepths,
		abortCalls,
		get fenceDepth() { return fenceDepth; },
		get updateCalls() { return updateCalls; },
		failCancellationFence(error = new Error("simulated durable fence failure")) { failFence = error; },
		stallPausedWrite() {
			stallWrite = { started: deferred(), release: deferred() };
			return stallWrite;
		},
	};
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
			acquireGoalLifecycleFence: () => () => {},
			fenceAndCancelAllVerifications: () => {},
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

describe("canonical operator pause lifecycle", () => {
	it("fails closed when durable cancellation fencing fails", async () => {
		const fx = createPauseRouteFixture();
		fx.failCancellationFence();

		const result = await fx.post();

		assert.equal(result.handled, true);
		assert.equal(result.status, 503);
		assert.deepEqual(result.payload, {
			error: "Could not durably cancel active verifications",
			code: "VERIFICATION_CANCELLATION_FENCE_FAILED",
			retryable: true,
		});
		assert.notEqual(fx.goalStore.get(fx.goal.id)!.paused, true, "a failed fence must not persist pause state");
		assert.equal(fx.broadcasts.length, 0, "a failed fence must not publish a successful pause");
		assert.deepEqual(fx.abortCalls, [], "a failed fence must not abort goal sessions");
		assert.equal(fx.fenceDepth, 0, "the lifecycle admission fence must release after failure");
	});

	it("holds goal-wide admission through the paused write", async () => {
		const fx = createPauseRouteFixture();
		const write = fx.stallPausedWrite();
		let signalGeneration = 0;
		const admitSignal = () => {
			if (fx.fenceDepth > 0) return { status: 409, code: "GOAL_LIFECYCLE_FENCED" };
			signalGeneration++;
			return { status: 201 };
		};

		const pause = fx.post();
		await write.started.promise;
		assert.deepEqual(admitSignal(), { status: 409, code: "GOAL_LIFECYCLE_FENCED" });
		assert.equal(signalGeneration, 0, "no signal generation may escape while the pause decision is open");
		assert.equal(fx.goalStore.get(fx.goal.id)!.paused, undefined, "pause write remains authoritative and incomplete");

		write.release.resolve();
		const result = await pause;
		assert.equal(result.status, 200);
		assert.deepEqual(result.payload, { paused: 1 });
		assert.equal(fx.goalStore.get(fx.goal.id)!.paused, true);
		assert.equal(fx.fenceDepth, 0, "admission reopens only after the paused write and broadcast settle");
		assert.deepEqual(fx.fenceCalls, [{ goalId: fx.goal.id, cause: "goal-pause", depth: 1 }]);
		assert.deepEqual(fx.broadcastFenceDepths, [1], "the paused broadcast must remain inside the lifecycle fence");
	});

	it("repeated pause re-drives durable cancellation without duplicating state work", async () => {
		const fx = createPauseRouteFixture();
		assert.deepEqual(await fx.post(), { handled: true, status: 200, payload: { paused: 1 } });
		assert.deepEqual(await fx.post(), { handled: true, status: 200, payload: { paused: 0 } });

		assert.equal(fx.updateCalls, 1, "repeated pause must not rewrite already-paused state");
		assert.equal(fx.broadcasts.length, 1, "repeated pause must not publish another state transition");
		assert.deepEqual(fx.fenceCalls.map(call => call.cause), ["goal-pause", "goal-pause"]);
		assert.equal(fx.fenceDepth, 0);
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
