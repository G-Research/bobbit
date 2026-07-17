import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { GoalStore } from "../../src/server/agent/goal-store.ts";
import { WorktreePool } from "../../src/server/agent/worktree-pool.ts";
import {
	createWorktree,
	createWorktreeSet,
	recoverWorktree,
} from "../../src/server/skills/git.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

interface GitFixture {
	root: string;
	repo: string;
	origin: string;
}

function makeGitFixture(label: string): GitFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-no-publication-${label}-`));
	roots.push(root);
	const origin = path.join(root, "origin.git");
	const repo = path.join(root, "repo");
	fs.mkdirSync(origin);
	fs.mkdirSync(repo);
	git(origin, "init", "--bare", "--initial-branch=master");
	git(repo, "init", "--initial-branch=master");
	git(repo, "config", "user.name", "Bobbit Test");
	git(repo, "config", "user.email", "bobbit-test@example.invalid");
	git(repo, "config", "core.autocrlf", "false");
	fs.writeFileSync(path.join(repo, "README.md"), `# ${label}\n`, "utf8");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-u", "origin", "master");
	git(repo, "remote", "set-head", "origin", "master");
	return { root, repo, origin };
}

function remoteHasBranch(origin: string, branch: string): boolean {
	return spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: origin,
		stdio: "ignore",
	}).status === 0;
}

function expectRemoteBranchAbsent(origin: string, branch: string, operation: string): void {
	expect(
		remoteHasBranch(origin, branch),
		`LIFECYCLE_REMOTE_REF_RESURRECTED: ${operation} published refs/heads/${branch}`,
	).toBe(false);
}

function explicitlyPublishThenDelete(fixture: GitFixture, worktree: string, branch: string): void {
	git(worktree, "push", "origin", `${branch}:refs/heads/${branch}`);
	expect(remoteHasBranch(fixture.origin, branch)).toBe(true);
	// Model an external remote deletion without exercising Bobbit's cleanup path.
	git(fixture.origin, "update-ref", "-d", `refs/heads/${branch}`);
	expectRemoteBranchAbsent(fixture.origin, branch, "external deletion setup");
}

describe("real Git lifecycle operations preserve deleted remote branches", () => {
	it("keeps configured-base creation, reuse, and recovery local-only", async () => {
		const fixture = makeGitFixture("configured-base");
		const branch = "session/configured-base-local";
		const created = await createWorktree(fixture.repo, branch, {
			configuredBaseRef: "origin/master",
		});

		expect(git(created.worktreePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toBe("origin/master");
		expectRemoteBranchAbsent(fixture.origin, branch, "configured base_ref creation");

		explicitlyPublishThenDelete(fixture, created.worktreePath, branch);
		const reused = await createWorktree(fixture.repo, branch, {
			configuredBaseRef: "origin/master",
		});
		expect(reused.worktreePath).toBe(created.worktreePath);
		expectRemoteBranchAbsent(fixture.origin, branch, "existing worktree reuse");

		git(fixture.repo, "worktree", "remove", "--force", created.worktreePath);
		const recoveredPath = path.join(fixture.root, "recovered-configured-base");
		const recovered = await recoverWorktree(fixture.repo, branch, recoveredPath);
		expect(recovered).toBe(recoveredPath);
		expect(git(recoveredPath, "branch", "--show-current")).toBe(branch);
		expectRemoteBranchAbsent(fixture.origin, branch, "worktree recovery");
	});

	it("keeps two-repository configured-base creation and reuse local-only", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-no-publication-multirepo-"));
		roots.push(root);
		const projectRoot = path.join(root, "project");
		fs.mkdirSync(projectRoot);
		const api = makeGitFixture("api");
		const web = makeGitFixture("web");
		const apiRepo = path.join(projectRoot, "api");
		const webRepo = path.join(projectRoot, "web");
		fs.renameSync(api.repo, apiRepo);
		fs.renameSync(web.repo, webRepo);

		const branch = "goal/polyrepo-local";
		const components = [
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
		];
		const created = await createWorktreeSet(projectRoot, components, branch, undefined, {
			configuredBaseRef: "origin/master",
		});
		expect(created.worktrees.map(entry => entry.repo)).toEqual(["api", "web"]);
		expectRemoteBranchAbsent(api.origin, branch, "multi-repo api creation");
		expectRemoteBranchAbsent(web.origin, branch, "multi-repo web creation");

		for (const entry of created.worktrees) {
			const fixture = entry.repo === "api" ? api : web;
			explicitlyPublishThenDelete(fixture, entry.worktreePath, branch);
			git(entry.repoPath, "worktree", "remove", "--force", entry.worktreePath);
		}

		const reused = await createWorktreeSet(projectRoot, components, branch, undefined, {
			configuredBaseRef: "origin/master",
		});
		expect(reused.worktrees).toHaveLength(2);
		expectRemoteBranchAbsent(api.origin, branch, "multi-repo api reuse");
		expectRemoteBranchAbsent(web.origin, branch, "multi-repo web reuse");
	});

	it("pool claim does not recreate a previously deleted target remote", async () => {
		const fixture = makeGitFixture("pool-claim");
		const poolBranch = "pool/_pool-no-publication";
		const targetBranch = "session/claimed-local";
		const poolWorktree = path.join(fixture.root, "pool-worktree");
		git(fixture.repo, "worktree", "add", "-b", poolBranch, poolWorktree, "origin/master");
		git(fixture.repo, "push", "origin", `master:refs/heads/${targetBranch}`);
		git(fixture.origin, "update-ref", "-d", `refs/heads/${targetBranch}`);
		expectRemoteBranchAbsent(fixture.origin, targetBranch, "external deletion before pool claim");

		const pool = new WorktreePool({ repoPath: fixture.repo, targetSize: 0 });
		pool.registerExternalEntry(poolBranch, poolWorktree);
		try {
			const claim = await pool.claim(targetBranch);
			expect(claim?.branchName).toBe(targetBranch);
			await pool.stop();
			expectRemoteBranchAbsent(fixture.origin, targetBranch, "pool claim and freshen");
		} finally {
			await pool.stop();
		}
	});

	it("GoalManager merges a local child without recreating a deleted parent remote", async () => {
		const fixture = makeGitFixture("child-merge");
		const parentBranch = "goal/parent-local";
		const childBranch = "goal/child-local";
		const parentWorktree = path.join(fixture.root, "parent-worktree");
		const childWorktree = path.join(fixture.root, "child-worktree");
		git(fixture.repo, "worktree", "add", "-b", parentBranch, parentWorktree, "origin/master");
		git(fixture.repo, "worktree", "add", "-b", childBranch, childWorktree, parentBranch);
		fs.writeFileSync(path.join(childWorktree, "child.txt"), "local child change\n", "utf8");
		git(childWorktree, "add", "child.txt");
		git(childWorktree, "commit", "-m", "child change");
		explicitlyPublishThenDelete(fixture, parentWorktree, parentBranch);

		const stateDir = path.join(fixture.root, "goal-state");
		const store = new GoalStore(stateDir);
		const now = Date.now();
		store.put({
			id: "parent",
			title: "Parent",
			cwd: parentWorktree,
			state: "in-progress",
			spec: "",
			createdAt: now,
			updatedAt: now,
			branch: parentBranch,
			worktreePath: parentWorktree,
			repoPath: fixture.repo,
		});
		store.put({
			id: "child",
			title: "Child",
			cwd: childWorktree,
			state: "complete",
			spec: "",
			createdAt: now,
			updatedAt: now,
			branch: childBranch,
			worktreePath: childWorktree,
			repoPath: fixture.repo,
			parentGoalId: "parent",
		});

		const outcome = await new GoalManager(store).mergeChild("parent", "child");
		expect(outcome.merged).toBe(true);
		expect(outcome.conflict).toBe(false);
		expect(outcome).not.toHaveProperty("pushed");
		expect(outcome).not.toHaveProperty("pushError");
		expect(fs.readFileSync(path.join(parentWorktree, "child.txt"), "utf8")).toBe("local child change\n");
		expectRemoteBranchAbsent(fixture.origin, parentBranch, "GoalManager.mergeChild");
	});
});
