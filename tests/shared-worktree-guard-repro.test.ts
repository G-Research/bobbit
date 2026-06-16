/**
 * Reproducing tests for shared worktree cleanup guard.
 *
 * These tests intentionally exercise real git worktree cleanup paths in temp
 * repos. Against the buggy implementation they fail with messages prefixed by
 * SHARED_WORKTREE_GUARD_* because cleanup removes a worktree still referenced
 * by a non-archived persisted session.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

process.env.BOBBIT_TEST_NO_PUSH = "1";
process.env.BOBBIT_SKIP_NPM_CI = "1";

const execFile = promisify(execFileCb);
const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { handleSetupFailure } = await import("../src/server/agent/session-setup.ts");
const { initPromptDirs } = await import("../src/server/agent/system-prompt.ts");

type TestRepo = { repo: string; tmp: string };

const managers: any[] = [];
let prevBobbitDir: string | undefined;
let stateRoot = "";

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

async function makeRepo(prefix: string): Promise<TestRepo> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo, { recursive: true });
	await git(["-c", "init.defaultBranch=master", "init", repo], tmp);
	await git(["config", "user.name", "Bobbit Test"], repo);
	await git(["config", "user.email", "bobbit-test@example.invalid"], repo);
	fs.writeFileSync(path.join(repo, "README.md"), "# repro\n", "utf8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	return { repo, tmp };
}

async function makeWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], repo);
	assert.ok(fs.existsSync(path.join(worktreePath, ".git")), `test setup failed to create worktree ${worktreePath}`);
}

function makeSession(id: string, extra: Record<string, any>): any {
	return {
		id,
		title: id,
		cwd: stateRoot,
		agentSessionFile: "",
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...extra,
	};
}

function makeManager(store: any): any {
	const manager: any = new SessionManager();
	manager._testStore = store;
	managers.push(manager);
	return manager;
}

async function waitForWorktreeRemoval(worktreePath: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && fs.existsSync(worktreePath)) {
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function cleanupManager(manager: any): void {
	if (manager?._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager?.sessions?.clear?.();
}

describe("shared worktree guard reproductions", () => {
	beforeEach(() => {
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shared-wt-guard-state-"));
		prevBobbitDir = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = stateRoot;
		initPromptDirs(stateRoot);
	});

	afterEach(() => {
		while (managers.length > 0) cleanupManager(managers.pop());
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(stateRoot, { recursive: true, force: true });
	});

	it("purging an archived session must not remove a worktree referenced by a live session cwd", async () => {
		const { repo, tmp } = await makeRepo("shared-wt-guard-purge-single-");
		try {
			const sharedWorktree = path.join(tmp, "repo-wt", "session-shared");
			const branch = "session/shared-single";
			await makeWorktree(repo, sharedWorktree, branch);

			const store = new SessionStore(stateRoot);
			store.put(makeSession("archived-a", {
				archived: true,
				archivedAt: Date.now(),
				repoPath: repo,
				branch,
				worktreePath: sharedWorktree,
				cwd: sharedWorktree,
			}));
			store.put(makeSession("live-b", {
				// Deliberately use cwd, separator, and case normalization rather than
				// matching the archived row byte-for-byte.
				cwd: sharedWorktree.replace(/\\/g, "/").toUpperCase(),
				worktreePath: undefined,
				branch: "session/live-different-branch",
			}));

			const manager = makeManager(store);
			const purged = await manager.purgeArchivedSession("archived-a");

			assert.equal(purged, true, "archived session should be purged by the test setup");
			assert.ok(
				fs.existsSync(sharedWorktree),
				"SHARED_WORKTREE_GUARD_PURGE_SINGLE_REGRESSION: archived session purge removed a worktree path still referenced by a non-archived session cwd",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("purging an archived multi-repo session must keep shared repoWorktrees and may clean unshared ones", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-wt-guard-purge-multi-"));
		try {
			const root = path.join(tmp, "project");
			const api = path.join(root, "api");
			const web = path.join(root, "web");
			fs.mkdirSync(root, { recursive: true });
			await makeRepoIn(api);
			await makeRepoIn(web);

			const branch = "session/shared-multi";
			const apiWorktree = path.join(tmp, "project-wt", "session-shared", "api");
			const webWorktree = path.join(tmp, "project-wt", "session-shared", "web");
			await makeWorktree(api, apiWorktree, branch);
			await makeWorktree(web, webWorktree, branch);

			const store = new SessionStore(stateRoot);
			store.put(makeSession("archived-multi", {
				archived: true,
				archivedAt: Date.now(),
				repoPath: root,
				branch,
				worktreePath: path.join(tmp, "project-wt", "session-shared"),
				repoWorktrees: { api: apiWorktree, web: webWorktree },
			}));
			store.put(makeSession("live-api-owner", {
				cwd: apiWorktree,
				branch: "session/live-api-owner",
				repoWorktrees: { api: apiWorktree.replace(/\\/g, "/").toUpperCase() },
			}));

			const manager = makeManager(store);
			const purged = await manager.purgeArchivedSession("archived-multi");

			assert.equal(purged, true, "archived multi-repo session should be purged by the test setup");
			assert.ok(
				fs.existsSync(apiWorktree),
				"SHARED_WORKTREE_GUARD_PURGE_MULTI_REGRESSION: archived multi-repo purge removed a repoWorktrees path still referenced by a non-archived session",
			);
			assert.equal(
				fs.existsSync(webWorktree),
				false,
				"unshared multi-repo worktree should remain cleanable so the guard does not mask true cleanup",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("manual orphan listing must not report a worktree path referenced by live repoWorktrees", async () => {
		const { repo, tmp } = await makeRepo("shared-wt-guard-list-");
		try {
			const sharedWorktree = path.join(tmp, "repo-wt", "session-shared-api");
			await makeWorktree(repo, sharedWorktree, "session/stale-branch");

			const store = new SessionStore(stateRoot);
			store.put(makeSession("live-repo-owner", {
				cwd: path.join(tmp, "elsewhere"),
				branch: "session/live-different-branch",
				repoWorktrees: { api: sharedWorktree.replace(/\\/g, "/").toUpperCase() },
			}));

			const manager = makeManager(store);
			const orphans = await manager.listOrphanedSessionWorktrees(repo);

			assert.equal(
				orphans.some((entry: { path: string }) => path.resolve(entry.path) === path.resolve(sharedWorktree)),
				false,
				`SHARED_WORKTREE_GUARD_ORPHAN_LIST_REGRESSION: manual orphan listing reported a path referenced by live repoWorktrees: ${JSON.stringify(orphans)}`,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("setup failure must not clean a worktree path already owned by another live persisted session", async () => {
		const { repo, tmp } = await makeRepo("shared-wt-guard-setup-failure-");
		try {
			const sharedWorktree = path.join(tmp, "repo-wt", "session-shared-setup");
			const branch = "session/setup-failed";
			await makeWorktree(repo, sharedWorktree, branch);

			const store = new SessionStore(stateRoot);
			const failedSession = makeSession("setup-failed", {
				cwd: sharedWorktree,
				repoPath: repo,
				branch,
				worktreePath: sharedWorktree,
			});
			store.put(failedSession);
			store.put(makeSession("live-owner", {
				cwd: sharedWorktree.replace(/\\/g, "/").toUpperCase(),
				branch: "session/live-owner",
				worktreePath: undefined,
			}));

			const sessions = new Map<string, any>();
			sessions.set(failedSession.id, {
				id: failedSession.id,
				title: failedSession.title,
				cwd: failedSession.cwd,
				status: "preparing",
				statusVersion: 0,
				createdAt: failedSession.createdAt,
				lastActivity: failedSession.lastActivity,
				clients: new Set(),
			});

			handleSetupFailure(
				sessions.get(failedSession.id),
				{ mode: "worktree", repoPath: repo, worktreePath: sharedWorktree, branch } as any,
				new Error("intentional setup failure repro"),
				makePipelineContext(store, sessions),
			);

			await waitForWorktreeRemoval(sharedWorktree);
			assert.ok(
				fs.existsSync(sharedWorktree),
				"SHARED_WORKTREE_GUARD_SETUP_FAILURE_REGRESSION: setup-failure cleanup removed a worktree path already referenced by another non-archived persisted session",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

async function makeRepoIn(repo: string): Promise<void> {
	fs.mkdirSync(repo, { recursive: true });
	await git(["-c", "init.defaultBranch=master", "init", repo], path.dirname(repo));
	await git(["config", "user.name", "Bobbit Test"], repo);
	await git(["config", "user.email", "bobbit-test@example.invalid"], repo);
	fs.writeFileSync(path.join(repo, "README.md"), "# repro\n", "utf8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
}

function makePipelineContext(store: any, sessions: Map<string, any>): any {
	return {
		roleManager: null,
		toolManager: null,
		mcpManager: null,
		goalManager: {},
		taskManager: {},
		projectConfigStore: null,
		sandboxManager: null,
		sandboxTokenStore: null,
		sessionSecretStore: { remove: () => {} },
		groupPolicyStore: null,
		configCascade: null,
		costTracker: {},
		store,
		searchIndex: {},
		sessions,
		assemblePrompt: () => undefined,
		applySandboxWiring: async () => true,
		handleAgentLifecycle: () => {},
		trackCostFromEvent: () => {},
		broadcast: () => {},
		tryAutoSelectModel: async () => {},
		tryApplyDefaultThinkingLevel: async () => {},
		buildWorkflowList: () => "",
		resolveInitialModel: () => undefined,
		resolveInitialThinkingLevel: () => undefined,
		prStatusStore: {},
	};
}
