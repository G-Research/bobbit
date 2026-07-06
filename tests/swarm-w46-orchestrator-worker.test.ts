import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GateStore } from "../src/server/agent/gate-store.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";
import { SessionSecretStore } from "../src/server/auth/session-secret.ts";
import { tryHandleNestedGoalRoute, type NestedGoalRouteDeps } from "../src/server/agent/nested-goal-routes.ts";
import { createOrchestratorWorkerSwarm, parseOrchestratorWorkerShards } from "../src/server/agent/swarm-orchestrator-worker.ts";
import { buildActive, buildFixture, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

function makeStores(prefix: string) {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const workflowStore = new InlineWorkflowStore(cfg);
	workflowStore.setBuiltins([{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 }]);
	const goalManager = new GoalManager(goalStore, workflowStore);
	const swarmGroupStore = new SwarmGroupStore(stateDir);
	goalManager.setSwarmGroupStore(swarmGroupStore);
	return { tmpRoot, stateDir, goalStore, workflowStore, goalManager, swarmGroupStore, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
}

describe("SWARM-W4.6 — orchestrator-worker decompose contract", () => {
	it("parser accepts only a fenced JSON array of exact shard objects", () => {
		const shards = parseOrchestratorWorkerShards([
			"```json",
			'[{"title":"A","spec":"Do A","rationale":"A is independent."}]',
			"```",
		].join("\n"));
		assert.deepEqual(shards, [{ title: "A", spec: "Do A", rationale: "A is independent." }]);
		assert.throws(() => parseOrchestratorWorkerShards('[{"title":"A","spec":"Do A","rationale":"x"}]'), /fenced/);
		assert.throws(() => parseOrchestratorWorkerShards("```json\n[]\n```"), /1 to 5/);
		assert.throws(() => parseOrchestratorWorkerShards('```json\n[{"title":"A","spec":"Do A","rationale":"x","extra":"no"}]\n```'), /exactly/);
	});

	it("bad JSON aborts before any worker createGoal call or swarm group creation", async () => {
		const fx = makeStores("swarm-w46-decompose-");
		after(() => fx.cleanup());
		const parent = await fx.goalManager.createGoal("Parent", fx.tmpRoot, { workflowId: "feature" });
		let createCallsAfterParent = 0;
		const realCreateGoal = fx.goalManager.createGoal.bind(fx.goalManager);
		(fx.goalManager as any).createGoal = async (...args: any[]) => {
			createCallsAfterParent++;
			return realCreateGoal(...args);
		};
		const deps: any = {
			getContextForGoal: () => ({ goalStore: fx.goalStore, swarmGroupStore: fx.swarmGroupStore, workflowStore: fx.workflowStore }),
			getGoalManagerForGoal: () => fx.goalManager,
			harness: { requestChildStart: () => "started", swarmGovernor: { registerNode: () => {} }, hardKillSwarmNode: async () => {} },
			teamManager: { spawnRole: async () => ({ sessionId: "decompose-session" }) },
			sessionManager: {
				waitForStreaming: async () => {},
				waitForIdle: async () => {},
				getSessionOutput: async () => "```json\nnot-json\n```",
			},
		};
		await assert.rejects(
			() => createOrchestratorWorkerSwarm(deps, { parentGoalId: parent.id, title: "Parent", spec: "Split this task." }),
			/invalid JSON/,
		);
		assert.equal(createCallsAfterParent, 0, "no worker goal may be created after a bad decompose response");
		assert.deepEqual(fx.swarmGroupStore.getAll(), [], "no swarm group may be persisted before decompose validation succeeds");
	});
});

describe("SWARM-W4.6 — conflicted shard terminal fallback", () => {
	it("barrier converges with one done artifact and one failed artifact", () => {
		const fx = makeStores("swarm-w46-barrier-");
		after(() => fx.cleanup());
		fx.swarmGroupStore.createGroup("grp-mixed", ["done", "failed"], "root", { parentGoalId: "root", topology: "orchestrator-worker", reconcileMode: "merge-all" });
		fx.swarmGroupStore.recordArtifact("grp-mixed", { goalId: "done", output: "", status: "done", verifierScore: null, capturedAt: 1 }, ["done", "failed"], "root");
		const rec = fx.swarmGroupStore.recordArtifact("grp-mixed", { goalId: "failed", output: "", status: "failed", verifierScore: null, capturedAt: 2 }, ["done", "failed"], "root");
		assert.equal(rec.barrierFired, true);
		assert.equal(rec.allFailed, false);
	});

	it("runSubgoalStep main merge conflict notifies failed only for swarm-tagged children", async () => {
		for (const swarm of [false, true]) {
			const fx = await buildFixture();
			after(() => fx.cleanup());
			const planId = `p-main-${swarm ? "swarm" : "plain"}`;
			const child = await fx.goalManager.createGoal("Existing child", fx.tmpRoot, {
				workflowId: "feature",
				parentGoalId: fx.parent.id,
				...(swarm ? { swarmGroup: "grp-main-conflict" } : {}),
			});
			await fx.goalManager.updateGoal(child.id, { spawnedFromPlanId: planId });
			fx.setMergeOutcome({ conflict: true, output: "CONFLICT" });
			const terminalCalls: Array<{ id: string; status: string }> = [];
			(fx.harness as any).notifyChildTerminal = async (id: string, status: string) => { terminalCalls.push({ id, status }); };

			const step = buildSubgoalStep({ planId });
			const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
			const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

			assert.equal(result.passed, false);
			assert.deepEqual(terminalCalls, swarm ? [{ id: child.id, status: "failed" }] : []);
			assert.notEqual(fx.goalStore.get(child.id)?.archived, true);
		}
	});

	it("runSubgoalStep workflow-less recovery conflict notifies failed only for swarm-tagged children", async () => {
		for (const swarm of [false, true]) {
			const fx = await buildFixture();
			after(() => fx.cleanup());
			const planId = `p-workflowless-${swarm ? "swarm" : "plain"}`;
			const child = await fx.goalManager.createGoal("Workflowless child", fx.tmpRoot, {
				workflowId: "feature",
				parentGoalId: fx.parent.id,
				...(swarm ? { swarmGroup: "grp-workflowless-conflict" } : {}),
			});
			fx.goalStore.update(child.id, { spawnedFromPlanId: planId, state: "complete", workflow: undefined, archived: false } as any);
			fx.setMergeOutcome({ conflict: true, output: "CONFLICT" });
			const terminalCalls: Array<{ id: string; status: string }> = [];
			(fx.harness as any).notifyChildTerminal = async (id: string, status: string) => { terminalCalls.push({ id, status }); };

			const step = buildSubgoalStep({ planId, title: "Workflowless child" });
			const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
			const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

			assert.equal(result.passed, false);
			assert.deepEqual(terminalCalls, swarm ? [{ id: child.id, status: "failed" }] : []);
			assert.notEqual(fx.goalStore.get(child.id)?.archived, true);
		}
	});

	it("integrate-child REST conflict branch notifies failed only for swarm-tagged children", async () => {
		for (const swarm of [false, true]) {
			const fx = makeStores("swarm-w46-route-conflict-");
			after(() => fx.cleanup());
			const gateStore = new GateStore(fx.stateDir);
			const parent = await fx.goalManager.createGoal("Parent", fx.tmpRoot, { workflowId: "feature" });
			const child = await fx.goalManager.createGoal("Child", fx.tmpRoot, {
				workflowId: "feature",
				parentGoalId: parent.id,
				...(swarm ? { swarmGroup: "grp-route-conflict" } : {}),
			});
			fx.goalStore.update(parent.id, { branch: "parent", worktreePath: fx.tmpRoot } as any);
			fx.goalStore.update(child.id, { branch: "child" } as any);
			(fx.goalManager as any).mergeChild = async () => ({ merged: false, alreadyMerged: false, conflict: true, pushed: false, output: "CONFLICT" });

			const sessionSecretStore = new SessionSecretStore();
			const secret = sessionSecretStore.getOrCreateSecret("team-lead");
			const terminalCalls: Array<{ id: string; status: string }> = [];
			const ctx: any = { goalStore: fx.goalStore, goalManager: fx.goalManager, gateStore, workflowStore: fx.workflowStore };
			const deps: NestedGoalRouteDeps = {
				projectContextManager: { getContextForGoal: () => ctx } as any,
				verificationHarness: { notifyChildTerminal: async (id: string, status: string) => { terminalCalls.push({ id, status }); } } as any,
				teamManager: { getTeamState: (id: string) => id === parent.id ? { teamLeadSessionId: "team-lead" } : undefined, teardownTeam: async () => {} } as any,
				sessionManager: { sessionSecretStore } as any,
				cookieStore: new CookieStore(fx.stateDir),
				requireSubgoalsEnabled: () => true,
				getGoalAcrossProjects: (id: string) => fx.goalStore.get(id),
				getGoalManagerForGoal: () => fx.goalManager,
				readBody: async (req: http.IncomingMessage) => (req as any)._body,
				json: () => {},
				jsonError: () => {},
				broadcastToAll: () => {},
				getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 3 }),
			};
			let status = 200;
			let payload: any;
			const localDeps = {
				...deps,
				json: (body: unknown, s?: number) => { payload = body; status = s ?? 200; },
				jsonError: (s: number, err: unknown) => { payload = { error: String((err as any)?.message ?? err) }; status = s; },
			};
			const req = { method: "POST", headers: { "x-bobbit-session-secret": secret }, _body: { force: true } } as any as http.IncomingMessage;
			const handled = await tryHandleNestedGoalRoute(req, new URL(`http://x/api/goals/${parent.id}/integrate-child/${child.id}`), localDeps);

			assert.equal(handled, true);
			assert.equal(status, 409);
			assert.equal(payload.conflict, true);
			assert.deepEqual(terminalCalls, swarm ? [{ id: child.id, status: "failed" }] : []);
			assert.notEqual(fx.goalStore.get(child.id)?.archived, true);
			assert.equal(fx.goalStore.get(child.id)?.mergeConflict, true);
		}
	});
});
