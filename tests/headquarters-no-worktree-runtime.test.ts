/**
 * Headquarters runtime no-worktree invariants.
 *
 * These are targeted lifecycle tests for the same-root Headquarters split:
 * projectId=headquarters must behave as an explicit no-worktree/data scope even
 * when callers request worktrees or the cwd is a git repository.
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir } from "./helpers/tmp.ts";

const suiteRoot = makeTmpDir("headquarters-no-worktree-runtime-");
const headquartersRoot = path.join(suiteRoot, "headquarters");
const stateDir = path.join(headquartersRoot, "state");
const configDir = path.join(headquartersRoot, "config");
const agentDir = path.join(headquartersRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = headquartersRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";

const { HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, ProjectRegistry } = await import("../src/server/agent/project-registry.ts");
const { ProjectContextManager } = await import("../src/server/agent/project-context-manager.ts");
const { GoalManager } = await import("../src/server/agent/goal-manager.ts");
const { GoalStore } = await import("../src/server/agent/goal-store.ts");
const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { StaffManager } = await import("../src/server/agent/staff-manager.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");
const { initPromptDirs } = await import("../src/server/agent/system-prompt.ts");

initPromptDirs(stateDir);

const managers: any[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
});

function makeCommittedRepo(label: string): string {
	const repo = makeTmpDir(`hq-no-worktree-${label}-`);
	execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
	fs.writeFileSync(path.join(repo, "README.md"), "# test\n", "utf-8");
	execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
	return repo;
}

function makeBridge(overrides: Record<string, any> = {}): any {
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
		prompt: mock.fn(async () => ({ success: true })),
		steer: mock.fn(async () => ({ success: true })),
		abort: mock.fn(async () => ({ success: true })),
		getState: mock.fn(async () => ({
			success: true,
			data: { sessionFile: path.join(agentDir, "sessions", "hq-no-worktree.jsonl") },
		})),
		getMessages: mock.fn(async () => ({ success: true, data: { messages: [] } })),
		setModel: mock.fn(async () => ({ success: true })),
		setThinkingLevel: mock.fn(async () => ({ success: true })),
		compact: mock.fn(async () => ({ success: true })),
		sendCommand: mock.fn(async () => ({ success: true })),
		onEvent: mock.fn(() => () => {}),
		...overrides,
	};
}

describe("Headquarters no-worktree runtime", () => {
	it("forces Headquarters goals to ready no-worktree state even inside a git repo", async () => {
		const repo = makeCommittedRepo("goal-hq");
		const goalStore = new GoalStore(makeTmpDir("hq-goal-store-"));
		const goalManager = new GoalManager(goalStore);

		const goal = await goalManager.createGoal("HQ requested worktree", repo, {
			projectId: HEADQUARTERS_PROJECT_ID,
			worktree: true,
		});

		assert.equal(goal.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(goal.cwd, repo);
		assert.equal(goal.setupStatus, "ready");
		assert.equal(goal.repoPath, undefined);
		assert.equal(goal.branch, undefined);
		assert.equal(goal.worktreePath, undefined);
	});

	it("keeps normal project goal worktree preparation unchanged", async () => {
		const repo = makeCommittedRepo("goal-normal");
		const goalStore = new GoalStore(makeTmpDir("normal-goal-store-"));
		const goalManager = new GoalManager(goalStore);

		const goal = await goalManager.createGoal("Normal requested worktree", repo, {
			projectId: "normal-project",
			worktree: true,
		});

		assert.equal(goal.projectId, "normal-project");
		assert.equal(goal.setupStatus, "preparing");
		assert.equal(path.resolve(goal.repoPath ?? ""), path.resolve(repo));
		assert.match(goal.branch ?? "", /^goal\//);
		assert.ok(goal.worktreePath?.includes("-wt"));
	});

	it("does not initialize a worktree pool for Headquarters", () => {
		const repo = makeCommittedRepo("pool");
		const manager: any = new SessionManager();
		managers.push(manager);

		manager.initWorktreePoolForProject(HEADQUARTERS_PROJECT_ID, repo, undefined, 2);

		assert.equal(manager.getWorktreePool(HEADQUARTERS_PROJECT_ID), null);
		assert.equal(manager.getAllWorktreePools().has(HEADQUARTERS_PROJECT_ID), false);
	});

	it("ignores Headquarters session worktree and sandbox branch requests", async () => {
		const repo = makeCommittedRepo("session");
		let capturedOptions: any;
		registerRpcBridgeFactory((options: any) => {
			capturedOptions = options;
			return makeBridge();
		});
		const manager: any = new SessionManager();
		managers.push(manager);

		const session = await manager.createSession(headquartersRoot, [], undefined, undefined, {
			sessionId: "s-hq-no-worktree",
			projectId: HEADQUARTERS_PROJECT_ID,
			worktreeOpts: { repoPath: repo },
			worktreePushPolicy: "local-only",
			sandboxBranch: "session/should-not-exist",
			sandboxBaseBranch: "master",
			skipAutoModel: true,
			skipAutoThinking: true,
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		assert.equal(session.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(session.cwd, headquartersRoot);
		assert.notEqual(session.status, "preparing");
		assert.equal(session.worktreePath, undefined);
		assert.equal(session.branch, undefined);
		assert.equal(session.repoPath, undefined);
		assert.equal(session.worktreePushPolicy, undefined);
		assert.equal(capturedOptions.cwd, headquartersRoot);
	});

	it("creates Headquarters staff without a worktree even when requested", async () => {
		const registry = new ProjectRegistry(stateDir);
		registry.ensureHeadquartersProject(headquartersRoot, { stateDir, configDir });
		const pcm = new ProjectContextManager(registry);
		const staffManager = new StaffManager(pcm);
		const createSessionCalls: any[] = [];
		const fakeSessionManager = {
			getRoleManager: () => undefined,
			createSession: mock.fn(async (cwd: string, _args: unknown, _goalId: unknown, _assistantType: unknown, opts: Record<string, unknown>) => {
				createSessionCalls.push({ cwd, opts });
				return { id: "s-staff-hq", cwd, projectId: opts.projectId };
			}),
			setTitle: mock.fn(() => {}),
			persistSessionMetadata: mock.fn(async () => {}),
		};

		const staff = await staffManager.createStaff(
			"HQ staff",
			"Server workspace staff",
			"Help with server settings.",
			headquartersRoot,
			fakeSessionManager as any,
			{ projectId: HEADQUARTERS_PROJECT_ID, worktree: true },
		);

		assert.equal(staff.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(staff.cwd, headquartersRoot);
		assert.equal(staff.worktreePath, undefined);
		assert.equal(staff.branch, undefined);
		assert.equal(staff.repoPath, undefined);
		assert.equal(createSessionCalls.length, 1);
		assert.equal(createSessionCalls[0].cwd, headquartersRoot);
		assert.equal(createSessionCalls[0].opts.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(createSessionCalls[0].opts.sandboxBranch, undefined);

		const hq = registry.get(HEADQUARTERS_PROJECT_ID);
		assert.equal(hq?.name, HEADQUARTERS_PROJECT_NAME);
	});
});
