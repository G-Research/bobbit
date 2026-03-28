import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

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
 * Create a git worktree on a new branch from HEAD.
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — the `git worktree add`, dependency setup, and `git push`
 * are all awaited without blocking the Node.js event loop.
 *
 * @param setupCommand — custom worktree setup command from project config
 *   (`worktree_setup_command`). If provided, runs this instead of the default
 *   npm logic. If empty string, skips setup entirely. If undefined, uses the
 *   default: copy node_modules from the source repo, falling back to npm ci.
 */
export async function createWorktree(repoPath: string, branchName: string, setupCommand?: string): Promise<WorktreeResult> {
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

	// Set up dependencies in the new worktree.
	// Read project config for custom setup command if none was explicitly provided.
	if (!process.env.BOBBIT_SKIP_NPM_CI) {
		const cmd = setupCommand !== undefined ? setupCommand : readWorktreeSetupCommand();
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
 * Set up dependencies in a new worktree.
 *
 * If `setupCommand` is provided (from project config `worktree_setup_command`),
 * runs that shell command in the worktree directory.
 * If `setupCommand` is empty string, skips setup entirely.
 * If `setupCommand` is undefined, uses the default npm strategy:
 *   1. Copy node_modules from the source repo (fast — same branch, same deps)
 *   2. Run `npm ci` as a fallback if the copy fails or node_modules doesn't exist
 */
async function setupWorktreeDeps(repoPath: string, worktreePath: string, setupCommand?: string): Promise<void> {
	// Explicit custom command from project config
	if (setupCommand !== undefined) {
		if (setupCommand === "") return; // empty string = skip setup
		try {
			await execFile(process.platform === "win32" ? "cmd" : "sh",
				process.platform === "win32" ? ["/c", setupCommand] : ["-c", setupCommand],
				{
					cwd: worktreePath,
					timeout: 120_000,
					env: { ...process.env, SOURCE_REPO: repoPath },
				},
			);
		} catch (err) {
			console.warn(`[git] Custom worktree setup command failed (non-fatal):`, err);
		}
		return;
	}

	// Default npm strategy: copy node_modules, fallback to npm ci
	if (!fs.existsSync(path.join(worktreePath, "package-lock.json"))) return;

	const srcNodeModules = path.join(repoPath, "node_modules");
	const dstNodeModules = path.join(worktreePath, "node_modules");

	// Try copying node_modules from source repo first — much faster than npm ci.
	// Since the worktree starts at HEAD (same commit as source), dependencies match.
	// NOTE: Never use symlinks/junctions — worktree cleanup can follow the link
	// and destroy the source repo's node_modules.
	if (fs.existsSync(srcNodeModules)) {
		try {
			if (process.platform === "win32") {
				// robocopy is faster than fs.cp for large dirs; exit code 1 = files copied (success)
				const { status } = await new Promise<{ status: number }>((resolve) => {
					const proc = require("node:child_process").spawn(
						"robocopy", [srcNodeModules, dstNodeModules, "/E", "/MT:8", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"],
						{ stdio: "ignore" },
					);
					proc.on("close", (code: number) => resolve({ status: code ?? 1 }));
				});
				// robocopy: 0 = nothing copied, 1 = files copied, >=8 = error
				if (status >= 8) throw new Error(`robocopy failed with exit code ${status}`);
			} else {
				await fs.promises.cp(srcNodeModules, dstNodeModules, { recursive: true });
			}
			console.log(`[git] Copied node_modules to worktree (fast path)`);
			return; // Success — skip npm ci
		} catch (err) {
			console.warn(`[git] Failed to copy node_modules, falling back to npm ci:`, err);
			// Clean up partial copy before npm ci
			try { await fs.promises.rm(dstNodeModules, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}

	// Fallback: npm ci
	try {
		await execFile("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
			cwd: worktreePath,
			timeout: 120_000,
			...(process.platform === "win32" ? { shell: true } : {}),
		});
	} catch {
		// Non-fatal — agent can npm install manually
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
