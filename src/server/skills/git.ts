import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { resolveShell } from "../agent/shell-util.js";

const execFile = promisify(execFileCb);

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
export async function createWorktree(repoPath: string, branchName: string, opts?: { setupCommand?: string; startPoint?: string; skipPush?: boolean }): Promise<WorktreeResult> {
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

	// Set up dependencies in the new worktree (only if configured).
	// Reads `worktree_setup_command` from project.yaml. If not set, does nothing.
	if (!process.env.BOBBIT_SKIP_NPM_CI) {
		const cmd = opts?.setupCommand !== undefined ? opts.setupCommand : (readWorktreeSetupCommand() ?? "");
		await setupWorktreeDeps(repoPath, worktreePath, cmd);
	}

	// Push the new branch and set upstream tracking so git-status can report ahead/behind
	// and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	if (!opts?.skipPush) {
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
					if (!process.env.BOBBIT_SKIP_NPM_CI) {
						const cmd = opts?.setupCommand !== undefined ? opts.setupCommand : (readWorktreeSetupCommand() ?? "");
						await setupWorktreeDeps(repoPath, worktreePath, cmd);
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
