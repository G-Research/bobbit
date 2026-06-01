import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";

import { resolveWorktreeSupport, type WorktreeSupportDeps } from "../src/server/agent/worktree-support.js";
import type { Component } from "../src/server/agent/project-config-store.js";

/**
 * Unit coverage for the single-source-of-truth worktree-support resolver,
 * exercised through injected git probes (no real git). Pins the four decision
 * branches that session, staff, and goal all share:
 *   1. multi-repo with ≥1 git repo root ⇒ supported, repoPath = projectRoot.
 *   2. multi-repo with NO git repo root ⇒ falls through to the single-repo probe.
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

describe("resolveWorktreeSupport", () => {
	const projectRoot = "/proj/root";
	const cwd = "/proj/root";

	it("multi-repo with ≥1 git repo root ⇒ supported, repoPath = projectRoot", async () => {
		const components = [comp("."), comp("repo-a"), comp("repo-b")];
		const deps = makeDeps({ gitRoots: [path.join(projectRoot, "repo-a"), path.join(projectRoot, "repo-b")] });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: projectRoot, multiRepo: true });
	});

	it("multi-repo where ONLY the '.' entry is a git root ⇒ supported via the '.' root", async () => {
		const components = [comp("."), comp("repo-a")];
		const deps = makeDeps({ gitRoots: [projectRoot] });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: projectRoot, multiRepo: true });
	});

	it("multi-repo with NO git repo root ⇒ falls through to single-repo probe (unsupported when cwd non-git)", async () => {
		const components = [comp("."), comp("repo-a"), comp("repo-b")];
		const deps = makeDeps({ gitRoots: [], gitRepos: [] });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: true });
	});

	it("multi-repo with NO git repo root but cwd IS a git repo ⇒ single-repo support", async () => {
		const components = [comp("."), comp("repo-a")];
		const deps = makeDeps({ gitRoots: [], gitRepos: [cwd], repoRoot: "/git/toplevel" });
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: "/git/toplevel", multiRepo: true });
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

	it("multi-repo but no projectRoot ⇒ falls through to single-repo probe", async () => {
		const components = [comp("."), comp("repo-a")];
		const deps = makeDeps({ gitRoots: [], gitRepos: [cwd], repoRoot: "/git/toplevel" });
		const support = await resolveWorktreeSupport(components, undefined, cwd, deps);
		assert.deepStrictEqual(support, { supported: true, repoPath: "/git/toplevel", multiRepo: true });
	});

	it("never throws when a dep rejects — returns unsupported", async () => {
		const components = [comp(".")];
		const deps: WorktreeSupportDeps = {
			isGitRepoRoot: async () => false,
			isGitRepo: async () => { throw new Error("git boom"); },
			getRepoRoot: async () => { throw new Error("git boom"); },
		};
		const support = await resolveWorktreeSupport(components, projectRoot, cwd, deps);
		assert.deepStrictEqual(support, { supported: false, multiRepo: false });
	});
});
