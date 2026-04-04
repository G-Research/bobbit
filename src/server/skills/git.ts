import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { resolveShell } from "../agent/shell-util.js";

const execFile = promisify(execFileCb);

/** Read worktree_setup_command from project config (if set). Returns undefined if not configured. */
function readWorktreeSetupCommand(): string | undefined {
	try {
		const configFile = path.join(bobbitConfigDir(), "project.yaml");
		if (!fs.existsSync(configFile)) return undefined;
		const raw = yaml.parse(fs.readFileSync(configFile, "utf-8"));
		if (raw && typeof raw === "object" && typeof raw.worktree_setup_command === "string") {
			return raw.worktree_setup_command;
		}
	} catch { /* ignore */ }
	return undefined;
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
 * Fully async — the `git worktree add`, dependency setup, and `git push`
 * are all awaited without blocking the Node.js event loop.
 *
 * @param opts.setupCommand — worktree setup command from project config
 *   (`worktree_setup_command`). If provided, runs this shell command in the
 *   worktree directory. If empty string or undefined/not configured, skips
 *   setup entirely — no implicit npm/pip/cargo assumptions.
 * @param opts.startPoint — git ref to base the new branch on (default `"HEAD"`).
 *   Pass e.g. `origin/my-branch` to start from a remote tracking branch.
 */
export async function createWorktree(repoPath: string, branchName: string, opts?: { setupCommand?: string; startPoint?: string }): Promise<WorktreeResult> {
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
	await execFile("git", ["worktree", "add", "-b", branchName, worktreePath, opts?.startPoint ?? "HEAD"], {
		cwd: repoPath,
	});

	// Set up dependencies in the new worktree (only if configured).
	// Reads `worktree_setup_command` from project.yaml. If not set, does nothing.
	if (!process.env.BOBBIT_SKIP_NPM_CI) {
		const cmd = opts?.setupCommand !== undefined ? opts.setupCommand : (readWorktreeSetupCommand() ?? "");
		await setupWorktreeDeps(repoPath, worktreePath, cmd);
	}

	// Push the new branch and set upstream tracking so git-status can report ahead/behind
	// and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	try {
		await execFile("git", ["push", "-u", "origin", branchName], {
			cwd: worktreePath,
			timeout: 30_000, // 30s max for push
		});
	} catch {
		// Push may fail (no remote, auth issues, offline) — not fatal
	}

	return { worktreePath, branchName };
}

/**
 * Run the worktree setup command (from project config `worktree_setup_command`).
 * If the command is empty, does nothing. The command always runs via `sh -c`
 * (Git Bash on Windows) for cross-platform consistency — since git is a hard
 * prerequisite for Bobbit, Git Bash is always available.
 * The SOURCE_REPO env var is set to the original repo path.
 */
async function setupWorktreeDeps(repoPath: string, worktreePath: string, setupCommand: string): Promise<void> {
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
		// Prune stale worktree entries — git may still have a record of the old one
		await execFile("git", ["worktree", "prune"], { cwd: repoPath });

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

		// Create the worktree — use existing branch (no -b) or track from remote
		if (branchExists) {
			await execFile("git", ["worktree", "add", worktreePath, branchName], { cwd: repoPath });
		} else {
			// Create local branch tracking the remote
			await execFile("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`], { cwd: repoPath });
		}

		// Run setup command if configured
		if (!process.env.BOBBIT_SKIP_NPM_CI) {
			const cmd = opts?.setupCommand !== undefined ? opts.setupCommand : (readWorktreeSetupCommand() ?? "");
			await setupWorktreeDeps(repoPath, worktreePath, cmd);
		}

		console.log(`[git] Recovered worktree for branch "${branchName}" at ${worktreePath}`);
		return worktreePath;
	} catch (err) {
		console.error(`[git] Failed to recover worktree for branch "${branchName}":`, err);
		return null;
	}
}
