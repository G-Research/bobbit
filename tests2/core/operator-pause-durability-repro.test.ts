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
	it("OPERATOR_PAUSE_AUTOUNBLOCK queues, rather than starts or strands, an operator-paused sibling after its final dependency merges", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/operator-pause-autounblock/state");
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
		goalStore.put(parent);
		goalStore.put(dependency);
		goalStore.put(pausedSibling);
		goalStore.put(unresolvedDependency);
		goalStore.put(unresolvedPausedSibling);
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
				// The route uses the production scheduler surface. Keeping this
				// reference mutable lets this test simulate the volatile scheduler
				// being rebuilt during a gateway restart.
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

		async function post(pathname: string, body: unknown): Promise<{ handled: boolean; status: number; payload: unknown }> {
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

		const integration = await post(`/api/goals/${parent.id}/integrate-child/${dependency.id}`, { force: true });
		expect(integration.handled).toBe(true);
		assert.equal(integration.status, 200, "dependency merge should complete before evaluating the auto-unblock scan");
		const finalSibling = goalStore.get(pausedSibling.id)!;
		assert.deepEqual(started, [], "OPERATOR_PAUSE_AUTOUNBLOCK: a paused auto-unblocked sibling must not start a team");
		assert.equal(scheduler.pendingCount(parent.id), 1, "the scheduler queues the paused sibling so it is not stranded after its dependency completes");
		assert.equal(finalSibling.paused, true, "operator-paused sibling must remain paused after its dependency completes");
		assert.equal(finalSibling.state, "blocked", "operator-paused sibling must remain blocked after its dependency completes");

		// A gateway restart recreates the in-memory scheduler and discards its
		// queue. Resume must rebuild a ready child's start intent from durable goal
		// state, rather than depending on that vanished queue.
		scheduler = makeScheduler();
		assert.equal(scheduler.pendingCount(parent.id), 0, "simulated restart loses the volatile scheduler queue");

		const resume = await post(`/api/goals/${parent.id}/resume`, {
			cascade: false,
			childGoalId: pausedSibling.id,
		});
		expect(resume.handled).toBe(true);
		assert.equal(resume.status, 200, `resume route should succeed: ${JSON.stringify(resume.payload)}`);
		assert.deepEqual(resume.payload, { resumed: 1 });
		assert.equal(goalStore.get(pausedSibling.id)!.paused, false, "resume route clears the durable operator pause");
		assert.deepEqual(
			started,
			[pausedSibling.id],
			"OPERATOR_PAUSE_RESTART_REBUILD: resume must reconstruct and immediately start the dependency-resolved child after queue loss",
		);
		assert.equal(scheduler.pendingCount(parent.id), 0, "the reconstructed start must not leave a duplicate queue entry");

		// Use another fresh scheduler so the ready child's held permit cannot mask
		// an accidental start. Resuming an operator-paused child whose dependency
		// is still unresolved only clears the pause; it must not schedule a team.
		scheduler = makeScheduler();
		const resumeUnresolved = await post(`/api/goals/${parent.id}/resume`, {
			cascade: false,
			childGoalId: unresolvedPausedSibling.id,
		});
		expect(resumeUnresolved.handled).toBe(true);
		assert.equal(resumeUnresolved.status, 200, `unresolved resume route should succeed: ${JSON.stringify(resumeUnresolved.payload)}`);
		assert.deepEqual(resumeUnresolved.payload, { resumed: 1 });
		assert.equal(goalStore.get(unresolvedPausedSibling.id)!.paused, false, "resume still clears the operator pause for an unresolved child");
		assert.equal(goalStore.get(unresolvedPausedSibling.id)!.state, "blocked", "an unresolved child remains dependency-blocked");
		assert.deepEqual(started, [pausedSibling.id], "OPERATOR_PAUSE_RESUME_UNRESOLVED: resume must not start a child with unresolved dependencies");
		assert.equal(scheduler.pendingCount(parent.id), 0, "an unresolved child must not be reconstructed into the ready queue");
	});
});
