import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFile = promisify(execFileCb);

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from HEAD.
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — the `git worktree add`, `npm ci`, and `git push`
 * are all awaited without blocking the Node.js event loop.
 */
export async function createWorktree(repoPath: string, branchName: string): Promise<WorktreeResult> {
	// Validate repoPath exists — execFile with a bad cwd throws a misleading
	// "spawn git ENOENT" that looks like git isn't installed
	if (!fs.existsSync(repoPath)) {
		throw new Error(`Cannot create worktree: repoPath does not exist: ${repoPath}`);
	}

	// Place all worktrees under a single sibling directory: <repo>-wt/
	const wtRoot = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`);
	// branchName may contain slashes (e.g. "goal/slug-id"), flatten to a safe dirname
	const safeName = branchName.replace(/\//g, "-");
	const worktreePath = path.join(wtRoot, safeName);

	// Create branch and worktree in one step (async, no shell, prevents injection)
	await execFile("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
		cwd: repoPath,
	});

	// Seed node_modules into the worktree so npm scripts (tsc, tests) work
	// immediately without a separate `npm install`. Uses `npm ci` with the
	// local cache — safe (independent copy, can't corrupt source repo) and
	// fast when the npm cache is warm (seconds, not minutes).
	// NOTE: Never use symlinks/junctions for node_modules — worktree cleanup
	// can follow the link and destroy the source repo's node_modules.
	// Skip via BOBBIT_SKIP_NPM_CI=1 in E2E tests where npm ci is slow and unnecessary.
	if (!process.env.BOBBIT_SKIP_NPM_CI && fs.existsSync(path.join(worktreePath, "package-lock.json"))) {
		try {
			await execFile("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
				cwd: worktreePath,
				timeout: 120_000, // 2 min max
				...(process.platform === "win32" ? { shell: true } : {}),
			});
		} catch {
			// Non-fatal — agent can npm install manually
		}
	}

	// Push the new branch and set upstream tracking so git-status can report ahead/behind
	// and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	try {
		await execFile("git", ["push", "-u", "origin", branchName], {
			cwd: worktreePath,
		});
	} catch {
		// Push may fail (no remote, auth issues, offline) — not fatal
	}

	return { worktreePath, branchName };
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
		// If remove fails, try prune
		try {
			await execFile("git", ["worktree", "prune"], { cwd: repoPath });
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
	}
}
