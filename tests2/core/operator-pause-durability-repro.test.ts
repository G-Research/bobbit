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

function createPauseRouteFixture(options: { goals?: GoalWithPauseSource[] } = {}) {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/operator-pause-fence/state");
	memfs.mkdirSync(stateDir);
	const goalStore = new GoalStore(stateDir, memfs);
	const goalManager = new GoalManager(goalStore);
	const pauseGoals = options.goals ?? [goal("pause-target")];
	const pausedGoal = pauseGoals[0];
	for (const pauseGoal of pauseGoals) goalStore.put(pauseGoal);

	let fenceDepth = 0;
	let failFence: { error: Error; goalId?: string } | undefined;
	let updateCalls = 0;
	const updateArguments: Array<{ goalId: string; updates: Parameters<GoalManager["updateGoal"]>[1] }> = [];
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
			if (failFence && (!failFence.goalId || failFence.goalId === goalId)) throw failFence.error;
		},
		getActiveVerifications: () => [],
		cancelStaleVerifications: async () => {},
		resolvePlanStepChild: () => ({ source: "none", child: undefined }),
		requestChildStart: () => "started",
		notifyChildTerminal: () => {},
	};
	type GoalUpdateArgs = Parameters<GoalManager["updateGoal"]>;
	const originalUpdateGoal = goalManager.updateGoal.bind(goalManager);
	// The production route uses updateGoalStrict for the lifecycle publication
	// boundary. Keep the older method wrapped too so this fixture remains usable
	// against pre-strict route revisions, but share all bookkeeping and stalling
	// assertions across both persistence modes.
	const originalUpdateGoalStrict = (goalManager as any).updateGoalStrict?.bind(goalManager) as
		| ((...args: GoalUpdateArgs) => Promise<boolean>)
		| undefined;
	let stallWrite: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
	const wrapGoalUpdate = (update: (...args: GoalUpdateArgs) => Promise<boolean>) =>
		async (...args: GoalUpdateArgs): Promise<boolean> => {
			updateCalls++;
			updateArguments.push({ goalId: args[0], updates: args[1] });
			if (stallWrite) {
				stallWrite.started.resolve();
				await stallWrite.release.promise;
			}
			return update(...args);
		};
	(goalManager as any).updateGoal = wrapGoalUpdate(originalUpdateGoal);
	if (originalUpdateGoalStrict) {
		(goalManager as any).updateGoalStrict = wrapGoalUpdate(originalUpdateGoalStrict);
	}
	const context = { goalStore, goalManager, gateStore: {}, project: { id: "project" } };
	const deps = {
		projectContextManager: { getContextForGoal: () => context, all: () => [context] },
		verificationHarness,
		teamManager: { teardownTeam: async () => {}, getTeamState: () => undefined },
		sessionManager: {
			getAllSessionsRaw: () => pauseGoals.map(pauseGoal => ({
				id: `streaming-session-${pauseGoal.id}`, goalId: pauseGoal.id, status: "streaming",
			})),
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

	async function post({ goalId = pausedGoal.id, cascade = false }: { goalId?: string; cascade?: boolean } = {}): Promise<RouteResult> {
		let status = 0;
		let payload: any;
		const handled = await tryHandleNestedGoalRoute(
			{ method: "POST", headers: { cookie: "bobbit_session=human" }, _body: { cascade } } as any as http.IncomingMessage,
			new URL(`http://test/api/goals/${goalId}/pause`),
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
		goals: pauseGoals,
		goalStore,
		post,
		fenceCalls,
		broadcasts,
		broadcastFenceDepths,
		abortCalls,
		get fenceDepth() { return fenceDepth; },
		get updateCalls() { return updateCalls; },
		get updateArguments() { return updateArguments; },
		failCancellationFence(error = new Error("simulated durable fence failure"), goalId?: string) {
			failFence = { error, goalId };
		},
		holdStrictGoalPublication() {
			// Exercise GoalStore's real strict-publication seam. The held wrapper
			// delegates to it after release, so a successful pause still crosses the
			// production coalesced-writer barrier rather than a test-only fake.
			const persistence = (goalStore as any).persistence;
			const publishStrict = persistence.publishStrict.bind(persistence);
			const started = deferred();
			const release = deferred();
			persistence.publishStrict = async (ids: Iterable<string>) => {
				started.resolve();
				await release.promise;
				return publishStrict(ids);
			};
			return { started, release };
		},
		failStrictGoalPublication(error = new Error("injected strict goal publication failure")) {
			// GoalStore.updateStrict owns the rollback around this exact seam.
			// Replacing it makes the route's success/error handling observable without
			// timing a debounced ordinary save.
			const persistence = (goalStore as any).persistence;
			persistence.publishStrict = async () => { throw error; };
		},
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
		assert.notEqual(fx.goalStore.get(fx.goal.id)!.pauseSource, "operator", "a failed fence must not stamp operator provenance");
		assert.deepEqual(fx.updateArguments, [], "a failed fence must not attempt a pause/provenance write");
		assert.equal(fx.broadcasts.length, 0, "a failed fence must not publish a successful pause");
		assert.deepEqual(fx.abortCalls, [], "a failed fence must not abort goal sessions");
		assert.equal(fx.fenceDepth, 0, "the lifecycle admission fence must release after failure");
	});

	it("aborts only earlier committed goals when a later cascade fence fails", async () => {
		const parent = goal("cascade-parent");
		const child = goal("cascade-child", { parentGoalId: parent.id, rootGoalId: parent.id });
		const fx = createPauseRouteFixture({ goals: [parent, child] });
		fx.failCancellationFence(new Error("child fence persistence failed"), child.id);

		const result = await fx.post({ cascade: true });

		assert.equal(result.status, 503);
		assert.equal(fx.goalStore.get(parent.id)!.paused, true, "the earlier parent remains durably paused");
		assert.equal(fx.goalStore.get(parent.id)!.pauseSource, "operator", "the committed parent retains operator provenance");
		assert.notEqual(fx.goalStore.get(child.id)!.paused, true, "the failed child remains unpaused");
		assert.notEqual(fx.goalStore.get(child.id)!.pauseSource, "operator", "the failed child is never stamped as operator-paused");
		assert.deepEqual(fx.broadcasts, [{ type: "goal_state_changed", goalId: parent.id }]);
		assert.deepEqual(fx.abortCalls, ["streaming-session-cascade-parent"], "only the committed parent may be aborted");
		assert.deepEqual(fx.fenceCalls.map(call => call.goalId), [parent.id, child.id]);
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
		assert.equal(fx.goalStore.get(fx.goal.id)!.pauseSource, "operator", "the first pause durably records operator provenance");
		assert.deepEqual(
			fx.updateArguments,
			[{ goalId: fx.goal.id, updates: { paused: true, pauseSource: "operator" } }],
			"pause state and provenance must share one authoritative write",
		);
		assert.equal(fx.fenceDepth, 0, "admission reopens only after the paused write and broadcast settle");
		assert.deepEqual(fx.fenceCalls, [{ goalId: fx.goal.id, cause: "goal-pause", depth: 1 }]);
		assert.deepEqual(fx.broadcastFenceDepths, [1], "the paused broadcast must remain inside the lifecycle fence");
	});

	it("does not report or broadcast an operator pause before GoalStore strict publication settles", async () => {
		const fx = createPauseRouteFixture();
		const publication = fx.holdStrictGoalPublication();
		const pause = fx.post();
		const firstBoundary = await Promise.race([
			publication.started.promise.then(() => "strict-publication" as const),
			pause.then(() => "route-response" as const),
		]);

		assert.equal(
			firstBoundary,
			"strict-publication",
			"OPERATOR_PAUSE_STRICT_PUBLICATION: the route must enter GoalStore's strict publication barrier before it can return success",
		);
		let responseSettled = false;
		void pause.then(() => { responseSettled = true; });
		await Promise.resolve();
		assert.equal(responseSettled, false, "the held strict publication barrier must keep the pause response pending");
		assert.deepEqual(fx.broadcasts, [], "the paused state must not broadcast before strict publication completes");

		publication.release.resolve();
		assert.deepEqual(await pause, { handled: true, status: 200, payload: { paused: 1 } });
		assert.deepEqual(fx.broadcasts, [{ type: "goal_state_changed", goalId: fx.goal.id }]);
		assert.equal(fx.goalStore.get(fx.goal.id)!.paused, true, "the successful response follows one durable pause/provenance publication");
		assert.equal(fx.goalStore.get(fx.goal.id)!.pauseSource, "operator", "the successful response follows one durable pause/provenance publication");
	});

	it("maps a strict GoalStore pause publication failure to the retryable lifecycle error and restores memory", async () => {
		const fx = createPauseRouteFixture();
		fx.failStrictGoalPublication();

		const result = await fx.post();

		assert.equal(result.handled, true);
		assert.deepEqual(result, {
			handled: true,
			status: 503,
			payload: {
				error: "Could not durably cancel active verifications",
				code: "VERIFICATION_CANCELLATION_FENCE_FAILED",
				retryable: true,
			},
		});
		assert.notEqual(fx.goalStore.get(fx.goal.id)!.paused, true, "GoalStore strict rollback must restore paused memory ownership");
		assert.notEqual(fx.goalStore.get(fx.goal.id)!.pauseSource, "operator", "GoalStore strict rollback must restore provenance memory ownership");
		assert.notEqual(fx.goal.paused, true, "the route's live goal object must observe the rollback, not retain a stale pause");
		assert.notEqual(fx.goal.pauseSource, "operator", "the route's live goal object must observe the provenance rollback");
		assert.deepEqual(fx.broadcasts, [], "a rejected strict publication must not announce a successful pause");
		assert.deepEqual(fx.abortCalls, [], "a rejected strict publication must not abort sessions as if pause succeeded");
		assert.equal(fx.fenceDepth, 0, "the lifecycle fence must release after the strict publication failure");
	});

	it("repeated pause re-drives durable cancellation without duplicating state work", async () => {
		const fx = createPauseRouteFixture();
		assert.deepEqual(await fx.post(), { handled: true, status: 200, payload: { paused: 1 } });
		assert.deepEqual(await fx.post(), { handled: true, status: 200, payload: { paused: 0 } });

		assert.equal(fx.updateCalls, 1, "repeated pause must not rewrite already-paused state");
		assert.deepEqual(
			fx.updateArguments,
			[{ goalId: fx.goal.id, updates: { paused: true, pauseSource: "operator" } }],
			"only the first pause may write operator provenance",
		);
		assert.equal(fx.goalStore.get(fx.goal.id)!.pauseSource, "operator", "the first pause's provenance remains durable");
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
