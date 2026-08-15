import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, vi } from "vitest";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-setup-ready-"));
const priorBobbitDir = process.env.BOBBIT_DIR;
process.env.BOBBIT_DIR = testDir;
const { TeamManager, TeamStartError } = await import("../../src/server/agent/team-manager.ts");
import type { TeamManagerConfig } from "../../src/server/agent/team-manager.ts";

type Goal = {
	id: string;
	title: string;
	cwd: string;
	state: "todo";
	spec: string;
	createdAt: number;
	updatedAt: number;
	team: true;
	setupStatus?: "ready" | "preparing" | "error";
};

function fixture(status: Goal["setupStatus"]) {
	const goal: Goal = {
		id: "goal-setup-guard",
		title: "Setup guard",
		cwd: testDir,
		state: "todo",
		spec: "# Setup guard\nThis goal has a valid specification.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		setupStatus: status,
	};
	const sessions = new Map<string, any>();
	const createSession = vi.fn(async (cwd: string, _args?: string[], goalId?: string) => {
		const session = {
			id: `session-${sessions.size}`,
			title: "New session",
			cwd,
			goalId,
			status: "idle",
			clients: new Set(),
			rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
		};
		sessions.set(session.id, session);
		return session;
	});
	const sessionManager: any = {
		goalManager: {
			getGoal: (id: string) => id === goal.id ? goal : undefined,
			updateGoal: (_id: string, patch: Partial<Goal>) => Object.assign(goal, patch),
		},
		createSession,
		getSession: (id: string) => sessions.get(id),
		enqueuePrompt: vi.fn(async () => ({ status: "dispatched" })),
		setTitle: (id: string, title: string) => { const session = sessions.get(id); if (session) session.title = title; return !!session; },
		updateSessionMeta: () => true,
		terminateSession: vi.fn(async () => true),
		isSandboxEnabled: false,
		getSandboxManager: () => undefined,
	};
	const roleStore = {
		get: (name: string) => name === "team-lead" ? {
			name: "team-lead", label: "Team Lead", promptTemplate: "You lead {{GOAL_BRANCH}}", toolPolicies: {}, createdAt: 0, updatedAt: 0,
		} : undefined,
		getAll: () => [],
	};
	const config: TeamManagerConfig = {
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) } as any,
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] } as any,
		roleStore: roleStore as any,
	};
	return { goal, createSession, team: new TeamManager(sessionManager, config) };
}

describe("setup-ready team start guard", () => {
	it("does not create a team lead before verified setup readiness", async () => {
		for (const setupStatus of ["preparing", "error"] as const) {
			const h = fixture(setupStatus);
			await assert.rejects(
				() => h.team.startTeam(h.goal.id),
				(err: unknown) => err instanceof TeamStartError && err.code === "GOAL_SETUP_INCOMPLETE",
			);
			assert.equal(h.createSession.mock.calls.length, 0, `${setupStatus} must not create a lead session`);
		}
	});

	it("permits a lead only after setup is exactly ready", async () => {
		const h = fixture("ready");
		await h.team.startTeam(h.goal.id);
		assert.equal(h.createSession.mock.calls.length, 1);
	});
});

afterAll(() => {
	fs.rmSync(testDir, { recursive: true, force: true });
	if (priorBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = priorBobbitDir;
});
