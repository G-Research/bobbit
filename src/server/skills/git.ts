import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveShell } from "../agent/shell-util.js";
import type { Component } from "../agent/project-config-store.js";
import { branchToSlug, worktreeRoot as wtRootHelper } from "./worktree-paths.js";

const execFile = promisify(execFileCb);

/**
 * Whether remote git push operations should be skipped.
 * Set BOBBIT_TEST_NO_PUSH=1 in E2E tests to prevent any network traffic to GitHub.
 */
export function shouldSkipRemotePush(): boolean {
	return process.env.BOBBIT_TEST_NO_PUSH === "1";
}

/**
 * Strip embedded credentials from a git remote URL.
 * e.g. "https://ghp_abc123@github.com/user/repo.git" → "https://github.com/user/repo.git"
 * Prevents tokens from leaking into .git/config inside sandbox containers.
 * Authentication is handled by the credential helper reading GITHUB_TOKEN from env.
 */
export function stripTokenFromGitUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		}
	} catch {
		// Not a URL (e.g. SSH or local path) — return as-is
	}
	return url;
}

/**
 * Resolve the remote primary branch (e.g. origin/main or origin/master).
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` which is set by `git clone`.
 * Falls back to "HEAD" if detection fails.
 */
/**
 * Detect the bare primary branch name (e.g. "main" or "master").
 * Uses `git symbolic-ref refs/remotes/origin/HEAD`, which is set by `git clone`.
 * Falls back to local `master`, then local `main`, then literal "master".
 *
 * Unlike `resolveRemotePrimary` (which returns the ref with `origin/` prefix),
 * this returns the bare branch name suitable for substituting into prompt
 * templates as `{{master}}`.
 */
export async function detectPrimaryBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd,
			timeout: 5_000,
		});
		const ref = stdout.trim().replace("refs/remotes/origin/", "");
		if (ref) return ref;
	} catch { /* fall through */ }
	try {
		await execFile("git", ["rev-parse", "--verify", "refs/heads/master"], { cwd, timeout: 5_000 });
		return "master";
	} catch { /* ignore */ }
	try {
		await execFile("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd, timeout: 5_000 });
		return "main";
	} catch { /* ignore */ }
	console.warn(`[git] detectPrimaryBranch(${cwd}): could not detect primary branch; defaulting to "master"`);
	return "master";
}

async function resolveRemotePrimary(repoPath: string): Promise<string> {
	try {
		const { stdout } = await execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: repoPath,
			timeout: 5_000,
		});
		// Returns e.g. "refs/remotes/origin/main\n" — extract "origin/main"
		const ref = stdout.trim().replace("refs/remotes/", "");
		if (ref) return ref;
	} catch {
		// symbolic-ref may fail if origin/HEAD is not set (e.g. bare init, no clone)
	}
	return "HEAD";
}

/** Check if a directory is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
export async function getRepoRoot(cwd: string): Promise<string> {
	const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd });
	return stdout.toString().trim();
}

/**
 * Thrown when `git worktree move` fails. Surfaces the underlying git error
 * so the worktree pool can decide whether to fall back to degraded mode
 * (branch renamed, dir kept at the old path).
 */
export class WorktreeMoveError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "WorktreeMoveError";
	}
}

/**
 * Move a worktree directory to a new path using `git worktree move`.
 *
 * `git worktree move` (added in git 2.17) atomically updates both the
 * worktree's `.git` pointer and the admin entry under `<repo>/.git/worktrees/`,
 * unlike a plain `mv` which leaves git tracking the old path.
 *
 * @throws WorktreeMoveError on failure (e.g. file locks on Windows). Callers
 *   in the worktree pool fall back to degraded mode (branch renamed only,
 *   directory stays at the old path).
 */
export async function moveWorktree(repoPath: string, oldPath: string, newPath: string): Promise<void> {
	if (oldPath === newPath) return;
	try {
		await execFile("git", ["worktree", "move", oldPath, newPath], {
			cwd: repoPath,
			timeout: 30_000,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new WorktreeMoveError(`git worktree move failed: ${oldPath} -> ${newPath}: ${msg}`, err);
	}
}

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from a given start-point (default HEAD).
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — the `git worktree add`, dependency setup, and `git push`
 * are all awaited without blocking the Node.js event loop.
 *
 * @param opts.setupCommand — explicit worktree setup command. If provided
 *   (and non-empty), runs this shell command in the worktree directory after
 *   `git worktree add` succeeds. Strictly opt-in: when undefined, NO setup
 *   runs. The canonical path for project worktrees is
 *   `components[*].worktreeSetupCommand` driven by `runComponentSetups()`
 *   in `worktree-setup.ts`; this option exists for callers (e.g. staff agent
 *   creation) that resolve the hook from the default component themselves.
 * @param opts.startPoint — git ref to base the new branch on (default `"HEAD"`).
 *   Pass e.g. `origin/my-branch` to start from a remote tracking branch.
 */
export async function createWorktree(repoPath: string, branchName: string, opts?: { setupCommand?: string; startPoint?: string; skipPush?: boolean; worktreeRoot?: string }): Promise<WorktreeResult> {
	// Validate repoPath exists — execFile with a bad cwd throws a misleading
	// "spawn git ENOENT" that looks like git isn't installed
	if (!fs.existsSync(repoPath)) {
		throw new Error(`Cannot create worktree: repoPath does not exist: ${repoPath}`);
	}

	// Place all worktrees under a single sibling directory: <repo>-wt/ by default,
	// or under the project-level `worktree_root` override when provided.
	const wtRoot = wtRootHelper({ rootPath: repoPath, worktreeRoot: opts?.worktreeRoot });
	// branchName may contain slashes (e.g. "goal/slug-id"), flatten to a safe dirname
	const safeName = branchName.replace(/\//g, "-");
	const worktreePath = path.join(wtRoot, safeName);

	// Resolve the start point — default to the remote primary branch so worktrees
	// are never based on a stale local checkout.
	let startPoint = opts?.startPoint;
	if (!startPoint) {
		startPoint = await resolveRemotePrimary(repoPath);
	}

	// Fetch the start point to ensure it's up to date
	try {
		const remote = startPoint.startsWith("origin/") ? startPoint.replace("origin/", "") : startPoint;
		await execFile("git", ["fetch", "origin", remote], { cwd: repoPath, timeout: 30_000 });
	} catch {
		// Fetch failure is non-fatal — may be offline, or startPoint is a local ref
	}

	// Check if the branch already exists (e.g. from a previous interrupted attempt)
	let branchExists = false;
	try {
		await execFile("git", ["rev-parse", "--verify", branchName], { cwd: repoPath });
		branchExists = true;
	} catch {
		// Branch doesn't exist — will create below
	}

	if (branchExists) {
		const dirExists = fs.existsSync(worktreePath);
		const gitFileExists = dirExists && fs.existsSync(path.join(worktreePath, ".git"));

		if (dirExists && gitFileExists) {
			// Worktree fully exists from a previous attempt — repair and reuse
			try {
				await execFile("git", ["worktree", "repair"], { cwd: repoPath });
				console.log(`[git] Repaired existing worktree for branch "${branchName}" at ${worktreePath}`);
			} catch {
				// repair failed — still usable if .git exists
			}
		} else {
			// Branch exists but worktree is missing or partial — clean up and re-create
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
			if (dirExists && !gitFileExists) {
				try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
				if (fs.existsSync(worktreePath)) {
					throw new Error(`Cannot create worktree: directory "${worktreePath}" exists and could not be removed (file locks?)`);
				}
			}
			// Re-create worktree using existing branch (no -b)
			await execFile("git", ["worktree", "add", worktreePath, branchName], { cwd: repoPath });
			console.log(`[git] Re-created worktree for existing branch "${branchName}" at ${worktreePath}`);
		}
	} else {
		// Branch doesn't exist — create branch and worktree in one step
		await execFile("git", ["worktree", "add", "-b", branchName, worktreePath, startPoint], {
			cwd: repoPath,
		});
	}

	// Set up dependencies in the new worktree — strictly opt-in via
	// `opts.setupCommand`. The canonical multi-component path is
	// `runComponentSetups()` invoked by the caller (worktree-pool, goal-manager,
	// staff-manager, etc.) so `components[*].worktreeSetupCommand` is the
	// single source of truth.
	if (!process.env.BOBBIT_SKIP_NPM_CI && opts?.setupCommand) {
		await setupWorktreeDeps(repoPath, worktreePath, opts.setupCommand);
	}

	// Push the new branch and set upstream tracking so git-status can report ahead/behind
	// and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	if (!opts?.skipPush && !shouldSkipRemotePush()) {
		try {
			await execFile("git", ["push", "-u", "origin", branchName], {
				cwd: worktreePath,
				timeout: 30_000, // 30s max for push
			});
		} catch {
			// Push may fail (no remote, auth issues, offline) — not fatal
		}
	}

	return { worktreePath, branchName };
}

/**
 * Create a coordinated set of worktrees — one per distinct repo declared in
 * `components`. Single-repo (one component, repo===".") collapses to today's
 * `createWorktree` behavior identically; multi-repo creates a per-repo worktree
 * under `<wtRoot>/<branchSlug>/<repo>/` from each repo's source at
 * `<rootPath>/<repo>/`.
 *
 * Does NOT run per-component setup commands — caller is responsible for
 * invoking `runComponentSetups()` afterward.
 *
 * See docs/design/multi-repo-components.md §4 + §5.
 */
export async function createWorktreeSet(
	rootPath: string,
	components: Component[],
	branchName: string,
	baseBranch?: string,
	opts?: { worktreeRoot?: string },
): Promise<{ container: string; worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }> }> {
	// Distinct repos in declared order.
	const seen = new Set<string>();
	const repos: string[] = [];
	for (const c of components) {
		if (!seen.has(c.repo)) { seen.add(c.repo); repos.push(c.repo); }
	}
	if (repos.length === 0) repos.push(".");  // defensive — empty components → single-repo

	const slug = branchToSlug(branchName);

	// Single-repo path collapses to existing behavior.
	if (repos.length === 1 && repos[0] === ".") {
		const result = await createWorktree(rootPath, branchName, { startPoint: baseBranch, skipPush: true, worktreeRoot: opts?.worktreeRoot });
		return {
			container: result.worktreePath,
			worktrees: [{ repo: ".", repoPath: rootPath, worktreePath: result.worktreePath }],
		};
	}

	// Multi-repo: container at `<wtRoot>/<branchSlug>/`, per-repo worktrees underneath.
	// `worktreeRoot` honors the project-level `worktree_root` override; falls back
	// to `<rootPath>-wt/` when unset.
	const wtRoot = wtRootHelper({ rootPath, worktreeRoot: opts?.worktreeRoot });
	const container = path.join(wtRoot, slug);
	if (!fs.existsSync(container)) {
		fs.mkdirSync(container, { recursive: true });
	}

	const out: Array<{ repo: string; repoPath: string; worktreePath: string }> = [];
	for (const repo of repos) {
		const repoSrc = path.join(rootPath, repo);
		const wtPath = path.join(container, repo);
		if (!fs.existsSync(repoSrc)) {
			throw new Error(`createWorktreeSet: source repo not found: ${repoSrc}`);
		}
		const startPoint = baseBranch ?? await resolveRemotePrimary(repoSrc);

		// Branch may already exist from a prior partial attempt.
		let branchExists = false;
		try {
			await execFile("git", ["rev-parse", "--verify", branchName], { cwd: repoSrc });
			branchExists = true;
		} catch { /* not present */ }

		try {
			if (branchExists) {
				await execFile("git", ["worktree", "add", wtPath, branchName], { cwd: repoSrc });
			} else {
				await execFile("git", ["worktree", "add", "-b", branchName, wtPath, startPoint], { cwd: repoSrc });
			}
		} catch (err) {
			throw new Error(`createWorktreeSet: git worktree add failed for repo "${repo}" at ${wtPath}: ${err instanceof Error ? err.message : err}`);
		}

		out.push({ repo, repoPath: repoSrc, worktreePath: wtPath });
	}

	return { container, worktrees: out };
}

/**
 * Run the worktree setup command (from project config `worktree_setup_command`).
 * If the command is empty, does nothing. The command always runs via `sh -c`
 * (Git Bash on Windows) for cross-platform consistency — since git is a hard
 * prerequisite for Bobbit, Git Bash is always available.
 * The SOURCE_REPO env var is set to the original repo path.
 */
export async function setupWorktreeDeps(repoPath: string, worktreePath: string, setupCommand: string): Promise<void> {
	if (!setupCommand) return;
	try {
		console.log(`[git] Running worktree setup command: ${setupCommand}`);
		await execFile(resolveShell(), ["-c", setupCommand],
			{
				cwd: worktreePath,
				timeout: 120_000,
				env: { ...process.env, SOURCE_REPO: repoPath },
			},
		);
		console.log(`[git] Worktree setup command completed`);
	} catch (err) {
		console.warn(`[git] Worktree setup command failed (non-fatal):`, err);
	}
}

/**
 * Remove a git worktree and optionally delete the branch.
 * Async to avoid blocking the Node.js event loop.
 */
export async function cleanupWorktree(
	repoPath: string,
	worktreePath: string,
	branchName?: string,
	deleteBranch = false,
): Promise<void> {
	if (!fs.existsSync(repoPath)) {
		console.warn(`[git] Cannot clean up worktree: repoPath does not exist: ${repoPath}`);
		return;
	}

	try {
		await execFile("git", ["worktree", "remove", worktreePath, "--force"], {
			cwd: repoPath,
		});
	} catch {
		// If remove fails, clean up the admin entry for this specific worktree
		// (NOT a blanket prune — that could damage other worktrees whose
		// directories exist but have broken .git metadata).
		try {
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				fs.rmSync(adminPath, { recursive: true, force: true });
			}
		} catch {
			// ignore
		}
	}

	if (deleteBranch && branchName) {
		try {
			await execFile("git", ["branch", "-D", branchName], { cwd: repoPath });
		} catch {
			// branch may not exist
		}
		// Also delete the remote branch (best-effort — remote may be unreachable,
		// or the repo may have no remote configured, e.g. in E2E tests).
		if (!shouldSkipRemotePush()) {
			try {
				await execFile("git", ["push", "origin", "--delete", branchName], {
					cwd: repoPath,
					timeout: 15_000,
				});
			} catch {
				// Remote may not exist, branch may not be pushed, or network unreachable
			}
		}
	}
}

/**
 * Recover a worktree whose directory is missing but whose branch still exists.
 *
 * This happens when a worktree directory is deleted (e.g. by cleanup, crash,
 * or manual removal) but the branch is preserved locally or on the remote.
 *
 * Steps:
 * 1. Prune stale worktree references (git tracks worktrees and will refuse
 *    to create one if it thinks the old one still exists)
 * 2. Fetch from origin to ensure we have the latest branch ref
 * 3. Re-create the worktree, checking out the existing branch
 * 4. Run the worktree setup command if configured
 *
 * @returns The worktree path, or null if recovery failed
 */
export async function recoverWorktree(
	repoPath: string,
	branchName: string,
	worktreePath: string,
	opts?: { setupCommand?: string },
): Promise<string | null> {
	if (!fs.existsSync(repoPath)) {
		console.warn(`[git] Cannot recover worktree: repoPath does not exist: ${repoPath}`);
		return null;
	}

	try {
		const dirExists = fs.existsSync(worktreePath);
		const gitFileExists = dirExists && fs.existsSync(path.join(worktreePath, ".git"));

		if (dirExists && gitFileExists) {
			// Directory and .git exist — try `git worktree repair` to fix any
			// path mismatches (e.g. worktree was moved or .git/worktrees entry is stale).
			try {
				await execFile("git", ["worktree", "repair"], { cwd: repoPath });
				console.log(`[git] Repaired worktree for branch "${branchName}" at ${worktreePath}`);
				return worktreePath;
			} catch {
				// repair failed — fall through to full recovery
			}
		}

		if (dirExists && !gitFileExists) {
			// Directory exists but .git metadata is gone (e.g. partial git worktree
			// remove on Windows, or worktree entry pruned while files remain).
			// Try to restore the .git pointer file and repair in-place — this avoids
			// having to delete the directory (which fails on Windows due to file locks
			// in node_modules/.bin, etc.).
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				// Admin entry exists — restore the .git pointer file
				const gitdirTarget = adminPath.split(path.sep).join("/");
				try {
					fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${gitdirTarget}\n`);
					// Update admin entry's gitdir to point back to this worktree
					fs.writeFileSync(path.join(adminPath, "gitdir"), worktreePath.split(path.sep).join("/") + "/.git\n");
					await execFile("git", ["worktree", "repair"], { cwd: repoPath });
					console.log(`[git] Restored .git pointer and repaired worktree for branch "${branchName}" at ${worktreePath}`);

					// Run setup command if configured
					if (!process.env.BOBBIT_SKIP_NPM_CI && opts?.setupCommand) {
						await setupWorktreeDeps(repoPath, worktreePath, opts.setupCommand);
					}
					return worktreePath;
				} catch (repairErr) {
					console.warn(`[git] Failed to repair worktree in-place for "${branchName}", falling back to recreate:`, repairErr);
					// Clean up the potentially bad .git file
					try { fs.rmSync(path.join(worktreePath, ".git"), { force: true }); } catch { /* best-effort */ }
					try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
				}
			}
		} else if (!dirExists) {
			// Directory doesn't exist — remove the stale admin entry if present.
			// Use targeted removal instead of blanket prune.
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}

		// Fetch to make sure we have the branch ref
		try {
			await execFile("git", ["fetch", "origin", branchName], {
				cwd: repoPath,
				timeout: 30_000,
			});
		} catch {
			// Fetch failure is non-fatal — branch may exist locally
		}

		// Check if the branch exists locally
		let branchExists = false;
		try {
			await execFile("git", ["rev-parse", "--verify", branchName], { cwd: repoPath });
			branchExists = true;
		} catch {
			// Try the remote tracking branch
			try {
				await execFile("git", ["rev-parse", "--verify", `origin/${branchName}`], { cwd: repoPath });
			} catch {
				console.warn(`[git] Cannot recover worktree: branch "${branchName}" not found locally or on remote`);
				return null;
			}
		}

		// If directory still exists with no .git (in-place repair failed or no admin entry),
		// remove it so git worktree add can recreate it.
		if (fs.existsSync(worktreePath) && !fs.existsSync(path.join(worktreePath, ".git"))) {
			try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
		}

		// If the directory still exists after rmSync (Windows file locks), we can't proceed
		if (fs.existsSync(worktreePath)) {
			console.warn(`[git] Cannot recover worktree: directory "${worktreePath}" exists and could not be removed (file locks?)`);
			return null;
		}

		// Create the worktree — use existing branch (no -b) or track from remote
		if (branchExists) {
			await execFile("git", ["worktree", "add", worktreePath, branchName], { cwd: repoPath });
		} else {
			// Create local branch tracking the remote
			await execFile("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`], { cwd: repoPath });
		}

		// Run setup command if configured
		if (!process.env.BOBBIT_SKIP_NPM_CI && opts?.setupCommand) {
			await setupWorktreeDeps(repoPath, worktreePath, opts.setupCommand);
		}

		console.log(`[git] Recovered worktree for branch "${branchName}" at ${worktreePath}`);
		return worktreePath;
	} catch (err) {
		console.error(`[git] Failed to recover worktree for branch "${branchName}":`, err);
		return null;
	}
}

/**
 * Locally merge a child goal's branch into the parent goal's branch.
 *
 * Implements the body of `goal_merge_child` (see
 * `docs/design/nested-goals.md` §3.3). Used by `GoalManager.mergeChild` when
 * a subgoal verify-step's child goal has reached `ready-to-merge` and the
 * parent's verification harness needs to integrate the child's commits.
 *
 * Steps:
 *   1. `git fetch origin <childBranch>` — bring the child branch ref up to
 *      date inside the parent's worktree.
 *   2. `git merge --no-ff origin/<childBranch>` — fast-forwards forbidden so
 *      the merge commit is always present (audit trail). Commit message is
 *      `Merge child <childBranch> into <parentBranch>` with a bobbit-ai
 *      co-author trailer.
 *   3. On clean merge: push parent.branch to origin (gated by
 *      `shouldSkipRemotePush()`). "No remote PR" semantics — the child
 *      branch itself is never pushed by this helper. Returns
 *      `{ merged: true, conflict: false, commitSha }`.
 *   4. On conflict: `git merge --abort`, return
 *      `{ merged: false, conflict: true, output }`. Do NOT auto-resolve —
 *      the parent's team-lead is responsible for resolving conflicts (or
 *      escalating to the user).
 *
 * Pre-conditions:
 *   - `parentWorktreePath` is the parent goal's worktree (where
 *     `parentBranch` is the currently checked-out branch). Caller
 *     responsible for ensuring this.
 *
 * @param parentWorktreePath Absolute path to parent goal's worktree.
 * @param parentBranch       Parent goal's branch name (must be checked out).
 * @param childBranch        Child goal's branch name (will be fetched).
 */
export async function mergeChildBranchLocal(
	parentWorktreePath: string,
	parentBranch: string,
	childBranch: string,
): Promise<{ merged: boolean; conflict: boolean; commitSha?: string; output: string }> {
	let output = "";
	const capture = (label: string, stdout: string, stderr: string): void => {
		const chunk = (stdout + (stdout && stderr ? "\n" : "") + stderr).trim();
		if (chunk) output += `[${label}]\n${chunk}\n`;
	};

	// 1. Fetch the child branch ref. Best-effort — if there is no `origin`
	//    remote (e.g. tests with BOBBIT_TEST_NO_PUSH=1 and a local-only repo)
	//    we fall back to the local ref.
	let childRef = `origin/${childBranch}`;
	try {
		const { stdout, stderr } = await execFile(
			"git",
			["fetch", "origin", childBranch],
			{ cwd: parentWorktreePath, timeout: 30_000 },
		);
		capture("fetch", stdout, stderr);
	} catch (err) {
		// No remote / unreachable / branch not on remote — try local ref.
		const msg = err instanceof Error ? err.message : String(err);
		capture("fetch (failed, falling back to local ref)", "", msg);
		try {
			await execFile("git", ["rev-parse", "--verify", childBranch], {
				cwd: parentWorktreePath,
			});
			childRef = childBranch;
		} catch {
			return { merged: false, conflict: false, output: output + `[error]\nchild branch "${childBranch}" not found locally or on origin\n` };
		}
	}

	// 2. Merge with --no-ff and a structured commit message + co-author.
	const commitMessage =
		`Merge child ${childBranch} into ${parentBranch}\n\n` +
		`Co-authored-by: bobbit-ai <bobbit@bobbit.ai>\n`;
	try {
		const { stdout, stderr } = await execFile(
			"git",
			["merge", "--no-ff", "-m", commitMessage, childRef],
			{ cwd: parentWorktreePath, timeout: 60_000 },
		);
		capture("merge", stdout, stderr);
	} catch (err) {
		const stdout = (err as { stdout?: string })?.stdout ?? "";
		const stderr = (err as { stderr?: string })?.stderr ?? "";
		capture("merge (failed)", stdout, stderr);

		// 4. Abort to leave the worktree clean. Best-effort.
		try {
			const { stdout: aOut, stderr: aErr } = await execFile(
				"git",
				["merge", "--abort"],
				{ cwd: parentWorktreePath, timeout: 15_000 },
			);
			capture("merge --abort", aOut, aErr);
		} catch (abortErr) {
			const aMsg = abortErr instanceof Error ? abortErr.message : String(abortErr);
			capture("merge --abort (failed)", "", aMsg);
		}
		return { merged: false, conflict: true, output };
	}

	// Capture the merge commit SHA.
	let commitSha: string | undefined;
	try {
		const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
			cwd: parentWorktreePath,
			timeout: 5_000,
		});
		commitSha = stdout.trim() || undefined;
	} catch {
		// best-effort
	}

	// 3. Push parent.branch to origin. "No remote PR" applies to the child;
	//    parent.branch is still pushed so CI / sibling subgoal verifications
	//    see the post-merge tip. Gated by shouldSkipRemotePush() exactly like
	//    every other push site.
	if (!shouldSkipRemotePush()) {
		try {
			const { stdout, stderr } = await execFile(
				"git",
				["push", "origin", parentBranch],
				{ cwd: parentWorktreePath, timeout: 30_000 },
			);
			capture("push", stdout, stderr);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			capture("push (failed, non-fatal)", "", msg);
			// Non-fatal: merge already happened locally. The next sibling
			// subgoal that branches off parent.branch HEAD will still see the
			// merge commit in the local worktree.
		}
	}

	return { merged: true, conflict: false, commitSha, output };
}
