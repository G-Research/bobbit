/**
 * Unit tests for worktree-sweeper.classifyWorktrees.
 *
 * Pure function — no git, no I/O. Feeds canned `git worktree list --porcelain`
 * output and asserts the classification buckets (pool / active / orphan / repair).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executionPathIdentity } from "../src/server/agent/resolve-project.ts";
import { classifyWorktrees, sweepOrphanedWorktrees } from "../src/server/agent/worktree-sweeper.ts";
import { realCommandRunner, type CommandRunner } from "../src/server/gateway-deps.ts";
import { cleanupWorktree } from "../src/server/skills/git.ts";

const REPO = "/tmp/repo";

const PORCELAIN = `worktree /tmp/repo
HEAD aaaa
branch refs/heads/master

worktree /tmp/repo-wt/pool-_pool-abcd1234
HEAD bbbb
branch refs/heads/pool/_pool-abcd1234

worktree /tmp/repo-wt/session-_pool-legacy55
HEAD cccc
branch refs/heads/session/_pool-legacy55

worktree /tmp/repo-wt/session-coder-12345678
HEAD dddd
branch refs/heads/session/coder-12345678

worktree /tmp/repo-wt/goal-fix-87654321
HEAD eeee
branch refs/heads/goal/fix-87654321

worktree /tmp/repo-wt/session-old-orphan
HEAD ffff
branch refs/heads/session/old-orphan

worktree /tmp/repo-wt/session-drift-aaaaaaaa
HEAD gggg
branch refs/heads/session/drift-aaaaaaaa
`;

describe("worktree-sweeper.classifyWorktrees", () => {
	it("buckets pool, legacy-pool, active, orphan, and drifted worktrees correctly", () => {
		const out = classifyWorktrees({
			porcelainStdout: PORCELAIN,
			repoPath: REPO,
			goals: [
				{ id: "g1", branch: "goal/fix-87654321", worktreePath: "/tmp/repo-wt/goal-fix-87654321" },
			],
			sessions: [
				{ id: "s1", branch: "session/coder-12345678", worktreePath: "/tmp/repo-wt/session-coder-12345678" },
				// Drift case: record says path X, git lists path Y.
				{ id: "s2", branch: "session/drift-aaaaaaaa", worktreePath: "/tmp/repo-wt/session-drift-OLDPATH" },
			],
			staff: [],
		});

		// Pool entries: new + legacy prefixes both classified as pool.
		assert.equal(out.pool.length, 2, `expected 2 pool entries, got ${out.pool.map(p => p.branch).join(",")}`);
		assert.ok(out.pool.some(p => p.branch === "pool/_pool-abcd1234"));
		assert.ok(out.pool.some(p => p.branch === "session/_pool-legacy55"));

		// Active: owned-by-record + path matches.
		assert.equal(out.active.length, 2, `expected 2 active, got ${out.active.map(a => a.branch).join(",")}`);
		assert.ok(out.active.some(a => a.branch === "session/coder-12345678"));
		assert.ok(out.active.some(a => a.branch === "goal/fix-87654321"));

		// Orphan: branch on disk with no live record.
		assert.equal(out.orphan.length, 1, `expected 1 orphan, got ${out.orphan.map(o => o.branch).join(",")}`);
		assert.equal(out.orphan[0].branch, "session/old-orphan");

		// Repair: drift case — record says path X, git path differs.
		assert.equal(out.repair.length, 1);
		assert.equal(out.repair[0].branch, "session/drift-aaaaaaaa");
	});

	it("classifies primary worktree as neither active nor orphan", () => {
		const out = classifyWorktrees({
			porcelainStdout: PORCELAIN,
			repoPath: REPO,
			goals: [],
			sessions: [],
			staff: [],
		});
		// Primary worktree (master) is filtered out — should not appear in any bucket.
		const all = [...out.pool, ...out.active, ...out.orphan, ...out.repair];
		assert.equal(all.some(w => w.path === REPO), false, "primary worktree must not appear");
	});

	it("legacy session-<slug>-<id8> dirs owned by live records stay active; unowned ones go to orphan", () => {
		// Design §13 (post-rename-removal): pre-existing legacy dir layouts owned
		// by still-live persisted sessions are tolerated indefinitely. Once the
		// legacy session archives, its dir flips to orphan and gets cleaned.
		const legacyPorcelain = `worktree /tmp/repo-wt/session-old-slug-cafebabe
branch refs/heads/session/old-slug-cafebabe

worktree /tmp/repo-wt/session-new-session-deadbeef
branch refs/heads/session/new-session-deadbeef
`;
		const out = classifyWorktrees({
			porcelainStdout: legacyPorcelain,
			repoPath: REPO,
			goals: [],
			sessions: [
				// Live session still owns the legacy slug-style branch.
				{ id: "s1", branch: "session/old-slug-cafebabe", worktreePath: "/tmp/repo-wt/session-old-slug-cafebabe" },
				// `session/new-session-*` has no live owner — must be orphaned.
			],
			staff: [],
		});
		assert.equal(out.active.length, 1);
		assert.equal(out.active[0].branch, "session/old-slug-cafebabe");
		assert.equal(out.orphan.length, 1);
		assert.equal(out.orphan[0].branch, "session/new-session-deadbeef");
	});

	it("treats archived records as if absent (their worktrees become orphans)", () => {
		const out = classifyWorktrees({
			porcelainStdout: `worktree /tmp/repo-wt/session-arch-deadbeef\nbranch refs/heads/session/arch-deadbeef\n`,
			repoPath: REPO,
			goals: [],
			sessions: [
				{ id: "s1", branch: "session/arch-deadbeef", worktreePath: "/tmp/repo-wt/session-arch-deadbeef", archived: true },
			],
			staff: [],
		});
		assert.equal(out.orphan.length, 1);
		assert.equal(out.active.length, 0);
	});

	it("keeps a boot-sweeper candidate active when a live session only references it by cwd", () => {
		const out = classifyWorktrees({
			porcelainStdout: `worktree /tmp/repo-wt/session-cwd-owned\nbranch refs/heads/session/stale-cwd-branch\n`,
			repoPath: REPO,
			goals: [],
			sessions: [
				{ id: "archived", branch: "session/stale-cwd-branch", worktreePath: "/tmp/repo-wt/session-cwd-owned", archived: true },
				{ id: "live", branch: "session/live-different", cwd: "/tmp/repo-wt/session-cwd-owned/subdir" },
			],
			staff: [],
		});
		assert.equal(out.active.length, 1);
		assert.equal(out.active[0].path, "/tmp/repo-wt/session-cwd-owned");
		assert.equal(out.orphan.length, 0);
	});

	it("protects durable team-owned worktrees and branches", () => {
		const out = classifyWorktrees({
			porcelainStdout: `worktree /tmp/repo-wt/team-agent\nbranch refs/heads/session/team-agent\n\nworktree /tmp/repo-wt/team-lead\nbranch refs/heads/goal/team-lead\n`,
			repoPath: REPO,
			goals: [],
			sessions: [],
			teams: [
				{ id: "agent", branch: "session/team-agent", worktreePath: "/tmp/repo-wt/team-agent" },
				{ id: "lead", branch: "goal/team-lead", worktreePath: "/tmp/repo-wt/team-lead", archived: true },
			],
			staff: [],
		});
		assert.equal(out.active.length, 2);
		assert.deepEqual(out.orphan.map(w => w.branch), []);
	});

	it("protects durable team-agent branch containers for multi-repo component worktrees", () => {
		const out = classifyWorktrees({
			porcelainStdout: `worktree /tmp/proj/api\nbranch refs/heads/master\n\nworktree /tmp/proj-wt/session-team-agent/api\nbranch refs/heads/session/team-agent\n`,
			repoPath: "/tmp/proj/api",
			goals: [],
			sessions: [],
			teams: [
				{ id: "agent", branch: "session/team-agent", worktreePath: "/tmp/proj-wt/session-team-agent" },
			],
			staff: [],
		});
		assert.equal(out.active.length, 1);
		assert.equal(out.active[0].path, "/tmp/proj-wt/session-team-agent/api");
		assert.equal(out.repair.length, 0);
		assert.equal(out.orphan.length, 0);
	});
});

describe("worktree-sweeper.sweepOrphanedWorktrees", () => {
	function git(repo: string, args: string[]): string {
		return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	}

	function registeredWorktreePaths(repo: string): string[] {
		return git(repo, ["worktree", "list", "--porcelain"])
			.split(/\r?\n/)
			.filter(line => line.startsWith("worktree "))
			.map(line => line.slice("worktree ".length));
	}

	it("preserves archived-owned orphan worktrees and durable archived branches", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweeper-archived-branch-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-arch");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/arch", wt, "HEAD"]);

			const result = await sweepOrphanedWorktrees({
				projects: [{ id: "p1", rootPath: repo }],
				goals: [],
				sessions: [{ id: "archived", branch: "session/arch", worktreePath: wt, archived: true }],
				staff: [],
			});

			assert.equal(result.cleaned, 0);
			assert.equal(result.repaired, 0);
			assert.equal(fs.existsSync(wt), true, "archived worktree must remain");
			assert.equal(
				registeredWorktreePaths(repo).some(candidate => executionPathIdentity(candidate) === executionPathIdentity(wt)),
				true,
				"archived worktree metadata must remain",
			);
			assert.doesNotThrow(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/session/arch"]), "durable archived branch must remain");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects the primary repository and Git common roots without deleting them", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-primary-"));
		const repo = path.join(tmp, "repo");
		const sentinel = path.join(repo, "keep.txt");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(sentinel, "must survive\n");
			git(repo, ["add", "keep.txt"]);
			git(repo, ["commit", "-m", "initial"]);

			for (const protectedPath of [repo, path.join(repo, ".git")]) {
				await assert.rejects(
					cleanupWorktree(repo, protectedPath),
					/protected repository|common-root|main worktree/i,
				);
			}
			assert.equal(fs.readFileSync(sentinel, "utf8"), "must survive\n");
			assert.equal(fs.existsSync(path.join(repo, ".git")), true, "primary Git metadata must remain");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an unregistered directory without deleting it", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-unregistered-"));
		const repo = path.join(tmp, "repo");
		const unregistered = path.join(tmp, "unregistered");
		const sentinel = path.join(unregistered, "keep.txt");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			fs.mkdirSync(unregistered);
			fs.writeFileSync(sentinel, "must survive\n");

			await assert.rejects(
				cleanupWorktree(repo, unregistered),
				/exact registered linked worktree/i,
			);
			assert.equal(fs.readFileSync(sentinel, "utf8"), "must survive\n");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects before mutation when existing-worktree metadata proof fails", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-proof-error-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-proof-error");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/proof-error", wt, "HEAD"]);
			let removeCalls = 0;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
						throw new Error("synthetic metadata proof failure");
					}
					if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
						removeCalls++;
						throw new Error("worktree remove must not run after proof failure");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await assert.rejects(
				cleanupWorktree(repo, wt, undefined, false, runner),
				/synthetic metadata proof failure/i,
			);
			assert.equal(removeCalls, 0, "Git removal must not start without complete ownership proof");
			assert.equal(fs.existsSync(wt), true, "proof failure must not delete the worktree directory");
			assert.equal(
				registeredWorktreePaths(repo).some(candidate => executionPathIdentity(candidate) === executionPathIdentity(wt)),
				true,
				"proof failure must not remove the Git registration",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an invalid worktree admin backlink before mutation", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-invalid-backlink-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-invalid-backlink");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/invalid-backlink", wt, "HEAD"]);
			let removeCalls = 0;
			let adminPath = "";
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
						const result = await realCommandRunner.execFile(file, args, options);
						adminPath = result.stdout.toString().trim();
						fs.writeFileSync(path.join(adminPath, "gitdir"), `${path.join(tmp, "unrelated", ".git")}\n`);
						return result;
					}
					if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
						removeCalls++;
						throw new Error("worktree remove must not run with an invalid backlink");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await assert.rejects(
				cleanupWorktree(repo, wt, undefined, false, runner),
				/admin backlink/i,
			);
			assert.equal(removeCalls, 0, "Git removal must not start with an invalid admin backlink");
			assert.equal(fs.existsSync(wt), true, "invalid metadata must not delete the worktree directory");
			assert.equal(fs.existsSync(adminPath), true, "invalid metadata must not delete the Git admin entry");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("removes a registered worktree alias through Git's spelling and the exact fallback", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-alias-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-alias");
		const alias = path.join(tmp, "worktree-alias");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/alias", wt, "HEAD"]);
			fs.symlinkSync(wt, alias, process.platform === "win32" ? "junction" : "dir");
			const removeTargets: string[] = [];
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
						removeTargets.push(String(args[2]));
						throw new Error("synthetic Git removal failure");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			assert.equal(executionPathIdentity(alias), executionPathIdentity(wt), "fixture alias must identify the registered worktree");
			const gitSpelling = registeredWorktreePaths(repo).find(candidate => executionPathIdentity(candidate) === executionPathIdentity(wt));
			assert.ok(gitSpelling, "fixture worktree must appear in Git porcelain output");
			await cleanupWorktree(repo, alias, undefined, false, runner);

			assert.deepEqual(removeTargets, [gitSpelling], "cleanup must pass Git its authoritative porcelain spelling");
			assert.equal(fs.existsSync(wt), false, "cleanup must remove the registered worktree directory");
			assert.equal(
				registeredWorktreePaths(repo).some(candidate => executionPathIdentity(candidate) === executionPathIdentity(wt)),
				false,
				"cleanup must remove the exact Git registration",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects when the repository vanishes after Git removal fails", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-repo-vanished-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-repo-vanished");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/repo-vanished", wt, "HEAD"]);
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
						fs.rmSync(repo, { recursive: true, force: true });
						throw new Error("synthetic Git removal failure after repository vanished");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await assert.rejects(
				cleanupWorktree(repo, wt, undefined, false, runner),
				/failed to verify worktree cleanup/i,
			);
			assert.equal(fs.existsSync(repo), false, "fixture must remove the repository before postcondition verification");
			assert.equal(fs.existsSync(wt), false, "the exact worktree fallback should still run before verification rejects");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects when the directory vanishes but its exact admin entry remains", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-admin-remains-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-admin-remains");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/admin-remains", wt, "HEAD"]);
			let adminPath = "";
			let listingCount = 0;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "worktree" && args[1] === "list") {
						listingCount++;
						if (listingCount > 1) return { stdout: `worktree ${repo}\0`, stderr: "" };
					}
					if (file === "git" && args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
						const result = await realCommandRunner.execFile(file, args, options);
						adminPath = result.stdout.toString().trim();
						return result;
					}
					if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
						return { stdout: "", stderr: "" };
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await assert.rejects(
				cleanupWorktree(repo, wt, undefined, false, runner),
				/admin directory remains/i,
			);
			assert.equal(fs.existsSync(wt), false, "the exact worktree directory fallback must run");
			assert.equal(fs.existsSync(adminPath), true, "the fixture must retain the proven admin entry");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("fails when the authoritative postcondition listing cannot be read", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-worktree-postcondition-"));
		const repo = path.join(tmp, "repo");
		const wt = path.join(tmp, "repo-wt", "session-postcondition");
		try {
			fs.mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			git(repo, ["config", "user.email", "test@example.com"]);
			git(repo, ["config", "user.name", "Test User"]);
			fs.writeFileSync(path.join(repo, "README.md"), "test\n");
			git(repo, ["add", "README.md"]);
			git(repo, ["commit", "-m", "initial"]);
			git(repo, ["worktree", "add", "-b", "session/postcondition", wt, "HEAD"]);
			let listingCount = 0;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (file === "git" && args[0] === "worktree" && args[1] === "list" && ++listingCount > 1) {
						throw new Error("synthetic postcondition listing failure");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await assert.rejects(
				cleanupWorktree(repo, wt, undefined, false, runner),
				/failed to verify worktree cleanup.*synthetic postcondition listing failure/i,
			);
			assert.equal(fs.existsSync(wt), false, "Git removal may finish, but verification failure must still reject");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("skips a project whose rootPath has no .git (does not walk upward)", async () => {
		// Regression: when rootPath is a directory inside another git repo,
		// `git worktree list` walks upward and returns the parent's worktrees.
		// The sweeper would then try to clean unrelated worktrees — catastrophic.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweeper-no-git-"));
		try {
			const result = await sweepOrphanedWorktrees({
				projects: [{ id: "p1", rootPath: tmp }],
				goals: [],
				sessions: [],
				staff: [],
			});
			assert.equal(result.cleaned, 0, "must not clean any worktrees from a non-repo rootPath");
			assert.equal(result.repaired, 0);
			assert.equal(result.reclaimed, 0);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
