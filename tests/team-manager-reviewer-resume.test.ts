/**
 * Regression test for Bug 1 — "spurious team-lead nudges for reviewer
 * sessions after server restart".
 *
 * When the gateway restarts mid-verification, `TeamManager.resubscribeTeamEvents()`
 * walks the persisted `entry.agents` and re-attaches an `agent_end → notifyTeamLead`
 * listener to every restored agent. Pre-fix, that listener was attached to
 * reviewer sessions too — so when a reviewer ended its turn the team lead got
 * a spurious "Agent ... has finished" nudge.
 *
 * The fix tags reviewer agents with `kind: "reviewer"` (persisted), and
 * `resubscribeTeamEvents` skips them. `notifyTeamLead` also has a defensive
 * guard that early-returns for reviewer agents (covers old persisted records
 * that pre-date the `kind` field).
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-reviewer-resume-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");
const TEAM_STORE_FILE = path.join(TEST_PI_DIR, "state", "team-state.json");

function clearTeamStore() {
	try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ }
}

function createMockGoal(): any {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp/test-project",
		state: "in-progress",
		spec: "# spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/test",
		repoPath: "/tmp/test-repo",
	};
}

function createMockSessionManager(goals: Map<string, any>): any {
	const sessions = new Map<string, any>();
	return {
		goalManager: {
			getGoal: (id: string) => goals.get(id),
			updateGoal: (id: string, updates: any) => {
				const g = goals.get(id); if (g) Object.assign(g, updates); return !!g;
			},
		},
		getSession: (id: string) => sessions.get(id),
		terminateSession: mock.fn(async (id: string) => { sessions.delete(id); return true; }),
		enqueuePrompt: mock.fn((_id: string, _msg: string, _opts?: any) => {}),
		deliverLiveSteer: mock.fn(async (_id: string, _msg: string) => {}),
		_sessions: sessions,
	};
}

function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "x", toolPolicies: {}, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "x", toolPolicies: {}, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
		["reviewer", { name: "reviewer", label: "Reviewer", promptTemplate: "x", toolPolicies: {}, accessory: "monocle", createdAt: 0, updatedAt: 0 }],
	]);
	return {
		get: (n: string) => roles.get(n),
		getAll: () => Array.from(roles.values()),
		put: (r: any) => roles.set(r.name, r),
		remove: (n: string) => roles.delete(n),
		reload: () => {},
		update: () => true,
	};
}

const _created: any[] = [];

after(() => {
	for (const tm of _created) {
		for (const [, t] of (tm as any).idleNudgeTimers) clearTimeout(t);
		(tm as any).idleNudgeTimers.clear();
		for (const [, t] of (tm as any).noWorkersNudgeTimers ?? []) clearInterval(t);
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
});

/**
 * Make an event-emitting fake session. Tests call `fire(event)` to simulate
 * the agent firing an event; every onEvent subscriber registered receives it.
 */
function makeFakeSession(id: string, status = "idle") {
	const cbs: Array<(e: any) => void> = [];
	const session = {
		id,
		status,
		cwd: "/tmp/x",
		clients: new Set<any>(),
		rpcClient: {
			prompt: mock.fn(async () => {}),
			onEvent: (cb: (e: any) => void) => {
				cbs.push(cb);
				return () => {
					const i = cbs.indexOf(cb);
					if (i >= 0) cbs.splice(i, 1);
				};
			},
		},
	};
	return { session, fire: (e: any) => { for (const cb of [...cbs]) cb(e); } };
}

describe("TeamManager reviewer resume — Bug 1 (spurious nudges)", () => {
	it("does NOT fire notifyTeamLead for a persisted reviewer agent on agent_end after restart", async (t) => {
		// The worker idle nudge is debounced 5s (agent_end schedules a one-shot
		// timer cancelled by agent_start). Use fake timers to advance past that
		// window deterministically instead of waiting in real time.
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		clearTeamStore();
		const goals = new Map<string, any>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);

		// Pre-seed the persisted team state with one team lead, one worker
		// (kind: "worker"), and one reviewer (kind: "reviewer"). This is
		// what registerReviewerSession() now writes.
		fs.mkdirSync(path.dirname(TEAM_STORE_FILE), { recursive: true });
		const persisted = [{
			goalId: "goal-1",
			teamLeadSessionId: "tl-1",
			agents: [
				{ sessionId: "worker-1", role: "coder", kind: "worker", task: "code", createdAt: Date.now() },
				{ sessionId: "reviewer-1", role: "reviewer", kind: "reviewer", task: "Verification review: Code quality", createdAt: Date.now() },
			],
			maxConcurrent: 12,
		}];
		fs.writeFileSync(TEAM_STORE_FILE, JSON.stringify(persisted, null, 2));

		// Wire fake live sessions so resubscribeTeamEvents finds them.
		const tl = makeFakeSession("tl-1", "idle");
		const worker = makeFakeSession("worker-1", "streaming");
		const reviewer = makeFakeSession("reviewer-1", "streaming");
		sm._sessions.set("tl-1", tl.session);
		sm._sessions.set("worker-1", worker.session);
		sm._sessions.set("reviewer-1", reviewer.session);

		const config = {
			roleStore: createMockRoleStore(),
			colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
			taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [], createTask: (_g: any, t: any) => t, getTask: () => undefined, updateTask: () => true, deleteTask: () => true },
		};
		const tm = new TeamManager(sm, config);
		_created.push(tm);

		// Verify restore reconstructed the kind field correctly.
		const state = tm.getTeamState("goal-1");
		assert.ok(state, "team state restored");
		const internalAgents = (tm as any).teams.get("goal-1").agents;
		assert.equal(internalAgents.find((a: any) => a.sessionId === "worker-1").kind, "worker");
		assert.equal(internalAgents.find((a: any) => a.sessionId === "reviewer-1").kind, "reviewer");

		// Phase 2 — re-attach event listeners (this is the regression site).
		tm.resubscribeTeamEvents();

		// Fire agent_end on the reviewer first. With the fix, no listener is
		// attached for reviewer agents → no enqueuePrompt / deliverLiveSteer call.
		reviewer.fire({ type: "agent_end" });
		// Advance past the 5s worker idle-nudge debounce window. Reviewers attach
		// no listener, so nothing should fire for them.
		t.mock.timers.tick(6_000);

		assert.equal(
			sm.enqueuePrompt.mock.callCount(), 0,
			"reviewer agent_end after restart must NOT enqueue a team-lead nudge",
		);
		assert.equal(
			sm.deliverLiveSteer.mock.callCount(), 0,
			"reviewer agent_end after restart must NOT deliver a steer to the team lead",
		);

		// Now fire agent_end on the worker — this MUST trigger a nudge once the
		// 5s idle-nudge debounce window elapses.
		worker.fire({ type: "agent_end" });
		t.mock.timers.tick(6_000);

		const totalNudges =
			sm.enqueuePrompt.mock.callCount() + sm.deliverLiveSteer.mock.callCount();
		assert.equal(totalNudges, 1, "worker agent_end must trigger exactly one team-lead nudge");

		t.mock.timers.reset();
	});

	it("notifyTeamLead defensive guard skips reviewer agents (back-compat for entries missing kind)", async () => {
		clearTeamStore();
		const goals = new Map<string, any>();
		goals.set("goal-2", createMockGoal());
		goals.get("goal-2").id = "goal-2";
		const sm = createMockSessionManager(goals);

		// Pre-seed a persisted entry where the reviewer record DOES NOT have
		// a `kind` field (simulating an entry written before the fix). The
		// guard should fall back to checking `role === "reviewer"`.
		fs.mkdirSync(path.dirname(TEAM_STORE_FILE), { recursive: true });
		const persisted = [{
			goalId: "goal-2",
			teamLeadSessionId: "tl-2",
			agents: [
				{ sessionId: "reviewer-2", role: "reviewer", task: "Verification review: legacy", createdAt: Date.now() },
				// no kind field
			],
			maxConcurrent: 12,
		}];
		fs.writeFileSync(TEAM_STORE_FILE, JSON.stringify(persisted, null, 2));

		const tl = makeFakeSession("tl-2", "idle");
		sm._sessions.set("tl-2", tl.session);

		const config = {
			roleStore: createMockRoleStore(),
			colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
			taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [], createTask: (_g: any, t: any) => t, getTask: () => undefined, updateTask: () => true, deleteTask: () => true },
		};
		const tm = new TeamManager(sm, config);
		_created.push(tm);

		// Even though restore now defaults absent kind to "worker", the role
		// is still "reviewer" — call notifyTeamLead directly to assert the
		// defensive guard catches it.
		await (tm as any).notifyTeamLead("goal-2", "reviewer-2", "reviewer", "reviewer-rev2-sho");

		assert.equal(sm.enqueuePrompt.mock.callCount(), 0, "defensive guard must block notify for reviewer role");
		assert.equal(sm.deliverLiveSteer.mock.callCount(), 0, "defensive guard must block steer for reviewer role");
	});
});
