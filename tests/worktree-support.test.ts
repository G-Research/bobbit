import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";

import { resolveWorktreeSupport, type WorktreeSupportDeps } from "../src/server/agent/worktree-support.js";
import type { Component } from "../src/server/agent/project-config-store.js";

/**
 * Unit coverage for the single-source-of-truth worktree-support resolver,
 * exercised through injected git probes (no real git). Pins the decision
 * branches that session, staff, and goal all share:
 *   1. multi-repo with ≥1 git repo root ⇒ supported, repoPath = projectRoot.
 *   2. multi-repo with NO git repo root (or no projectRoot) ⇒ unsupported,
 *      multiRepo:true — and NEVER probes cwd/ancestor (no isGitRepo/getRepoRoot
 *      calls). Probing cwd would let a non-git container nested inside an
 *      unrelated parent git repo resolve to that parent (acceptance criterion 3).
 *   3. single-repo git cwd ⇒ supported, repoPath = getRepoRoot(cwd).
 *   4. non-git ⇒ unsupported (graceful no-worktree, never throws).
 */
function comp(repo: string): Component {
	return { name: repo === "." ? "root" : repo, repo } as Component;
}

/** Build deps where only the listed dirs are git repo roots / git repos. */
function makeDeps(opts: {
	gitRoots?: string[];
	gitRepos?: string[];
	repoRoot?: string;
}): WorktreeSupportDeps {
	const roots = new Set((opts.gitRoots ?? []).map(p => path.resolve(p)));
	const repos = new Set((opts.gitRepos ?? []).map(p => path.resolve(p)));
	return {
		isGitRepoRoot: async (dir: string) => roots.has(path.resolve(dir)),
		isGitRepo: async (dir: string) => repos.has(path.resolve(dir)),
		getRepoRoot: async (_dir: string) => opts.repoRoot ?? _dir,
	};
}

/**
 * Build deps whose single-repo probes (isGitRepo/getRepoRoot) THROW if called.
 * Used to pin that the multi-repo branch never falls through to a cwd/ancestor
 * probe. `isGitRepoRoot` resolves from `gitRoots` as usual.
 */
function makeMultiRepoOnlyDeps(gitRoots: string[]): {
	deps: WorktreeSupportDeps;
	cwdProbeCalls: () => number;
} {
	const roots = new Set(gitRoots.map(p => path.resolve(p)));
	let cwdProbeCalls = 0;
	const deps: WorktreeSupportDeps = {
		isGitRepoRoot: async (dir: string) => roots.has(path.resolve(dir)),
		isGitRepo: async () => {
			cwdProbeCalls++;
			throw new Error("isGitRepo(cwd) must NOT be called for the multi-repo branch");
		},
		getRepoRoot: async () => {
			cwdProbeCalls++;
			throw new Error("getRepoRoot(cwd) must NOT be called for the multi-repo branch");
		},
	};
	return { deps, cwdProbeCalls: () => cwdProbeCalls };
}

describe("resolveWorktreeSupport", () => {
	const projectRoot = "/proj/root";
	const cwd = "/proj/root";

	it("multi-repo with ≥1 git repo root ⇒ supported, repoPath = projectRoot", async () => {
		const components = [comp("."), comp("repo-a"), comp("repo-b")];
		const { deps, cwdProbeCalls } = makeMultiRepoOnlyDeps([
			path.join(projectRoot, "repo-a"),
			path.join(projectRoot, "repo-b"),
		]);
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: projectRoot, multiRepo: true });
		assert.strictEqual(cwdProbeCalls(), 0, "multi-repo must not probe cwd/ancestor");
	});

	it("multi-repo where ONLY the '.' entry is a git root ⇒ supported via the '.' root", async () => {
		const components = [comp("."), comp("repo-a")];
		const { deps, cwdProbeCalls } = makeMultiRepoOnlyDeps([projectRoot]);
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: projectRoot, multiRepo: true });
		assert.strictEqual(cwdProbeCalls(), 0, "multi-repo must not probe cwd/ancestor");
	});

	it("multi-repo with NO git repo root ⇒ unsupported, multiRepo:true, never probes cwd", async () => {
		const components = [comp("."), comp("repo-a"), comp("repo-b")];
		const { deps, cwdProbeCalls } = makeMultiRepoOnlyDeps([]);
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: true });
		assert.strictEqual(cwdProbeCalls(), 0, "multi-repo must not probe cwd/ancestor");
	});

	it("multi-repo with NO git repo root but cwd IS a git repo ⇒ STILL unsupported (no cwd/ancestor probe)", async () => {
		// Regression pin: a non-git project container nested inside an UNRELATED
		// parent git repo must NOT resolve to that parent. Even though cwd would
		// pass isGitRepo here, the multi-repo branch must never consult it.
		const components = [comp("."), comp("repo-a")];
		const { deps, cwdProbeCalls } = makeMultiRepoOnlyDeps([]);
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: true });
		assert.strictEqual(cwdProbeCalls(), 0, "multi-repo must not probe cwd/ancestor");
	});

	it("multi-repo but no projectRoot ⇒ unsupported, multiRepo:true, never probes cwd", async () => {
		const components = [comp("."), comp("repo-a")];
		const { deps, cwdProbeCalls } = makeMultiRepoOnlyDeps([]);
		const support = await resolveWorktreeSupport(components, undefined, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: true });
		assert.strictEqual(cwdProbeCalls(), 0, "multi-repo must not probe cwd/ancestor");
	});

	it("single-repo git cwd ⇒ supported, repoPath = getRepoRoot(cwd)", async () => {
		const components = [comp(".")];
		const deps = makeDeps({ gitRepos: [cwd], repoRoot: "/git/toplevel" });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: "/git/toplevel", multiRepo: false });
	});

	it("non-git single-repo ⇒ unsupported (graceful no-worktree)", async () => {
		const components = [comp(".")];
		const deps = makeDeps({ gitRepos: [] });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: false });
	});

	it("never throws when a single-repo dep rejects — returns unsupported", async () => {
		const components = [comp(".")];
		const deps: WorktreeSupportDeps = {
			isGitRepoRoot: async () => false,
			isGitRepo: async () => { throw new Error("git boom"); },
			getRepoRoot: async () => { throw new Error("git boom"); },
		};
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: false });
	});

	it("never throws when a multi-repo dep rejects — returns unsupported, multiRepo:true", async () => {
		const components = [comp("."), comp("repo-a")];
		const deps: WorktreeSupportDeps = {
			isGitRepoRoot: async () => { throw new Error("git boom"); },
			isGitRepo: async () => { throw new Error("must not reach cwd probe"); },
			getRepoRoot: async () => { throw new Error("must not reach cwd probe"); },
		};
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: true });
	});
});
