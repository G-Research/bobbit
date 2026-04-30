/**
 * Runtime test for the role-resolution wiring landed in Phase 6 task 6.2:
 *
 *   - `team-manager.spawnRole` must use `resolveRoleForGoal(...)` so a parent
 *     goal's `inlineRoles.<name>` shadows the project / server / builtin
 *     cascade for every descendant.
 *   - `team-manager.startTeam` must do the same for the `team-lead` role.
 *
 * The test sets up a parent → child goal pair, registers an inline `coder`
 * role on the parent, and asserts the spawned coder session received the
 * parent's inline `promptTemplate` rather than the cascade default.
 *
 * See `docs/design/nested-goals.md` §7.2.
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real ~/.bobbit state by using a temp directory.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-role-cascade-"));
process.env.BOBBIT_DIR = TEST_DIR;

// Import AFTER setting env so bobbitDir() picks it up.
const { TeamManager } = await import("../dist/server/agent/team-manager.js");
const { GoalStore } = await import("../dist/server/agent/goal-store.js");

const goalStateDir = path.join(TEST_DIR, "state");
fs.mkdirSync(goalStateDir, { recursive: true });

// ---------------------------------------------------------------------------
// Mocks: minimal stand-ins for the dependencies TeamManager needs.
// ---------------------------------------------------------------------------

function makeRole(name: string, promptTemplate: string, accessory = "none") {
	return {
		name,
		label: name,
		promptTemplate,
		accessory,
		createdAt: 0,
		updatedAt: 0,
	};
}

/** RoleStore with a default coder role; .get(name) used as fallback. */
function createRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", makeRole("team-lead", "TL: branch={{GOAL_BRANCH}} agent={{AGENT_ID}}", "crown")],
		["coder", makeRole("coder", "DEFAULT-CODER: branch={{GOAL_BRANCH}} agent={{AGENT_ID}}")],
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

function createColorStore() {
	const colors = new Map<string, number>();
	return {
		get: (id: string) => colors.get(id),
		set: (id: string, idx: number) => colors.set(id, idx),
		remove: (id: string) => colors.delete(id),
		getAll: () => Object.fromEntries(colors),
	};
}

function createTaskManager() {
	return {
		getTasksByGoal: () => [],
		getTasksForSession: () => [],
		createTask: (_g: any, t: any) => t,
		getTask: () => undefined,
		updateTask: () => true,
		deleteTask: () => true,
	};
}

interface CapturedSession {
	id: string;
	cwd: string;
	rolePrompt?: string;
	roleName?: string;
}

function createSessionManager() {
	const sessions = new Map<string, any>();
	const captured: CapturedSession[] = [];
	let next = 0;
	return {
		manager: {
			isSandboxEnabled: false,
			getSandboxManager: () => undefined,
			createSession: async (
				cwd: string,
				_args?: string[],
				goalId?: string,
				_assistant?: boolean,
				opts?: any,
			) => {
				const id = `s-${next++}`;
				captured.push({
					id,
					cwd,
					rolePrompt: opts?.rolePrompt,
					roleName: opts?.roleName,
				});
				const session = {
					id,
					title: "",
					cwd,
					status: "idle" as const,
					titleGenerated: false,
					goalId,
					rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => {}) },
					clients: new Set(),
				};
				sessions.set(id, session);
				return session;
			},
			getSession: (id: string) => sessions.get(id),
			setTitle: (id: string, title: string) => {
				const s = sessions.get(id);
				if (s) s.title = title;
				return !!s;
			},
			updateSessionMeta: (id: string, u: any) => {
				const s = sessions.get(id);
				if (s) Object.assign(s, u);
				return !!s;
			},
			terminateSession: async (id: string) => sessions.delete(id),
		},
		captured,
	};
}

/** Minimal ConfigCascade — only resolveRoles is consulted by team-manager. */
function createCascade(roleStore: any) {
	return {
		resolveRoles: () => roleStore.getAll().map((r: any) => ({ item: r, origin: "project" as const })),
	};
}

/**
 * Minimal ProjectContextManager pointing every goal at a single shared
 * GoalStore + ProjectContext-shaped object.
 */
function createPCM(goalStore: any) {
	const ctx = {
		goalStore,
		teamStore: { put: () => {}, get: () => undefined, getAll: () => [], remove: () => {} },
		gateStore: undefined,
		taskStore: undefined,
		project: { id: "p1", name: "p1" },
		goalManager: {
			getGoal: (id: string) => goalStore.get(id),
			updateGoal: (id: string, u: any) => goalStore.update(id, u),
		},
	};
	return {
		getContextForGoal: (goalId: string) => (goalStore.get(goalId) ? ctx : undefined),
		all: function* () { yield ctx; },
	};
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function setup() {
	const goalStore = new GoalStore(goalStateDir);
	// Wipe any pre-existing goals from previous runs.
	for (const g of goalStore.getAll()) goalStore.remove(g.id);

	const inlineCoder = makeRole(
		"coder",
		"INLINE-PARENT-CODER: branch={{GOAL_BRANCH}} agent={{AGENT_ID}}",
	);

	const now = Date.now();
	goalStore.put({
		id: "parent",
		title: "Parent",
		cwd: TEST_DIR,
		state: "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		team: true,
		branch: "goal/parent",
		// No repoPath → useWorktree=false in spawnRole, so it skips git ops.
		rootGoalId: "parent",
		projectId: "p1",
		inlineRoles: { coder: inlineCoder } as any,
	} as any);
	goalStore.put({
		id: "child",
		title: "Child",
		cwd: TEST_DIR,
		state: "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		team: true,
		branch: "goal/child",
		parentGoalId: "parent",
		rootGoalId: "parent",
		projectId: "p1",
	} as any);

	const roleStore = createRoleStore();
	const colorStore = createColorStore();
	const taskManager = createTaskManager();
	const sm = createSessionManager();
	const cascade = createCascade(roleStore);
	const pcm = createPCM(goalStore);

	const tm = new TeamManager(sm.manager as any, {
		colorStore,
		taskManager,
		roleStore,
		projectContextManager: pcm,
		configCascade: cascade,
	});

	return { tm, sm, goalStore, inlineCoder };
}

const created: any[] = [];
function track(tm: any) { created.push(tm); return tm; }

after(() => {
	for (const tm of created) {
		for (const [, t] of (tm as any).idleNudgeTimers ?? []) clearTimeout(t);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, t] of (tm as any).noWorkersNudgeTimers ?? []) clearInterval(t);
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("role-cascade-runtime — team-manager honours per-goal-tree inline roles", () => {
	it("spawnRole on a child goal uses the parent's inlineRoles.<name>", async () => {
		const { tm, sm } = setup();
		track(tm);

		// Start the team for the child so spawnRole has an active TeamEntry.
		await tm.startTeam("child");

		await tm.spawnRole("child", "coder", "do the thing");

		const coderSession = sm.captured.find(s => s.roleName === "coder");
		assert.ok(coderSession, "coder session should be created");
		assert.match(
			coderSession!.rolePrompt ?? "",
			/^INLINE-PARENT-CODER:/,
			"child's spawned coder must use the parent's inline coder role, " +
				"not the cascade/builtin default",
		);
	});

	it("spawnRole on a goal with no inline overrides falls back to cascade/builtin", async () => {
		const { tm, sm, goalStore } = setup();
		track(tm);

		// Add a sibling goal under root with no inline roles anywhere on its chain.
		const now = Date.now();
		goalStore.put({
			id: "loner",
			title: "Loner",
			cwd: TEST_DIR,
			state: "in-progress",
			spec: "",
			createdAt: now,
			updatedAt: now,
			team: true,
			branch: "goal/loner",
			rootGoalId: "loner",
			projectId: "p1",
		} as any);

		await tm.startTeam("loner");
		await tm.spawnRole("loner", "coder", "do the thing");

		const coderSession = sm.captured.find(s => s.roleName === "coder");
		assert.ok(coderSession);
		assert.match(
			coderSession!.rolePrompt ?? "",
			/^DEFAULT-CODER:/,
			"with no inline override on the chain, the cascade default must win",
		);
	});

	it("startTeam picks up a parent's inline team-lead override on a child", async () => {
		const { tm, sm, goalStore } = setup();
		track(tm);

		// Add an inline team-lead on the parent goal.
		const inlineTL = makeRole(
			"team-lead",
			"INLINE-PARENT-TL: branch={{GOAL_BRANCH}} agent={{AGENT_ID}}",
			"crown",
		);
		const parent = goalStore.get("parent")!;
		goalStore.put({
			...parent,
			inlineRoles: { ...(parent as any).inlineRoles, "team-lead": inlineTL } as any,
		} as any);

		await tm.startTeam("child");

		const tlSession = sm.captured.find(s => s.roleName === "team-lead");
		assert.ok(tlSession);
		assert.match(
			tlSession!.rolePrompt ?? "",
			/^INLINE-PARENT-TL:/,
			"child's team-lead must use the parent's inline team-lead role",
		);
	});
});
