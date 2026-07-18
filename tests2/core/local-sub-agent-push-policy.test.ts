import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { GoalStore } from "../../src/server/agent/goal-store.ts";
import { createWorktree, createWorktreeSet } from "../../src/server/skills/git.ts";
import type { CommandRunner, ExecFileOptions } from "../../src/server/gateway-deps.ts";
import { installMemoryFs } from "./helpers/memory-fs-spies.js";
import type { MemFs } from "../harness/mem-fs.js";

let memoryFs: MemFs;
let restoreFs: () => void;
let fixtureSequence = 0;

beforeEach(() => {
	({ fs: memoryFs, restore: restoreFs } = installMemoryFs());
});

afterEach(() => restoreFs());

interface FakeRepoState {
	localBranches: Map<string, string>;
	remoteRefs: Map<string, string>;
	upstreams: Map<string, string>;
}

interface RecordedGitCommand {
	cwd: string;
	args: string[];
}

interface FakeGitState {
	commands: RecordedGitCommand[];
	repos: Map<string, FakeRepoState>;
}

function canonical(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fakeGitRunner(
	repoPaths: string[],
	initialBranches: Record<string, string[]> = {},
): { state: FakeGitState; runner: CommandRunner } {
	const state: FakeGitState = { commands: [], repos: new Map() };
	const worktreeRepos = new Map<string, string>();

	for (const repoPath of repoPaths) {
		const repoKey = canonical(repoPath);
		const localBranches = new Map<string, string>([["master", "sha:master"]]);
		for (const branch of initialBranches[repoPath] ?? []) {
			localBranches.set(branch, `sha:${branch}`);
		}
		state.repos.set(repoKey, {
			localBranches,
			remoteRefs: new Map([["refs/heads/master", "sha:master"]]),
			upstreams: new Map(),
		});
	}

	const repoForCwd = (cwd: string): FakeRepoState => {
		const cwdKey = canonical(cwd);
		const repoKey = state.repos.has(cwdKey) ? cwdKey : worktreeRepos.get(cwdKey);
		const repo = repoKey ? state.repos.get(repoKey) : undefined;
		assert.ok(repo, `unexpected git cwd: ${cwd}`);
		return repo;
	};

	const runner: CommandRunner = {
		async execFile(file, args, options?: ExecFileOptions) {
			assert.equal(file, "git");
			const cwd = String(options?.cwd ?? repoPaths[0]);
			const command = { cwd, args: [...args] };
			state.commands.push(command);

			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				const repoKey = canonical(cwd);
				if (!state.repos.has(repoKey)) throw new Error(`not a repo root: ${cwd}`);
				return { stdout: `${cwd}\n`, stderr: "" };
			}

			const repo = repoForCwd(cwd);
			if (args[0] === "remote" && args[1] === "get-url") {
				return { stdout: "https://example.invalid/repo.git\n", stderr: "" };
			}
			if (args[0] === "rev-parse" && args[1] === "--verify") {
				if (args[2] === "HEAD") return { stdout: `${repo.localBranches.get("master")}\n`, stderr: "" };
				const branch = String(args[2]).replace(/^refs\/heads\//, "");
				const sha = repo.localBranches.get(branch);
				if (!sha) throw new Error(`missing ref: ${args[2]}`);
				return { stdout: `${sha}\n`, stderr: "" };
			}
			if (args[0] === "symbolic-ref") {
				return { stdout: "refs/remotes/origin/master\n", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				const creating = args[2] === "-b";
				const branch = String(args[3]);
				const worktreePath = String(args[creating ? 4 : 2]);
				const sourceRepoKey = canonical(cwd);
				worktreeRepos.set(canonical(worktreePath), sourceRepoKey);
				if (creating) repo.localBranches.set(branch, `sha:${branch}`);
			}
			if (args[0] === "branch" && String(args[1]).startsWith("--set-upstream-to=")) {
				repo.upstreams.set(String(args[2]), String(args[1]).slice("--set-upstream-to=".length));
			}
			if (args[0] === "push" && args[1] === "origin" && args[2] !== "--delete") {
				const [source, destination] = String(args[2]).split(":", 2);
				if (source && destination) repo.remoteRefs.set(destination, repo.localBranches.get(source) ?? `sha:${source}`);
			}
			return { stdout: "", stderr: "" };
		},
	};
	return { state, runner };
}

async function withFakeRepo<T>(fn: (root: string, repo: string) => Promise<T>): Promise<T> {
	const root = path.resolve("/memfs/local-only-worktrees", String(fixtureSequence++));
	const repo = path.join(root, "repo");
	memoryFs.mkdirSync(repo, { recursive: true });
	return fn(root, repo);
}

async function withFakeMultiRepo<T>(fn: (root: string, repos: string[]) => Promise<T>): Promise<T> {
	const root = path.resolve("/memfs/local-only-worktree-sets", String(fixtureSequence++));
	const repos = [path.join(root, "api"), path.join(root, "web")];
	for (const repo of repos) memoryFs.mkdirSync(repo, { recursive: true });
	return fn(root, repos);
}

function commandStrings(state: FakeGitState): string[] {
	return state.commands.map(({ args }) => args.join(" "));
}

function assertBranchStayedLocal(state: FakeGitState, branch: string): void {
	const commands = commandStrings(state);
	assert.ok(!commands.some((command) => command.startsWith("push ")), `worktree creation must not push; commands:\n${commands.join("\n")}`);
	assert.ok(
		!commands.includes(`fetch origin refs/heads/${branch}:refs/remotes/origin/${branch}`),
		"worktree creation must not fetch a just-published work branch",
	);
	assert.ok(
		!commands.includes(`branch --set-upstream-to=origin/${branch} ${branch}`),
		"worktree creation must not infer an origin work-branch upstream",
	);
	for (const repo of state.repos.values()) {
		assert.equal(repo.remoteRefs.has(`refs/heads/${branch}`), false);
	}
}

function countCommand(state: FakeGitState, expected: string): number {
	return commandStrings(state).filter((command) => command === expected).length;
}

function countNewBranchesFrom(state: FakeGitState, branch: string, startPoint: string): number {
	return commandStrings(state).filter((command) =>
		command.startsWith(`worktree add -b ${branch} `) && command.endsWith(` ${startPoint}`),
	).length;
}

describe("local-only host worktree primitives", () => {
	it("createWorktree keeps a new branch local with the implicit origin primary base", async () => {
		await withFakeRepo(async (_root, repo) => {
			const branch = "session/implicit-base";
			const { state, runner } = fakeGitRunner([repo]);

			await createWorktree(repo, branch, { commandRunner: runner });

			assertBranchStayedLocal(state, branch);
			assert.ok(commandStrings(state).includes("fetch origin master"), "the base ref may still be fetched for a remote read");
			assert.equal(state.repos.get(canonical(repo))?.upstreams.has(branch), false);
		});
	});

	it("createWorktree ignores legacy publish options while retaining configured base_ref upstream", async () => {
		await withFakeRepo(async (_root, repo) => {
			const branch = "goal/configured-base";
			const { state, runner } = fakeGitRunner([repo]);

			await createWorktree(repo, branch, {
				configuredBaseRef: "origin/master",
				pushPolicy: "publish",
				skipPush: false,
				commandRunner: runner,
			});

			assertBranchStayedLocal(state, branch);
			assert.equal(state.repos.get(canonical(repo))?.upstreams.get(branch), "origin/master");
			assert.ok(commandStrings(state).includes(`branch --set-upstream-to=origin/master ${branch}`));
		});
	});

	it("GoalManager forwards remote policy so configured-base fetch is suppressed while local creation succeeds", async () => {
		await withFakeRepo(async (root, repo) => {
			const stateDir = path.join(root, "state");
			memoryFs.mkdirSync(stateDir, { recursive: true });
			const { state, runner } = fakeGitRunner([repo]);
			const store = new GoalStore(stateDir);
			const manager = new GoalManager(store, undefined, stateDir, {
				commandRunner: runner,
				remotePolicy: { skipNonLocalRemoteGit: true },
			});
			manager.setBaseRefResolver(() => "origin/master");

			const goal = await manager.createGoal("Remote policy", repo, { projectId: "project" });
			assert.equal(goal.setupStatus, "preparing");
			await manager.setupWorktree(goal.id);

			const commands = commandStrings(state);
			assert.ok(commands.includes("remote get-url origin"), "remote policy should classify origin before fetching");
			assert.ok(!commands.some(command => command.startsWith("fetch ")), `non-local configured-base fetch must be suppressed; commands:\n${commands.join("\n")}`);
			assert.ok(commands.some(command => command.startsWith(`worktree add -b ${goal.branch} `) && command.endsWith(" origin/master")));
			assert.equal(store.get(goal.id)?.setupStatus, "ready");
			assert.equal(state.repos.get(canonical(repo))?.localBranches.has(goal.branch!), true);
			assertBranchStayedLocal(state, goal.branch!);
		});
	});

	it("GoalManager updateGoal team upgrade suppresses configured-base fetch and keeps the new worktree local", async () => {
		await withFakeRepo(async (root, repo) => {
			const stateDir = path.join(root, "state");
			memoryFs.mkdirSync(stateDir, { recursive: true });
			const { state, runner } = fakeGitRunner([repo]);
			const store = new GoalStore(stateDir);
			const manager = new GoalManager(store, undefined, stateDir, {
				commandRunner: runner,
				remotePolicy: { skipNonLocalRemoteGit: true },
			});
			manager.setBaseRefResolver(() => "origin/master");

			const id = "upgrade-policy-goal";
			store.put({
				id,
				title: "Upgrade policy",
				cwd: repo,
				state: "todo",
				spec: "",
				createdAt: 1,
				updatedAt: 1,
				projectId: "project",
				team: false,
				setupStatus: "ready",
			});

			assert.equal(manager.getBaseRef("project"), "origin/master");
			assert.equal(await manager.updateGoal(id, { team: true }), true);

			const upgraded = store.get(id);
			assert.ok(upgraded?.branch);
			const expectedWorktreePath = path.join(`${repo}-wt`, upgraded.branch.replace(/\//g, "-"));
			assert.deepEqual(
				{
					team: upgraded.team,
					repoPath: upgraded.repoPath,
					branch: upgraded.branch,
					cwd: upgraded.cwd,
					setupStatus: upgraded.setupStatus,
				},
				{
					team: true,
					repoPath: repo,
					branch: "goal/upgrade-policy-upgrade-",
					cwd: expectedWorktreePath,
					setupStatus: "ready",
				},
			);

			const commands = commandStrings(state);
			assert.ok(commands.includes("remote get-url origin"), "team upgrade should classify origin before fetching");
			assert.ok(!commands.some(command => command.startsWith("fetch ")), `team upgrade must suppress non-local configured-base fetch; commands:\n${commands.join("\n")}`);
			assert.ok(commands.some(command => command.startsWith(`worktree add -b ${upgraded.branch} `) && command.endsWith(" origin/master")));
			assert.equal(state.repos.get(canonical(repo))?.localBranches.has(upgraded.branch), true);
			assertBranchStayedLocal(state, upgraded.branch);
		});
	});

	it("createWorktree repairs an existing local branch without recreating its deleted remote", async () => {
		await withFakeRepo(async (_root, repo) => {
			const branch = "session/reused";
			const worktreePath = path.join(`${repo}-wt`, branch.replace(/\//g, "-"));
			memoryFs.mkdirSync(path.join(worktreePath, ".git"), { recursive: true });
			const { state, runner } = fakeGitRunner([repo], { [repo]: [branch] });

			await createWorktree(repo, branch, {
				startPoint: "origin/master",
				pushPolicy: "publish",
				skipPush: false,
				commandRunner: runner,
			});

			assertBranchStayedLocal(state, branch);
			assert.ok(commandStrings(state).includes("worktree repair"));
		});
	});

	it("createWorktreeSet keeps its single-repo compatibility path local", async () => {
		await withFakeRepo(async (_root, repo) => {
			const branch = "set/single";
			const { state, runner } = fakeGitRunner([repo]);

			const result = await createWorktreeSet(repo, [{ name: "app", repo: "." }], branch, "origin/master", {
				pushPolicy: "publish",
				skipPush: false,
				commandRunner: runner,
			});

			assert.equal(result.worktrees.length, 1);
			assertBranchStayedLocal(state, branch);
		});
	});

	it("createWorktreeSet keeps every multi-repo branch local with configured base_ref", async () => {
		await withFakeMultiRepo(async (root, repos) => {
			const branch = "goal/poly-configured";
			const { state, runner } = fakeGitRunner(repos);

			const result = await createWorktreeSet(root, [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			], branch, undefined, {
				configuredBaseRef: "origin/master",
				pushPolicy: "publish",
				skipPush: false,
				commandRunner: runner,
			});

			assert.equal(result.worktrees.length, 2);
			assertBranchStayedLocal(state, branch);
			assert.equal(countNewBranchesFrom(state, branch, "origin/master"), 2);
			assert.equal(countCommand(state, `branch --set-upstream-to=origin/master ${branch}`), 2);
		});
	});

	it("createWorktreeSet keeps every multi-repo branch local with the implicit base", async () => {
		await withFakeMultiRepo(async (root, repos) => {
			const branch = "session/poly-implicit";
			const { state, runner } = fakeGitRunner(repos);

			const result = await createWorktreeSet(root, [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			], branch, undefined, { commandRunner: runner });

			assert.equal(result.worktrees.length, 2);
			assertBranchStayedLocal(state, branch);
			assert.equal(countNewBranchesFrom(state, branch, "origin/master"), 2);
			for (const repo of state.repos.values()) assert.equal(repo.upstreams.has(branch), false);
		});
	});
});
