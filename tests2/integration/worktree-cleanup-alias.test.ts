import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { realCommandRunner, type CommandRunner } from "../../src/server/gateway-deps.js";
import { cleanupWorktree } from "../../src/server/skills/git.js";

const nativeRealpath = promisify(fs.realpath.native);

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await realCommandRunner.execFile("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
	return String(result.stdout).trim();
}

type AliasKind = "lexical" | "native";

async function createFixture(label: string, aliasKind: AliasKind = process.platform === "win32" ? "native" : "lexical"): Promise<{
	root: string;
	repo: string;
	worktree: string;
	alias: string;
	branch: string;
	adminPath: string;
}> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `bobbit-cleanup-${label}-`));
	const repo = path.join(root, "repo");
	const worktree = path.join(root, "worktrees", "linked");
	let alias: string;
	const branch = `session/${label}`;
	await fs.promises.mkdir(repo, { recursive: true });
	await git(repo, ["init"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "Test User"]);
	await fs.promises.writeFile(path.join(repo, "README.md"), "fixture\n");
	await git(repo, ["add", "README.md"]);
	await git(repo, ["commit", "-m", "fixture"]);
	await fs.promises.mkdir(path.dirname(worktree), { recursive: true });
	await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
	if (aliasKind === "native") {
		if (process.platform !== "win32") throw new Error("native alias fixture requires Windows");
		const result = await realCommandRunner.execFile(
			"cmd.exe",
			["/d", "/c", `for %I in (${worktree}) do @echo %~sI`],
			{ encoding: "utf8", timeout: 10_000 },
		);
		alias = String(result.stdout).trim();
		if (!alias || alias.toLowerCase() === worktree.toLowerCase()) {
			throw new Error(`fixture did not obtain a distinct Windows short path for ${worktree}`);
		}
	} else {
		alias = `${worktree}${path.sep}..${path.sep}${path.basename(worktree)}`;
	}

	const marker = await fs.promises.readFile(path.join(worktree, ".git"), "utf8");
	const gitDir = /^gitdir:\s*(.+)$/m.exec(marker)?.[1]?.trim();
	if (!gitDir) throw new Error("fixture linked worktree has no gitdir marker");
	const adminPath = path.isAbsolute(gitDir) ? path.normalize(gitDir) : path.resolve(worktree, gitDir);
	return { root, repo, worktree, alias, branch, adminPath };
}

async function registeredWorktreePaths(repo: string): Promise<string[]> {
	return (await git(repo, ["worktree", "list", "--porcelain", "-z"]))
		.split("\0")
		.filter(field => field.startsWith("worktree "))
		.map(field => field.slice("worktree ".length));
}

async function removeFixture(root: string): Promise<void> {
	await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}

describe("cleanupWorktree filesystem aliases", () => {
	it.each<AliasKind>(process.platform === "win32" ? ["native", "lexical"] : ["lexical"])(
		"passes Git its registered spelling for a %s alias and removes the exact directory, admin entry, and branch",
		async (aliasKind) => {
			const fixture = await createFixture(`alias-success-${aliasKind}`, aliasKind);
			try {
				const aliasIdentity = await nativeRealpath(fixture.alias);
				let registeredPath: string | undefined;
				for (const candidate of await registeredWorktreePaths(fixture.repo)) {
					if (await nativeRealpath(candidate) === aliasIdentity) {
						registeredPath = candidate;
						break;
					}
				}
				expect(registeredPath).toBeTruthy();
				const removeTargets: string[] = [];
				const runner: CommandRunner = {
					execFile: async (file, args, options) => {
						if (args[0] === "worktree" && args[1] === "remove") removeTargets.push(String(args[2]));
						return realCommandRunner.execFile(file, args, options);
					},
				};

				await cleanupWorktree(fixture.repo, fixture.alias, fixture.branch, true, runner, { skipRemotePush: true });

				expect(removeTargets).toEqual([registeredPath]);
				await expect(fs.promises.lstat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.promises.lstat(fixture.adminPath)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await registeredWorktreePaths(fixture.repo)).not.toContain(registeredPath);
				await expect(git(fixture.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${fixture.branch}`])).rejects.toBeTruthy();
			} finally {
				await removeFixture(fixture.root);
			}
		},
	);

	it("fails closed when porcelain omits the proven alias registration", async () => {
		const fixture = await createFixture("alias-unregistered");
		try {
			let removeCalls = 0;
			let branchDeleteCalls = 0;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (args[0] === "worktree" && args[1] === "list") {
						return { stdout: `worktree ${fixture.repo}\0`, stderr: "" };
					}
					if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
					if (args[0] === "branch" && args[1] === "-D") branchDeleteCalls += 1;
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await expect(cleanupWorktree(
				fixture.repo,
				fixture.alias,
				fixture.branch,
				true,
				runner,
				{ skipRemotePush: true },
			)).rejects.toThrow(/cannot resolve git worktree registration for aliased path/i);

			expect(removeCalls).toBe(0);
			expect(branchDeleteCalls).toBe(0);
			expect((await fs.promises.lstat(fixture.worktree)).isDirectory()).toBe(true);
			expect(await git(fixture.repo, ["show-ref", "--verify", `refs/heads/${fixture.branch}`])).toBeTruthy();
		} finally {
			await removeFixture(fixture.root);
		}
	});

	it("rejects a failed aliased removal before deleting the branch", async () => {
		const fixture = await createFixture("alias-failure");
		try {
			const removeTargets: string[] = [];
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (args[0] === "worktree" && args[1] === "remove") {
						removeTargets.push(String(args[2]));
						throw new Error("synthetic worktree removal failure");
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await expect(cleanupWorktree(
				fixture.repo,
				fixture.alias,
				fixture.branch,
				true,
				runner,
				{ skipRemotePush: true },
			)).rejects.toThrow(/directory remains.*synthetic worktree removal failure/i);

			expect(removeTargets).toHaveLength(1);
			expect(await nativeRealpath(removeTargets[0]!)).toBe(await nativeRealpath(fixture.worktree));
			expect((await fs.promises.readFile(path.join(fixture.worktree, "README.md"), "utf8")).trim()).toBe("fixture");
			expect((await fs.promises.lstat(fixture.adminPath)).isDirectory()).toBe(true);
			expect(await git(fixture.repo, ["show-ref", "--verify", `refs/heads/${fixture.branch}`])).toBeTruthy();
		} finally {
			await removeFixture(fixture.root);
		}
	});

	it("removes ordinary residue after Git succeeds and fences absence before branch deletion", async () => {
		const fixture = await createFixture("ordinary-residue-success", "lexical");
		try {
			let listCalls = 0;
			let branchDeleteCalls = 0;
			let branchDeleteObservedAbsent = false;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (args[0] === "worktree" && args[1] === "list") listCalls += 1;
					if (args[0] === "worktree" && args[1] === "remove") {
						const result = await realCommandRunner.execFile(file, args, options);
						await fs.promises.mkdir(fixture.worktree, { recursive: true });
						await fs.promises.writeFile(path.join(fixture.worktree, "residual.txt"), "residue\n");
						return result;
					}
					if (args[0] === "branch" && args[1] === "-D") {
						branchDeleteCalls += 1;
						branchDeleteObservedAbsent = !await fs.promises.lstat(fixture.worktree).then(
							() => true,
							(err: NodeJS.ErrnoException) => {
								if (err.code === "ENOENT") return false;
								throw err;
							},
						);
					}
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await cleanupWorktree(fixture.repo, fixture.worktree, fixture.branch, true, runner, { skipRemotePush: true });

			expect(listCalls).toBe(0);
			expect(branchDeleteCalls).toBe(1);
			expect(branchDeleteObservedAbsent).toBe(true);
			await expect(fs.promises.lstat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.promises.lstat(fixture.adminPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(git(fixture.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${fixture.branch}`])).rejects.toBeTruthy();
		} finally {
			await removeFixture(fixture.root);
		}
	});

	it("retains the branch when ordinary residual recovery fails", async () => {
		const fixture = await createFixture("ordinary-residue-failure", "lexical");
		const realRename = fs.promises.rename.bind(fs.promises);
		const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
			if (typeof oldPath === "string" && path.resolve(oldPath) === path.resolve(fixture.worktree)) {
				throw new Error("synthetic residual recovery failure");
			}
			return realRename(oldPath, newPath);
		});
		try {
			let listCalls = 0;
			let branchDeleteCalls = 0;
			const runner: CommandRunner = {
				execFile: async (file, args, options) => {
					if (args[0] === "worktree" && args[1] === "list") listCalls += 1;
					if (args[0] === "worktree" && args[1] === "remove") {
						const result = await realCommandRunner.execFile(file, args, options);
						await fs.promises.mkdir(fixture.worktree, { recursive: true });
						await fs.promises.writeFile(path.join(fixture.worktree, "residual.txt"), "residue\n");
						return result;
					}
					if (args[0] === "branch" && args[1] === "-D") branchDeleteCalls += 1;
					return realCommandRunner.execFile(file, args, options);
				},
			};

			await expect(cleanupWorktree(
				fixture.repo,
				fixture.worktree,
				fixture.branch,
				true,
				runner,
				{ skipRemotePush: true },
			)).rejects.toThrow(/synthetic residual recovery failure/i);

			expect(listCalls).toBe(0);
			expect(branchDeleteCalls).toBe(0);
			expect((await fs.promises.lstat(fixture.worktree)).isDirectory()).toBe(true);
			expect(await git(fixture.repo, ["show-ref", "--verify", `refs/heads/${fixture.branch}`])).toBeTruthy();
		} finally {
			renameSpy.mockRestore();
			await removeFixture(fixture.root);
		}
	});

	it("preserves the operation-first command surface for nonexistent injected coordinates", async () => {
		const calls: string[][] = [];
		const runner: CommandRunner = {
			execFile: async (_file, args) => {
				calls.push([...args]);
				return { stdout: "", stderr: "" };
			},
		};
		const repo = path.resolve("nonexistent-cleanup-repo");
		const worktree = path.resolve("nonexistent-cleanup-worktree");

		await cleanupWorktree(repo, worktree, "session/fake", true, runner, { skipRemotePush: true });

		expect(calls).toEqual([
			["worktree", "remove", worktree, "--force"],
			["branch", "-D", "session/fake"],
		]);
	});
});
