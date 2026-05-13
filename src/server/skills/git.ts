import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
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

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from a given start-point (default HEAD).
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — the `git worktree add` and `git push` are all awaited
 * without blocking the Node.js event loop.
 *
 * Per-component worktree setup is the responsibility of the caller —
 * invoke `runComponentSetups()` from `worktree-setup.ts` after this
 * function returns. `components[*].worktreeSetupCommand` is the single
 * source of truth.
 *
 * @param opts.startPoint — git ref to base the new branch on (default `"HEAD"`).
 *   Pass e.g. `origin/my-branch` to start from a remote tracking branch.
 */
export async function createWorktree(repoPath: string, branchName: string, opts?: { startPoint?: string; skipPush?: boolean; worktreeRoot?: string }): Promise<WorktreeResult> {
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
	// Per-component worktree setup is the caller's responsibility — invoke
	// `runComponentSetups()` after this function returns.
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

	// Pre-cleanup hooks (e.g. LSP supervisor releases child fds) — best-effort.
	try {
		const { runWorktreePreCleanupHooks } = await import("../lsp/cleanup-hook.js");
		await runWorktreePreCleanupHooks(worktreePath);
	} catch { /* ignore */ }

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
 *
 * Per-component setup is the caller's responsibility — invoke
 * `runComponentSetups()` after this function returns.
 *
 * @returns The worktree path, or null if recovery failed
 */
export async function recoverWorktree(
	repoPath: string,
	branchName: string,
	worktreePath: string,
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

		console.log(`[git] Recovered worktree for branch "${branchName}" at ${worktreePath}`);
		return worktreePath;
	} catch (err) {
		console.error(`[git] Failed to recover worktree for branch "${branchName}":`, err);
		return null;
	}
}
