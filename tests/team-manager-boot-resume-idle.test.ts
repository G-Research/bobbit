/**
 * Tests for TeamManager._bootResumeIdleTeamLeads — the one-shot post-boot
 * wake-up that nudges idle team-leads whose goal has concrete outstanding
 * work (failed gate or open task), so the operator doesn't have to wait
 * for the 5-min stuck-sweep tick after a gateway restart.
 *
 * Contract:
 *  - Idle team-lead + failed gate     → nudge fires (with gate count in summary).
 *  - Idle team-lead + open task       → nudge fires (with task count in summary).
 *  - Idle team-lead + dormant goal    → NOT nudged (no concrete work).
 *  - Paused / complete / archived     → NOT nudged (shouldSkipNudge intercepts).
 *  - Non-idle team-lead               → NOT nudged.
 *  - nudgePending set after fire so the stuck-sweep doesn't double-fire.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-boot-resume-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

interface MockGate { gateId: string; status: "passed" | "failed" | "pending" }
interface MockTask { id: string; goalId: string; state: "todo" | "in-progress" | "complete" }
interface MockGoal { id: string; archived?: boolean; paused?: boolean; state?: string; title?: string }

function buildHarness(opts: {
	leadStatus?: "idle" | "streaming" | "terminated";
	gates?: MockGate[];
	tasks?: MockTask[];
	goal?: Partial<MockGoal>;
}) {
	const goal: MockGoal = { id: "g1", state: "in-progress", title: "G1", archived: false, paused: false, ...opts.goal };
	const lead = {
		id: "lead-1", goalId: goal.id,
		status: opts.leadStatus ?? "idle",
		rpcClient: { onEvent: () => () => {} },
	};
	const sessionManager: any = {
		getSession: (id: string) => id === lead.id ? lead : undefined,
		enqueuePrompt: mock.fn(() => undefined),
		addTerminationListener: () => {},
	};
	const ctx = {
		goalStore: { getAll: () => [goal], get: (gid: string) => gid === goal.id ? goal : undefined },
		gateStore: { getGatesForGoal: () => opts.gates ?? [] },
		taskStore: { getByGoalId: () => opts.tasks ?? [] },
		teamStore: { getAll: () => [], remove: () => {} },
		sessionStore: { getAll: () => [] },
	};
	const projectContextManager: any = {
		all: () => [ctx],
		getContextForGoal: (gid: string) => gid === goal.id ? ctx : undefined,
	};
	const tm = new TeamManager(sessionManager, { projectContextManager } as any) as any;
	tm.teams = new Map();
	tm.teams.set(goal.id, { goalId: goal.id, teamLeadSessionId: lead.id, agents: [] });
	tm.nudgePending = new Map();
	tm.lastNudgeAtPerGoal = new Map();
	tm.leadIdleSinceByGoal = new Map([[goal.id, Date.now()]]);
	tm.verificationHarness = { getActiveVerifications: () => [] };
	tm.resolveGoal = (gid: string) => gid === goal.id ? goal : undefined;
	tm.resolveGoalManager = () => ({ listLiveGoals: () => [goal] });
	return { tm, sessionManager, goal, lead };
}

describe("TeamManager._bootResumeIdleTeamLeads", () => {
	it("nudges idle team-lead with a failed gate", () => {
		const { tm, sessionManager } = buildHarness({
			gates: [{ gateId: "implementation", status: "failed" }],
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 1);
		const [, msg] = sessionManager.enqueuePrompt.mock.calls[0].arguments;
		assert.match(msg, /\[BOOT-RESUME\]/);
		assert.match(msg, /1 failed gate/);
	});

	it("nudges idle team-lead with an open task", () => {
		const { tm, sessionManager, goal } = buildHarness({
			tasks: [{ id: "t1", goalId: "g1", state: "todo" }, { id: "t2", goalId: "g1", state: "in-progress" }, { id: "t3", goalId: "g1", state: "complete" }],
		});
		void goal;
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 1);
		const [, msg] = sessionManager.enqueuePrompt.mock.calls[0].arguments;
		assert.match(msg, /2 open task/);
	});

	it("does NOT nudge a dormant goal (all gates passed, no open tasks)", () => {
		const { tm, sessionManager } = buildHarness({
			gates: [{ gateId: "implementation", status: "passed" }],
			tasks: [{ id: "t1", goalId: "g1", state: "complete" }],
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 0);
	});

	it("does NOT nudge a paused goal even with a failed gate", () => {
		const { tm, sessionManager } = buildHarness({
			gates: [{ gateId: "implementation", status: "failed" }],
			goal: { paused: true },
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 0);
	});

	it("does NOT nudge a non-idle team-lead", () => {
		const { tm, sessionManager } = buildHarness({
			leadStatus: "streaming",
			gates: [{ gateId: "implementation", status: "failed" }],
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 0);
	});

	it("does NOT nudge a complete goal", () => {
		const { tm, sessionManager } = buildHarness({
			gates: [{ gateId: "implementation", status: "failed" }],
			goal: { state: "complete" },
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(sessionManager.enqueuePrompt.mock.callCount(), 0);
	});

	it("marks nudgePending so the stuck-sweep does not double-fire", () => {
		const { tm } = buildHarness({
			gates: [{ gateId: "implementation", status: "failed" }],
		});
		tm._bootResumeIdleTeamLeads();
		assert.equal(tm.nudgePending.get("g1"), true);
		assert.ok(tm.lastNudgeAtPerGoal.get("g1") > 0);
	});
});
