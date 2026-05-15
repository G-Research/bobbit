/**
 * Regression test: boot-resume must not surface unhandled rejections when the
 * prompt RPC to a restored idle team-lead times out.
 *
 * Symptom (pre-fix):
 *   [gateway] Unhandled rejection: Error: Command timed out: prompt
 *       at Timeout._onTimeout (.../rpc-bridge.js:296:24)
 *
 * Root cause: `TeamManager._bootResumeIdleTeamLeads()` dispatched
 * `sessionManager.enqueuePrompt(...)` (async, may reject after 30s) without
 * awaiting it inside a try/catch. The fix made the helper `async`, awaits
 * each enqueue inside its own try/catch, clears `nudgePending` on failure,
 * and logs a clear error. `resubscribeTeamEvents` calls it as fire-and-
 * observed with a defensive `.catch`.
 *
 * This test exercises the helper directly, mocking `enqueuePrompt` to reject
 * with the same timeout error.
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-boot-resume-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

function mockRoleStore(): any {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "x", toolPolicies: {}, accessory: "crown", createdAt: 0, updatedAt: 0 }],
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

function mockColorStore(): any {
	return { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) };
}

function mockTaskManager(): any {
	return {
		getTasksByGoal: () => [],
		getTasksForSession: () => [],
		createTask: (_g: any, t: any) => t,
		getTask: () => undefined,
		updateTask: () => true,
		deleteTask: () => true,
	};
}

function mockSessionManager(opts: { enqueueImpl: (id: string, msg: string, o?: any) => Promise<void> }): any {
	const sessions = new Map<string, any>();
	return {
		getSession: (id: string) => sessions.get(id),
		enqueuePrompt: mock.fn(opts.enqueueImpl),
		deliverLiveSteer: mock.fn(async () => {}),
		terminateSession: mock.fn(async () => true),
		_sessions: sessions,
	};
}

/**
 * Build a fake project context with controllable gate/task fixtures and a
 * goal record. Used for both PCM resolution paths in TeamManager.
 */
function makeProjectContextManager(opts: {
	goalId: string;
	failedGates?: number;
	openTasks?: number;
	goalState?: string;
	archived?: boolean;
}): any {
	const goal = {
		id: opts.goalId,
		title: "Boot Resume Test Goal",
		state: opts.goalState ?? "in-progress",
		archived: opts.archived ?? false,
		cwd: "/tmp/x",
		spec: "# spec",
		createdAt: 0,
		updatedAt: 0,
		team: true,
		branch: "feat/x",
	};
	const gates = Array.from({ length: opts.failedGates ?? 0 }, (_, i) => ({
		id: `gate-${i}`,
		goalId: opts.goalId,
		status: "failed",
	}));
	const tasks = Array.from({ length: opts.openTasks ?? 0 }, (_, i) => ({
		id: `task-${i}`,
		goalId: opts.goalId,
		state: "todo",
	}));
	const ctx = {
		gateStore: { getGatesForGoal: (_g: string) => gates },
		taskStore: { getByGoalId: (_g: string) => tasks },
		goalStore: { get: (g: string) => (g === opts.goalId ? goal : undefined) },
		goalManager: { getGoal: (g: string) => (g === opts.goalId ? goal : undefined), updateGoal: () => true },
		teamStore: { getAll: () => [], save: () => {}, remove: () => {} },
	};
	return {
		getContextForGoal: (g: string) => (g === opts.goalId ? ctx : null),
		all: () => [ctx],
	};
}

const _created: any[] = [];
after(() => {
	for (const tm of _created) {
		for (const [, t] of (tm as any).idleNudgeTimers ?? []) clearTimeout(t);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, t] of (tm as any).noWorkersNudgeTimers ?? []) clearInterval(t);
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
});

/**
 * Build a TeamManager wired with a single restored team:
 *   - one team-lead session in `idle` state
 *   - one failed gate or open task (controllable)
 * `enqueueImpl` controls the behaviour of `sessionManager.enqueuePrompt`.
 */
function buildHarness(opts: {
	goalId?: string;
	teamLeadSessionId?: string;
	failedGates?: number;
	openTasks?: number;
	enqueueImpl: (id: string, msg: string, o?: any) => Promise<void>;
}) {
	const goalId = opts.goalId ?? "g1";
	const teamLeadSessionId = opts.teamLeadSessionId ?? "tl-1";

	const sm = mockSessionManager({ enqueueImpl: opts.enqueueImpl });
	const fakeTl = {
		id: teamLeadSessionId,
		status: "idle",
		cwd: "/tmp/x",
		clients: new Set<any>(),
		rpcClient: { prompt: async () => {}, onEvent: () => () => {} },
	};
	sm._sessions.set(teamLeadSessionId, fakeTl);

	const pcm = makeProjectContextManager({
		goalId,
		failedGates: opts.failedGates ?? 1,
		openTasks: opts.openTasks ?? 0,
	});

	const config = {
		roleStore: mockRoleStore(),
		colorStore: mockColorStore(),
		taskManager: mockTaskManager(),
		projectContextManager: pcm,
	};
	const tm = new TeamManager(sm, config);
	_created.push(tm);

	// Directly seed the in-memory team registry; bypass restoreTeams() which
	// walks per-project team stores. We only need the runtime team entry.
	(tm as any).teams.set(goalId, {
		goalId,
		teamLeadSessionId,
		agents: [],
		maxConcurrent: 12,
	});

	return { tm, sm, goalId, teamLeadSessionId };
}

describe("TeamManager._bootResumeIdleTeamLeads — RPC timeout handling", () => {
	it("does not reject when enqueuePrompt times out; clears nudgePending; logs error", async () => {
		const enqueue = async (_id: string, _msg: string) => {
			throw new Error("Command timed out: prompt");
		};
		const { tm, sm, goalId, teamLeadSessionId } = buildHarness({ enqueueImpl: enqueue });

		// Capture console.error to assert it logs goal/session/timeout.
		const errSpy = mock.method(console, "error", () => {});

		// Surface any escaped unhandled rejection as a test failure rather than
		// crashing the runner.
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			await assert.doesNotReject(
				(tm as any)._bootResumeIdleTeamLeads(),
				"boot-resume must swallow per-team RPC failures",
			);
			// Let any deferred microtasks settle so a leaked rejection would surface.
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			process.off("unhandledRejection", onUnhandled);
			errSpy.mock.restore();
		}

		assert.equal(unhandled.length, 0, "no unhandled rejection must escape the helper");
		assert.equal(
			sm.enqueuePrompt.mock.callCount(), 1,
			"enqueuePrompt must be attempted exactly once for the idle team-lead",
		);
		assert.equal(sm.enqueuePrompt.mock.calls[0]!.arguments[0], teamLeadSessionId);

		// On failure, nudgePending must NOT remain `true` (a later idle/stuck
		// sweep needs to be able to retry).
		assert.notEqual(
			(tm as any).nudgePending.get(goalId), true,
			"nudgePending must be cleared after enqueue failure so a retry can happen later",
		);

		// At least one error log must mention the goal, the session, and the
		// timeout error.
		const matched = errSpy.mock.calls.some((c) => {
			const line = c.arguments.map((a) => String(a)).join(" ");
			return line.includes(goalId) && line.includes(teamLeadSessionId) && /timed out: prompt/i.test(line);
		});
		assert.ok(
			matched,
			`expected a console.error mentioning goal=${goalId}, session=${teamLeadSessionId}, and the timeout — got: ` +
				JSON.stringify(errSpy.mock.calls.map((c) => c.arguments)),
		);
	});

	it("happy path: a successful enqueue marks nudgePending true and reports one delivery", async () => {
		const enqueue = async (_id: string, _msg: string) => {};
		const { tm, sm, goalId } = buildHarness({ enqueueImpl: enqueue });

		await assert.doesNotReject((tm as any)._bootResumeIdleTeamLeads());

		assert.equal(sm.enqueuePrompt.mock.callCount(), 1, "one enqueue for the one idle team with outstanding work");
		assert.equal(
			(tm as any).nudgePending.get(goalId), true,
			"successful boot-resume leaves nudgePending=true until the team-lead's next reply",
		);
	});

	it("does not nudge when there is no outstanding work (no failed gates, no open tasks)", async () => {
		const enqueue = async () => {};
		const { tm, sm } = buildHarness({ enqueueImpl: enqueue, failedGates: 0, openTasks: 0 });

		await assert.doesNotReject((tm as any)._bootResumeIdleTeamLeads());
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0, "idle team with no outstanding work must not be nudged");
	});
});
