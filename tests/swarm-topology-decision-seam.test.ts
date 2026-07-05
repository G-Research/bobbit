// SWARM-W4.3: `tryHandleSwarmRoute`'s best-of-N creation wiring for the
// swarm-topology decision seam/classifier (observe-only, see
// src/server/agent/swarm-topology-classifier.ts's header for the full
// design/scope).
//
// Pins the wave's core safety properties:
//   1. The consult is FAIL-OPEN: no hub, an unregistered (point,kind) pair,
//      or a throwing classifier must never block or slow swarm creation —
//      the best-of-N swarm is still created and the REST response is
//      unaffected in every case.
//   2. OBSERVE-ONLY: a `select` decision from either a test classifier or the
//      real built-in classifier is recorded via `dispatchDecision`'s own trace, but
//      NEVER changes which topology gets created (`createBestOfNSwarm` runs
//      exactly as it always has — there is no branch on the decision at
//      all this wave).
//   3. `forceIntegrateSwarmWinner` / operator-confirmation are entirely
//      untouched by this seam — the create route never mints/consumes a
//      token at all.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type WorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { SwarmGovernor } from "../src/server/agent/swarm-governor.ts";
import { LifecycleHub } from "../src/server/agent/lifecycle-hub.ts";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, registerSwarmTopologyClassifier } from "../src/server/agent/swarm-topology-classifier.ts";
import { tryHandleSwarmRoute } from "../src/server/agent/swarm-routes.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;
let goalStore: GoalStore;
let goalManager: GoalManager;
let swarmGroupStore: SwarmGroupStore;
let workflowStore: WorkflowStore;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w4.2-topology-seam-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	workflowStore = new InlineWorkflowStore(cfg);
	(workflowStore as InlineWorkflowStore).setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	goalManager = new GoalManager(goalStore, workflowStore);
	swarmGroupStore = new SwarmGroupStore(stateDir);
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFakeHarness() {
	const swarmGovernor = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
	return {
		swarmGovernor,
		requestChildStart(_goalId: string, onStart?: () => void): "started" | "capacity-blocked" {
			onStart?.();
			return "started";
		},
		hardKillSwarmNode: async () => {},
	};
}

function makeHub(): InstanceType<typeof LifecycleHub> {
	return new LifecycleHub({
		registry: { listProviders: () => [] } as any,
		moduleHost: {} as any,
		trace: new ContextTraceStore(path.join(tmpRoot, "never-written-trace-dir")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
}

function makeDeps(opts?: { hub?: InstanceType<typeof LifecycleHub> }) {
	const ctx: any = { goalStore, swarmGroupStore, workflowStore };
	const harness = makeFakeHarness();
	const jsonCalls: Array<{ body: unknown; status?: number }> = [];
	const jsonErrorCalls: Array<{ status: number; err: unknown }> = [];
	const broadcasts: any[] = [];
	let requestBody: any = {};
	const deps: any = {
		projectContextManager: { getContextForGoal: (_gid: string) => ctx },
		verificationHarness: harness,
		teamManager: { getTeamState: (_goalId: string) => ({ teamLeadSessionId: "lead-1" }) },
		sessionManager: {
			lifecycleHub: opts?.hub,
			sessionSecretStore: { resolveSessionIdBySecret: (_secret?: string) => "lead-1" },
		},
		cookieStore: {},
		getGoalAcrossProjects: (goalId: string) => goalStore.get(goalId),
		getGoalManagerForGoal: (_goalId: string) => goalManager,
		readBody: async (_req: any) => requestBody,
		json: (body: unknown, status?: number) => jsonCalls.push({ body, status }),
		jsonError: (status: number, err: unknown) => jsonErrorCalls.push({ status, err }),
		broadcastToAll: (event: any) => broadcasts.push(event),
	};
	return { deps, harness, jsonCalls, jsonErrorCalls, broadcasts, setBody: (b: any) => { requestBody = b; } };
}

function makeReq(): any {
	return { method: "POST", headers: {} };
}

const BASE_BODY = { spec: "Reproduce and fix the reported bug.", n: 2, verifyCommand: "npm test" };

describe("tryHandleSwarmRoute — swarm-topology decision seam/classifier (SWARM-W4.3)", () => {
	it("creates the swarm normally when no lifecycleHub is attached at all (fail-open)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { deps, jsonCalls, jsonErrorCalls, setBody } = makeDeps();
		setBody(BASE_BODY);
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		const handled = await tryHandleSwarmRoute(makeReq(), url, deps);
		assert.equal(handled, true);
		assert.equal(jsonErrorCalls.length, 0, "must not error when no hub is attached");
		assert.equal(jsonCalls.length, 1);
		assert.equal((jsonCalls[0].body as any).siblingGoalIds.length, 2);
	});

	it("creates the swarm normally when the hub is attached but nothing is allow-listed (fail-open, would otherwise throw)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub(); // nothing allow-listed — dispatchDecision would throw
		const { deps, jsonCalls, jsonErrorCalls, setBody } = makeDeps({ hub });
		setBody(BASE_BODY);
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		const handled = await tryHandleSwarmRoute(makeReq(), url, deps);
		assert.equal(handled, true);
		assert.equal(jsonErrorCalls.length, 0, "an unregistered (point,kind) pair must never surface as a 500");
		assert.equal(jsonCalls.length, 1);
		assert.equal((jsonCalls[0].body as any).siblingGoalIds.length, 2);
	});

	it("creates the swarm normally when the pair is allow-listed with zero classifiers (byte-identical abstain case)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub();
		hub.allowDecisionPoint(SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND);
		const { deps, jsonCalls, setBody } = makeDeps({ hub });
		setBody(BASE_BODY);
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		await tryHandleSwarmRoute(makeReq(), url, deps);
		assert.equal(jsonCalls.length, 1);
		assert.equal((jsonCalls[0].body as any).siblingGoalIds.length, 2);

		const ring = hub.getDecisionTrace();
		assert.equal(ring.length, 1, "the consult must be recorded even though nothing is registered");
		assert.equal(ring[0].point, "goal-create");
		assert.equal(ring[0].decisionKind, "swarm-topology");
		assert.deepEqual(ring[0].decision, { kind: "abstain" });
		assert.deepEqual(ring[0].consulted, []);
	});

	it("records a select() decision but NEVER applies it — the created topology is unconditionally best-of-N (no branch on the decision this wave)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub();
		hub.registerDecisionClassifier(SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, {
			id: "test-classifier",
			evaluate: () => ({ kind: "select", choice: { topology: "solo" }, rationale: "would have picked solo" }),
		});
		const { deps, jsonCalls, setBody } = makeDeps({ hub });
		setBody(BASE_BODY);
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		await tryHandleSwarmRoute(makeReq(), url, deps);

		// Topology stays 100% caller-supplied: best-of-N with the requested N,
		// regardless of the classifier's (unapplied) "solo" pick.
		assert.equal(jsonCalls.length, 1);
		assert.equal((jsonCalls[0].body as any).siblingGoalIds.length, 2);

		const ring = hub.getDecisionTrace();
		assert.equal(ring.length, 1);
		assert.deepEqual(ring[0].decision, { kind: "select", choice: { topology: "solo" }, rationale: "would have picked solo" });
	});

	it("records the real built-in best-of-N select but still uses the caller-supplied route options", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub();
		registerSwarmTopologyClassifier(hub);
		const { deps, jsonCalls, setBody } = makeDeps({ hub });
		setBody({ ...BASE_BODY, n: 3, earlyKill: true });
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		await tryHandleSwarmRoute(makeReq(), url, deps);

		assert.equal(jsonCalls.length, 1);
		const body = jsonCalls[0].body as any;
		assert.equal(body.siblingGoalIds.length, 3);
		const group = swarmGroupStore.get(body.swarmGroup);
		assert.equal(group?.config.earlyKill, true, "route must keep the caller-supplied earlyKill:true even though the classifier's observe-only choice says earlyKill:false");

		const ring = hub.getDecisionTrace();
		assert.equal(ring.length, 1);
		assert.equal(ring[0].consulted.length, 1);
		assert.deepEqual(ring[0].decision, {
			kind: "select",
			choice: { topology: "best-of-n", fanOut: 3, earlyKill: false },
			confidence: 1,
			rationale: "matched deterministic rule 'best-of-n-with-verifier': caller already wants fan-out and a deterministic verifier exists",
		});
	});

	it("is fail-open when the registered classifier itself throws", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub();
		hub.registerDecisionClassifier(SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, {
			id: "throwing-classifier",
			evaluate: () => { throw new Error("boom"); },
		});
		const { deps, jsonCalls, jsonErrorCalls, setBody } = makeDeps({ hub });
		setBody(BASE_BODY);
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		await tryHandleSwarmRoute(makeReq(), url, deps);
		assert.equal(jsonErrorCalls.length, 0, "a throwing classifier must never surface as a 500 or block swarm creation");
		assert.equal(jsonCalls.length, 1);
		assert.equal((jsonCalls[0].body as any).siblingGoalIds.length, 2);
	});

	it("passes hasVerifyCommand:true and the requested fan-out as the consult arg", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const hub = makeHub();
		let seenArg: any;
		hub.registerDecisionClassifier(SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, {
			id: "capturing-classifier",
			evaluate: (_ctx: any, arg: unknown) => { seenArg = arg; return { kind: "abstain" }; },
		});
		const { deps, setBody } = makeDeps({ hub });
		setBody({ ...BASE_BODY, n: 3 });
		const url = new URL(`http://localhost/api/goals/${parent.id}/swarm/best-of-n`);
		await tryHandleSwarmRoute(makeReq(), url, deps);
		assert.equal(seenArg.goalId, parent.id);
		assert.equal(seenArg.spec, BASE_BODY.spec);
		assert.equal(seenArg.hasVerifyCommand, true);
		assert.equal(seenArg.requestedFanOut, 3);
	});
});
