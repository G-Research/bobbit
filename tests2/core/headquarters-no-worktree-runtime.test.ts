// Ported from tests/headquarters-no-worktree-runtime.test.ts (straggler-coverage
// -triage GENUINE-LOSS: HQ no-worktree runtime invariants). Faithful port — same
// assertions, vitest + fork env-guard.
//
// Headquarters runtime no-worktree invariants: projectId=headquarters must behave
// as an explicit no-worktree/data scope even when callers request worktrees or the
// cwd is a git repository.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeAll, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "../../tests/helpers/tmp.ts";

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

let HEADQUARTERS_PROJECT_ID = "headquarters";
let HEADQUARTERS_PROJECT_NAME = "Headquarters";
let ProjectRegistry: any;
let ProjectContextManager: any;
let GoalManager: any;
let GoalStore: any;
let SessionManager: any;
let StaffManager: any;
let registerRpcBridgeFactory: (factory: any) => void = () => {};

beforeAll(async () => {
	const projectRegistry = await import("../../src/server/agent/project-registry.ts");
	HEADQUARTERS_PROJECT_ID = projectRegistry.HEADQUARTERS_PROJECT_ID;
	HEADQUARTERS_PROJECT_NAME = projectRegistry.HEADQUARTERS_PROJECT_NAME;
	ProjectRegistry = projectRegistry.ProjectRegistry;
	({ ProjectContextManager } = await import("../../src/server/agent/project-context-manager.ts"));
	({ GoalManager } = await import("../../src/server/agent/goal-manager.ts"));
	({ GoalStore } = await import("../../src/server/agent/goal-store.ts"));
	({ SessionManager } = await import("../../src/server/agent/session-manager.ts"));
	({ StaffManager } = await import("../../src/server/agent/staff-manager.ts"));
	({ registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts"));
	const { initPromptDirs } = await import("../../src/server/agent/system-prompt.ts");
	const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.ts");
	const { loadOrCreateToken } = await import("../../src/server/auth/token.ts");
	loadOrCreateToken(); // seed admin token so direct-agent spawns find it (mirrors server boot)
	// Ensure the agent-dir singleton reflects THIS file's BOBBIT_DIR even when a
	// fork-mate initialised it first (isolate:false shared fork).
	resetAgentDirStateForTests?.();
	initPromptDirs(stateDir);
});

const managers: any[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
});

function makeRepoMarker(label: string): string {
	const repo = makeTmpDir(`hq-no-worktree-${label}-`);
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(repo, "README.md"), "# test\n", "utf-8");
	return repo;
}

function makeGitRepoRunner(repo: string): { runner: any; commands: string[] } {
	const commands: string[] = [];
	return {
		commands,
		runner: {
			execFile: async (command: string, args: readonly string[], options?: { cwd?: string }) => {
				assert.equal(command, "git");
				assert.equal(path.resolve(options?.cwd ?? ""), path.resolve(repo));
				commands.push(args.join(" "));
				if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
					return { stdout: "true\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { stdout: `${repo}\n`, stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
					return { stdout: "fake-head\n", stderr: "" };
				}
				throw new Error(`unexpected fake Git command: ${args.join(" ")}`);
			},
		},
	};
}

function makeBridge(overrides: Record<string, any> = {}): any {
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
		prompt: vi.fn(async () => ({ success: true })),
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			success: true,
			data: { sessionFile: path.join(agentDir, "sessions", "hq-no-worktree.jsonl") },
		})),
		getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
		setModel: vi.fn(async () => ({ success: true })),
		setThinkingLevel: vi.fn(async () => ({ success: true })),
		compact: vi.fn(async () => ({ success: true })),
		sendCommand: vi.fn(async () => ({ success: true })),
		onEvent: vi.fn(() => () => {}),
		...overrides,
	};
}

describe("Headquarters no-worktree runtime", () => {
	it("forces Headquarters goals to ready no-worktree state even inside a git repo", async () => {
		const repo = makeRepoMarker("goal-hq");
		const git = makeGitRepoRunner(repo);
		const goalStore = new GoalStore(makeTmpDir("hq-goal-store-"));
		const goalManager = new GoalManager(goalStore, undefined, undefined, { commandRunner: git.runner });

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
		assert.deepEqual(git.commands, [], "Headquarters goal creation must short-circuit before Git detection");
	});

	it("keeps normal project goal worktree preparation unchanged", async () => {
		const repo = makeRepoMarker("goal-normal");
		const git = makeGitRepoRunner(repo);
		const goalStore = new GoalStore(makeTmpDir("normal-goal-store-"));
		const goalManager = new GoalManager(goalStore, undefined, undefined, { commandRunner: git.runner });

		const goal = await goalManager.createGoal("Normal requested worktree", repo, {
			projectId: "normal-project",
			worktree: true,
		});

		assert.equal(goal.projectId, "normal-project");
		assert.equal(goal.setupStatus, "preparing");
		assert.equal(path.resolve(goal.repoPath ?? ""), path.resolve(repo));
		assert.match(goal.branch ?? "", /^goal\//);
		assert.ok(goal.worktreePath?.includes("-wt"));
		assert.deepEqual(git.commands, [
			"rev-parse --is-inside-work-tree",
			"rev-parse --show-toplevel",
			"rev-parse --verify HEAD",
		]);
	});

	it("does not initialize a worktree pool for Headquarters", () => {
		const repo = makeRepoMarker("pool");
		const git = makeGitRepoRunner(repo);
		const manager: any = new SessionManager({ commandRunner: git.runner });
		managers.push(manager);

		manager.initWorktreePoolForProject(HEADQUARTERS_PROJECT_ID, repo, undefined, 2);

		assert.equal(manager.getWorktreePool(HEADQUARTERS_PROJECT_ID), null);
		assert.equal(manager.getAllWorktreePools().has(HEADQUARTERS_PROJECT_ID), false);
		assert.deepEqual(git.commands, [], "Headquarters pool initialization must short-circuit before Git detection");
	});

	it("ignores Headquarters session worktree and sandbox branch requests", async () => {
		const repo = makeRepoMarker("session");
		const git = makeGitRepoRunner(repo);
		let capturedOptions: any;
		registerRpcBridgeFactory((options: any) => {
			capturedOptions = options;
			return makeBridge();
		});
		const manager: any = new SessionManager({ commandRunner: git.runner });
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
		assert.deepEqual(git.commands, [], "Headquarters session creation must short-circuit before Git detection");
	});

	it("creates Headquarters staff without a worktree even when requested", async () => {
		const registry = new ProjectRegistry(stateDir);
		registry.ensureHeadquartersProject(headquartersRoot, { stateDir, configDir });
		const pcm = new ProjectContextManager(registry);
		const staffManager = new StaffManager(pcm);
		const createSessionCalls: any[] = [];
		const fakeSessionManager = {
			getRoleManager: () => undefined,
			createSession: vi.fn(async (cwd: string, _args: unknown, _goalId: unknown, _assistantType: unknown, opts: Record<string, unknown>) => {
				createSessionCalls.push({ cwd, opts });
				return { id: "s-staff-hq", cwd, projectId: opts.projectId };
			}),
			setTitle: vi.fn(() => {}),
			persistSessionMetadata: vi.fn(async () => {}),
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
