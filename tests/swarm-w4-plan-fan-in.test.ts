/**
 * SWARM-W4.5 — plan-fan-in (docs/design/swarm-orchestration-w4.md §1.1),
 * module-level. Three things, in three describe blocks:
 *
 *   1. `createPlanFanInSwarm` is a thin, byte-provable WRAPPER over
 *      `createBestOfNSwarm` — same fan-out shape, plus the planning-only
 *      prompt prefix, `siblingPromptProfile:"reviewer"` (orchestrator
 *      ruling: plan-phase siblings only), and `topology:"plan-fan-in"`
 *      stamped on the group config.
 *   2. The full sequencing invariant — fan-out → barrier → synthesis
 *      (`VerificationHarness._maybeTriggerPlanSynthesis`, triggered off the
 *      SAME `notifyChildTerminal` seam every topology already uses) — proven
 *      against a REAL `VerificationHarness` with a fake
 *      `teamManager.spawnRole` + fake `sessionManager.waitForIdle`/
 *      `getSessionOutput` standing in for the real agent turn. Exactly-once
 *      trigger, failure path, and the `planHash` binding are all pinned here.
 *   3. The plan-fan-in REST gate stack (`/plan-verify`, `/plan-confirm`,
 *      `/plan-reject`) driven directly through `tryHandleSwarmRoute` — same
 *      technique as `tests/swarm-w1-confirm-route-gate.test.ts` — proving the
 *      HARD RULE: no bypass paths, no auto-consume, and orchestrator ruling
 *      #1's rejection path (archived siblings, no auto-retry, one-shot token
 *      burned either way).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type WorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { SwarmGovernor } from "../src/server/agent/swarm-governor.ts";
import { createPlanFanInSwarm, PLAN_ONLY_PROMPT_PREFIX, PLAN_FAN_IN_VERIFY_PLACEHOLDER } from "../src/server/agent/swarm-plan-fan-in.ts";
import { VerificationHarness } from "../src/server/agent/verification-harness.ts";
import { tryHandleSwarmRoute, type SwarmRouteDeps } from "../src/server/agent/swarm-routes.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";
import { SessionSecretStore } from "../src/server/auth/session-secret.ts";
import { __resetOperatorConfirmationsForTests } from "../src/server/auth/operator-confirmation.ts";

// ── 1. createPlanFanInSwarm — wrapper shape ────────────────────────────────

let tmpRoot: string;
let stateDir: string;
let configDir: string;
let goalStore: GoalStore;
let goalManager: GoalManager;
let swarmGroupStore: SwarmGroupStore;
let workflowStore: WorkflowStore;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w4-plan-fan-in-"));
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

function makeFakeBestOfNHarness(cap: number) {
	const swarmGovernor = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
	let running = 0;
	const harness: any = {
		swarmGovernor,
		requestChildStart(goalId: string, onStart?: () => void): "started" | "capacity-blocked" {
			if (running >= cap) return "capacity-blocked";
			running++;
			onStart?.();
			return "started";
		},
		hardKillSwarmNode: async () => {},
	};
	return harness;
}

function fakeDeps(harness: any) {
	const ctx: any = { goalStore, swarmGroupStore, workflowStore };
	return {
		getContextForGoal: (_goalId: string) => ctx,
		getGoalManagerForGoal: (_goalId: string) => goalManager,
		harness,
	};
}

describe("createPlanFanInSwarm — thin wrapper over createBestOfNSwarm", () => {
	it("fans out N planning-only siblings sharing the SAME wrapped spec, tagged topology:'plan-fan-in', with the reviewer promptProfile stamped", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const harness = makeFakeBestOfNHarness(8);
		const result = await createPlanFanInSwarm(fakeDeps(harness), {
			parentGoalId: parent.id,
			title: "Design the caching layer",
			spec: "Design a caching layer for the search endpoint.",
			fanOut: 3,
		});
		assert.equal(result.siblingGoalIds.length, 3);
		for (const id of result.siblingGoalIds) {
			const g = goalStore.get(id)!;
			assert.equal(g.swarmGroup, result.swarmGroup);
			assert.equal(g.parentGoalId, parent.id);
			assert.ok(g.spec.startsWith(PLAN_ONLY_PROMPT_PREFIX), "every plan-phase sibling must receive the planning-only prefix");
			assert.ok(g.spec.includes("Design a caching layer for the search endpoint."), "the underlying spec must still be present verbatim");
			assert.equal(g.promptProfile, "reviewer", "orchestrator ruling: plan-phase siblings get the reviewer promptProfile");
		}
		const rec = swarmGroupStore.get(result.swarmGroup)!;
		assert.equal((rec.config as any).topology, "plan-fan-in");
		assert.equal((rec.config as any).verifyCommand, PLAN_FAN_IN_VERIFY_PLACEHOLDER, "verifyCommand is a placeholder — never actually run for a plan-fan-in group");
		assert.equal((rec.config as any).earlyKill, false, "early-kill has no meaning for a plan-only fan-out");
	});

	it("applies small default token/wall-clock budgets when the caller omits them (design §1.1: Cp ≈ 0.1×C)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const harness = makeFakeBestOfNHarness(8);
		const result = await createPlanFanInSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared planning prompt.", fanOut: 2,
		});
		const rec = swarmGroupStore.get(result.swarmGroup)!;
		assert.equal((rec.config as any).tokenBudgetPerNode, 20_000);
		assert.equal((rec.config as any).wallClockMsPerNode, 10 * 60_000);
	});

	it("rejects fanOut<2 — one candidate plan is a solo goal, not a fan-out", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const harness = makeFakeBestOfNHarness(8);
		await assert.rejects(() => createPlanFanInSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "x", fanOut: 1,
		}));
	});
});

// ── 2. Barrier-fire → synthesis sequencing ─────────────────────────────────

interface SpawnRoleCall { goalId: string; role: string; task: string }

function makeSynthesisHarness(opts: {
	spawnRoleImpl?: (call: SpawnRoleCall) => Promise<{ sessionId: string; worktreePath?: string }>;
	waitForIdleImpl?: (sessionId: string) => Promise<void>;
	sessionOutputs?: Record<string, string>;
}) {
	const ctx = { goalStore, swarmGroupStore };
	const projectContextManager: any = { getContextForGoal: (_id: string) => ctx };
	const spawnRoleCalls: SpawnRoleCall[] = [];
	const teamManager: any = {
		spawnRole: async (goalId: string, role: string, task: string) => {
			const call = { goalId, role, task };
			spawnRoleCalls.push(call);
			if (opts.spawnRoleImpl) return opts.spawnRoleImpl(call);
			return { sessionId: `synth-session-${spawnRoleCalls.length}` };
		},
		getTeamState: () => ({ teamLeadSessionId: "fake-team-lead" }),
	};
	const sessionManager: any = {
		waitForStreaming: async () => {},
		waitForIdle: async (sessionId: string) => {
			if (opts.waitForIdleImpl) return opts.waitForIdleImpl(sessionId);
		},
		getSessionOutput: async (sessionId: string) => opts.sessionOutputs?.[sessionId] ?? "",
	};
	const harness = new VerificationHarness(
		stateDir, undefined, () => {}, { get: () => null, getAll: () => [] } as any,
		undefined, sessionManager, teamManager, undefined, projectContextManager, undefined,
	);
	return { harness, spawnRoleCalls };
}

function makePlanSibling(id: string, opts: { parentGoalId: string; rootGoalId: string; swarmGroup: string; teamLeadSessionId?: string }) {
	goalStore.put({
		id, title: id, cwd: tmpRoot, state: "in-progress", spec: "", createdAt: 0, updatedAt: 0,
		...opts,
	} as any);
}

describe("SWARM-W4.5 — VerificationHarness._maybeTriggerPlanSynthesis (barrier-fire trigger)", () => {
	it("does nothing for a best-of-n (non-plan-fan-in) group, even once its barrier fires", async () => {
		const { harness, spawnRoleCalls } = makeSynthesisHarness({});
		swarmGroupStore.createGroup("grp-bestofn", ["sib-a"], "root", { parentGoalId: "root", topology: "best-of-n" });
		makePlanSibling("sib-a", { parentGoalId: "root", rootGoalId: "root", swarmGroup: "grp-bestofn" });

		await harness.notifyChildTerminal("sib-a", "done");

		const rec = swarmGroupStore.get("grp-bestofn")!;
		assert.equal(rec.barrierFired, true);
		assert.equal(rec.synthesis, undefined, "a best-of-n group must never get a synthesis record");
		assert.equal(spawnRoleCalls.length, 0);
	});

	it("fires the synthesis role exactly once, the instant the LAST plan sibling goes terminal — not before, not twice", async () => {
		const { harness, spawnRoleCalls } = makeSynthesisHarness({
			sessionOutputs: { "synth-session-1": "Merged plan: do X then Y." },
		});
		swarmGroupStore.createGroup("grp-plan", ["sib-a", "sib-b"], "root", { parentGoalId: "parent-1", topology: "plan-fan-in" });
		makePlanSibling("sib-a", { parentGoalId: "parent-1", rootGoalId: "root", swarmGroup: "grp-plan", teamLeadSessionId: "sess-a" });
		makePlanSibling("sib-b", { parentGoalId: "parent-1", rootGoalId: "root", swarmGroup: "grp-plan", teamLeadSessionId: "sess-b" });

		await harness.notifyChildTerminal("sib-a", "done");
		assert.equal(spawnRoleCalls.length, 0, "must not synthesize before every sibling is terminal");
		assert.equal(swarmGroupStore.get("grp-plan")!.synthesis, undefined);

		await harness.notifyChildTerminal("sib-b", "done");
		assert.equal(spawnRoleCalls.length, 1, "must synthesize exactly once, the instant the barrier fires");
		assert.equal(spawnRoleCalls[0].goalId, "parent-1", "synthesis spawns into the PARENT's team, not a sibling's");
		assert.equal(spawnRoleCalls[0].role, "reviewer");

		// Wait for the fire-and-forget synthesis promise to settle (no await
		// handle is returned from notifyChildTerminal — poll the store).
		await new Promise((r) => setTimeout(r, 20));
		const rec = swarmGroupStore.get("grp-plan")!;
		assert.equal(rec.synthesis?.status, "done");
		assert.equal(rec.synthesis?.output, "Merged plan: do X then Y.");
		assert.equal(rec.synthesis?.planHash, createHash("sha256").update("Merged plan: do X then Y.").digest("base64url"));
		assert.equal(rec.synthesis?.sessionId, "synth-session-1");
	});

	it("a second terminal notification for an already-fired group does NOT re-trigger synthesis (idempotent-by-construction, no flag needed)", async () => {
		const { harness, spawnRoleCalls } = makeSynthesisHarness({
			sessionOutputs: { "synth-session-1": "Plan." },
		});
		swarmGroupStore.createGroup("grp-plan2", ["sib-a"], "root", { parentGoalId: "parent-2", topology: "plan-fan-in" });
		makePlanSibling("sib-a", { parentGoalId: "parent-2", rootGoalId: "root", swarmGroup: "grp-plan2" });

		await harness.notifyChildTerminal("sib-a", "done");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(spawnRoleCalls.length, 1);

		// Re-notify the SAME sibling terminal again (e.g. a duplicate event) —
		// `recordArtifact` is idempotent-by-goalId and the barrier was already
		// fired, so the `!wasBarrierFired && record.barrierFired` guard at the
		// call site must not re-fire.
		await harness.notifyChildTerminal("sib-a", "done");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(spawnRoleCalls.length, 1, "must still be exactly one spawnRole call");
	});

	it("records a failure (never throws) when the synthesis session goes idle with empty output — surfaces for human triage, no silent retry", async () => {
		const { harness } = makeSynthesisHarness({
			sessionOutputs: { "synth-session-1": "   " }, // whitespace-only → empty after trim
		});
		swarmGroupStore.createGroup("grp-plan3", ["sib-a"], "root", { parentGoalId: "parent-3", topology: "plan-fan-in" });
		makePlanSibling("sib-a", { parentGoalId: "parent-3", rootGoalId: "root", swarmGroup: "grp-plan3" });

		await assert.doesNotReject(() => harness.notifyChildTerminal("sib-a", "done"));
		await new Promise((r) => setTimeout(r, 20));
		const rec = swarmGroupStore.get("grp-plan3")!;
		assert.equal(rec.synthesis?.status, "failed");
		assert.ok(rec.synthesis?.error);
	});

	it("records a failure when spawnRole itself throws (e.g. parent has no active team)", async () => {
		const { harness } = makeSynthesisHarness({
			spawnRoleImpl: async () => { throw new Error("No active team for goal: parent-4"); },
		});
		swarmGroupStore.createGroup("grp-plan4", ["sib-a"], "root", { parentGoalId: "parent-4", topology: "plan-fan-in" });
		makePlanSibling("sib-a", { parentGoalId: "parent-4", rootGoalId: "root", swarmGroup: "grp-plan4" });

		await assert.doesNotReject(() => harness.notifyChildTerminal("sib-a", "done"));
		await new Promise((r) => setTimeout(r, 20));
		const rec = swarmGroupStore.get("grp-plan4")!;
		assert.equal(rec.synthesis?.status, "failed");
		assert.match(rec.synthesis?.error ?? "", /No active team/);
	});

	it("the synthesis prompt embeds every plan sibling's distilled output, ordered by capturedAt", async () => {
		const { harness, spawnRoleCalls } = makeSynthesisHarness({});
		swarmGroupStore.createGroup("grp-plan5", ["sib-a", "sib-b"], "root", { parentGoalId: "parent-5", topology: "plan-fan-in" });
		makePlanSibling("sib-a", { parentGoalId: "parent-5", rootGoalId: "root", swarmGroup: "grp-plan5", teamLeadSessionId: "sess-a" });
		makePlanSibling("sib-b", { parentGoalId: "parent-5", rootGoalId: "root", swarmGroup: "grp-plan5", teamLeadSessionId: "sess-b" });

		// One `getSessionOutput` stub serves BOTH roles it's called for here:
		// capturing each plan sibling's OWN output (keyed by teamLeadSessionId,
		// inside `_captureSwarmArtifactIfTagged`) AND the synthesis session's
		// final output (keyed by the id `spawnRole` returns) — distinct outputs
		// per key make both call sites individually provable.
		(harness as any).sessionManager.getSessionOutput = async (sessionId: string) => {
			if (sessionId === "sess-a") return "PLAN A TEXT";
			if (sessionId === "sess-b") return "PLAN B TEXT";
			return "Final plan.";
		};

		await harness.notifyChildTerminal("sib-a", "done");
		await harness.notifyChildTerminal("sib-b", "done");
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(spawnRoleCalls.length, 1);
		assert.match(spawnRoleCalls[0].task, /PLAN A TEXT/);
		assert.match(spawnRoleCalls[0].task, /PLAN B TEXT/);
	});
});

// ── 3. REST gate stack — /plan-verify, /plan-confirm, /plan-reject ────────

interface RouteHarness {
	tmpRoot: string;
	goalManager: GoalManager;
	parentId: string;
	sib1Id: string;
	sib2Id: string;
	swarmGroup: string;
	humanCookieHeader: string;
	teardownCalls: string[];
	archiveCalls: string[];
	authAsTeamLead(): Record<string, string>;
	cleanup(): void;
	call(method: string, pathname: string, body?: unknown, headers?: Record<string, string | string[] | undefined>): Promise<{ status: number; payload: any }>;
}

async function makeRouteHarness(): Promise<RouteHarness> {
	const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-plan-gate-"));
	const sDir = path.join(tRoot, "state");
	const cDir = path.join(tRoot, "config");
	fs.mkdirSync(sDir);
	fs.mkdirSync(cDir);
	fs.writeFileSync(path.join(cDir, "project.yaml"), yaml.stringify({}));

	const gStore = new GoalStore(sDir);
	const cookieStore = new CookieStore(sDir);
	const humanCookieHeader = `bobbit_session=${cookieStore.mint()}`;
	const cfg = new ProjectConfigStore(cDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 }]);
	const gManager = new GoalManager(gStore, wf);

	const parent = await gManager.createGoal("Parent", tRoot, { workflowId: "feature" });
	const swarmGroup = "grp-plan-gate";
	const sib1 = await gManager.createGoal("Plan candidate 1", tRoot, { workflowId: "feature", parentGoalId: parent.id, swarmGroup });
	const sib2 = await gManager.createGoal("Plan candidate 2", tRoot, { workflowId: "feature", parentGoalId: parent.id, swarmGroup });

	const sgStore = new SwarmGroupStore(sDir);
	sgStore.createGroup(swarmGroup, [sib1.id, sib2.id], parent.id, { parentGoalId: parent.id, topology: "plan-fan-in", verifyCommand: PLAN_FAN_IN_VERIFY_PLACEHOLDER });
	sgStore.recordArtifact(swarmGroup, { goalId: sib1.id, output: "plan A", status: "done", verifierScore: null, capturedAt: 1 }, [sib1.id, sib2.id], parent.id);
	sgStore.recordArtifact(swarmGroup, { goalId: sib2.id, output: "plan B", status: "done", verifierScore: null, capturedAt: 2 }, [sib1.id, sib2.id], parent.id);
	sgStore.recordSynthesisStarted(swarmGroup, "synth-sess");
	sgStore.recordSynthesisResult(swarmGroup, { output: "Final synthesized plan.", planHash: createHash("sha256").update("Final synthesized plan.").digest("base64url") });

	const teardownCalls: string[] = [];
	const archiveCalls: string[] = [];
	(gManager as any).archiveGoal = async (id: string) => { archiveCalls.push(id); return gStore.archive(id); };

	const ctx = { goalStore: gStore, swarmGroupStore: sgStore, workflowStore: wf };
	const projectContextManager: any = { getContextForGoal: () => ctx };
	const teamManager: any = {
		getTeamState: (gid: string) => (gid === parent.id ? { teamLeadSessionId: "fake-team-lead" } : undefined),
		teardownTeam: async (gid: string) => { teardownCalls.push(gid); },
	};
	const sessionSecretStore = new SessionSecretStore();
	const sessionManager: any = { sessionSecretStore };
	const verificationHarness: any = {
		requestChildStart: () => "started",
	};

	const baseDeps: SwarmRouteDeps = {
		projectContextManager, verificationHarness, teamManager, sessionManager, cookieStore,
		getGoalAcrossProjects: (gid: string) => gStore.get(gid),
		getGoalManagerForGoal: () => gManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {}, jsonError: () => {}, broadcastToAll: () => {},
	};

	async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string | string[] | undefined> = {}) {
		let status = 200;
		let payload: any;
		const localDeps: SwarmRouteDeps = {
			...baseDeps,
			json: (b, s) => { status = s ?? 200; payload = b; },
			jsonError: (s, err, extra) => { status = s; payload = { error: String((err as any)?.message ?? err), ...(extra ?? {}) }; },
		};
		const req = { method, headers, _body: body } as any as http.IncomingMessage;
		const url = new URL(`http://x${pathname}`);
		const handled = await tryHandleSwarmRoute(req, url, localDeps);
		if (!handled) throw new Error(`route not handled: ${method} ${pathname}`);
		return { status, payload };
	}

	return {
		tmpRoot: tRoot, goalManager: gManager, parentId: parent.id, sib1Id: sib1.id, sib2Id: sib2.id, swarmGroup,
		humanCookieHeader, teardownCalls, archiveCalls,
		authAsTeamLead() {
			return { "x-bobbit-session-secret": sessionSecretStore.getOrCreateSecret("fake-team-lead") };
		},
		cleanup() { try { fs.rmSync(tRoot, { recursive: true, force: true }); } catch { /* best-effort */ } },
		call,
	};
}

let rh: RouteHarness;
beforeEach(async () => {
	__resetOperatorConfirmationsForTests();
	rh = await makeRouteHarness();
});
afterEach(() => rh.cleanup());

describe("SWARM-W4.5 — /plan-verify mints the pre-build gate token", () => {
	it("an agent-only (no human cookie) call gets the synthesized plan back but NO token — cannot self-confirm", async () => {
		const r = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-verify`, undefined, rh.authAsTeamLead());
		assert.equal(r.status, 200);
		assert.equal(r.payload.outcome, "synthesized");
		assert.equal(r.payload.output, "Final synthesized plan.");
		assert.equal(r.payload.confirmationToken, undefined);
	});

	it("a human/UI call mints a one-shot token bound to {swarmGroup, planHash}", async () => {
		const r = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-verify`, undefined, { cookie: rh.humanCookieHeader });
		assert.equal(r.status, 200);
		assert.ok(r.payload.confirmationToken);
		assert.ok(r.payload.planHash);
	});
});

describe("SWARM-W4.5 — /plan-confirm (HARD RULE: no bypass, no auto-consume)", () => {
	it("no auth at all is rejected, no build child created", async () => {
		const r = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`, { confirmationToken: "whatever" });
		assert.equal(Math.floor(r.status / 100), 4);
	});

	it("human cookie present but no token → 403 CONFIRMATION_REQUIRED", async () => {
		const r = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`, {}, { cookie: rh.humanCookieHeader });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "CONFIRMATION_REQUIRED");
	});

	it("garbage token never minted for this group → 403, no build child", async () => {
		const r = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`,
			{ confirmationToken: "not-a-real-token" }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "CONFIRMATION_REQUIRED");
	});

	it("happy path: real token from /plan-verify → spawns ONE ordinary (non-swarm-tagged) build child; the token cannot be reused", async () => {
		const verify = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-verify`, undefined, { cookie: rh.humanCookieHeader });
		const token = verify.payload.confirmationToken;

		const confirm = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(confirm.status, 201);
		assert.ok(confirm.payload.buildGoalId);
		const build = rh.goalManager.getGoal(confirm.payload.buildGoalId)!;
		assert.equal(build.swarmGroup, undefined, "the build child must be an ordinary, non-swarm-tagged goal (design §5)");
		assert.equal(build.parentGoalId, rh.parentId);
		assert.equal(build.spec, "Final synthesized plan.");

		// Re-confirming with the SAME (now-burned) token must fail.
		const replay = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(replay.status, 409, "already confirmed — one build per group");
	});
});

describe("SWARM-W4.5 — /plan-reject (orchestrator ruling #1: plan-rejection path)", () => {
	it("consumes the token, archives the plan siblings, records planRejectedAt — no build ever created", async () => {
		const verify = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-verify`, undefined, { cookie: rh.humanCookieHeader });
		const token = verify.payload.confirmationToken;

		const reject = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-reject`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(reject.status, 200);
		assert.equal(reject.payload.rejected, true);
		assert.deepEqual(new Set(reject.payload.archivedSiblingIds), new Set([rh.sib1Id, rh.sib2Id]));
		assert.ok(rh.archiveCalls.includes(rh.sib1Id) && rh.archiveCalls.includes(rh.sib2Id), "both plan siblings must be archived, not deleted (retained + visible for manual reuse)");

		// No auto-retry, no fallback build: confirming afterward is rejected.
		const confirmAfterReject = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(confirmAfterReject.status, 409);
	});

	it("the SAME token cannot be used for both confirm and reject — exactly one decision", async () => {
		const verify = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-verify`, undefined, { cookie: rh.humanCookieHeader });
		const token = verify.payload.confirmationToken;

		const confirm = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-confirm`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(confirm.status, 201);

		// The route's own `buildGoalId` guard fires first (a more informative
		// "already decided" error than a generic bad-token 403) — either way,
		// the outcome is the SAME invariant: this token can never also start a
		// reject after it already started a build.
		const rejectAfterConfirm = await rh.call(
			"POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/plan-reject`,
			{ confirmationToken: token }, { cookie: rh.humanCookieHeader },
		);
		assert.equal(rejectAfterConfirm.status, 409);
		assert.equal(rejectAfterConfirm.payload.code, "ALREADY_CONFIRMED");
	});
});

describe("SWARM-W4.5 — best-of-n /verify and /confirm refuse a plan-fan-in group", () => {
	it("WRONG_TOPOLOGY on /verify and /confirm; plan-fan-in's own routes are unaffected", async () => {
		const verifyResp = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/verify`, undefined, { cookie: rh.humanCookieHeader });
		assert.equal(verifyResp.status, 400);
		assert.equal(verifyResp.payload.code, "WRONG_TOPOLOGY");

		const confirmResp = await rh.call("POST", `/api/goals/${rh.parentId}/swarm-groups/${rh.swarmGroup}/confirm`, { winnerGoalId: rh.sib1Id }, { cookie: rh.humanCookieHeader });
		assert.equal(confirmResp.status, 400);
		assert.equal(confirmResp.payload.code, "WRONG_TOPOLOGY");
	});
});
