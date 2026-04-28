/**
 * Pre-creates git worktrees so new sessions / goals can claim one instantly
 * instead of waiting 10-30s for `git worktree add` + setup + `git push`.
 *
 * On startup, the pool fills to `targetSize` (default 2) in the background.
 * When a session or goal claims a worktree, the pool renames the branch,
 * moves the directory to its conventional path, and starts replenishing.
 *
 * If the pool is empty, callers fall back to the normal `createWorktree()` path.
 *
 * Phase 3 changes (multi-repo):
 *   - Pool branch naming changed from `session/_pool-<id>` → `pool/_pool-<id>`
 *     so the orphan-cleanup logic in session-manager (which scans
 *     `session/*` branches) doesn't trip on pool entries.
 *   - `claim()` uses `git worktree move` after the branch rename so the
 *     directory matches the new branch slug. On move failure (typically
 *     Windows file locks) we record a degraded entry and continue —
 *     the branch rename succeeded so the agent is fully usable.
 *   - The fetch + reset + push that used to block claim now run in the
 *     background after returning the worktree to the caller — claim is
 *     now O(1) git ops + a few hundred ms of disk move.
 *   - `setComponents()` is a no-op stub reserved for Phase 4 multi-repo
 *     pool sets.
 */

import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { createWorktree, cleanupWorktree, shouldSkipRemotePush, moveWorktree, createWorktreeSet, type WorktreeResult } from "../skills/git.js";
import type { Component } from "./project-config-store.js";

const execFile = promisify(execFileCb);

interface PoolEntry {
	branchName: string;       // e.g. "pool/_pool-<8hex>" — git ref after fill
	/** Back-compat alias for `worktrees[0].worktreePath` in single-repo mode. */
	worktreePath: string;
	/** Multi-repo: per-repo worktree entries. Absent for single-repo. */
	worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
	createdAt: number;
}

/** Result of a pool claim — extends the legacy WorktreeResult with degraded-mode info. */
export interface PoolClaimResult extends WorktreeResult {
	/**
	 * True when the branch was renamed but the directory could not be moved
	 * (typically Windows file locks on `git worktree move`). The worktree is
	 * fully usable; callers may choose to surface this to the UI.
	 */
	degraded?: boolean;
	/** Multi-repo: per-repo worktree entries. Absent for single-repo entries. */
	worktrees?: Array<{ repo: string; worktreePath: string }>;
	/** Multi-repo: the per-branch container directory (`<wtRoot>/<branchSlug>`). */
	container?: string;
}

/** Result of an unnamed claim — the pool entry handed to the caller as-is. */
export interface UnnamedClaim {
	/** The opaque pool ID embedded in branch + path (`_pool-<8hex>`). */
	poolId: string;
	/** Current branch name (`pool/_pool-<id>`). */
	branchName: string;
	/** Current worktree path (under `<repo>-wt/pool-_pool-<id>/`). */
	worktreePath: string;
}

/** Component descriptor reserved for Phase 4 multi-repo pool sets. */
export interface PoolComponent {
	name: string;
	repo: string;
	relativePath?: string;
	worktreeSetupCommand?: string;
}

const POOL_BRANCH_PREFIX = "pool/_pool-";
const LEGACY_POOL_BRANCH_PREFIX = "session/_pool-";

/** Whether a branch name belongs to a pool entry (current or legacy form). */
export function isPoolBranch(branch: string): boolean {
	return branch.startsWith(POOL_BRANCH_PREFIX) || branch.startsWith(LEGACY_POOL_BRANCH_PREFIX);
}

/** Flatten a branch name into a directory-safe slug (matches createWorktree's convention). */
function branchToSlug(branch: string): string {
	return branch.replace(/\//g, "-");
}

export class WorktreePool {
	private pool: PoolEntry[] = [];
	private filling = false;
	private repoPath: string;
	private targetSize: number;
	private setupCommand?: string;

	/** Components driving multi-repo fill. Undefined or single (repo===".") behaves as today. */
	private components?: Component[];

	constructor(opts: { repoPath: string; targetSize?: number; setupCommand?: string; components?: PoolComponent[] | Component[] }) {
		this.repoPath = opts.repoPath;
		this.targetSize = opts.targetSize ?? 2;
		this.setupCommand = opts.setupCommand;
		this.components = opts.components as Component[] | undefined;
	}

	/** Whether the pool's stored components imply multi-repo fill. */
	private isMultiRepo(): boolean {
		return !!this.components && this.components.some(c => c.repo !== ".");
	}

	/** Number of ready worktrees available. */
	get size(): number { return this.pool.length; }

	/** Target pool size. */
	get target(): number { return this.targetSize; }

	/** Whether the pool is currently filling. */
	get isFilling(): boolean { return this.filling; }

	/** Status snapshot for the API. */
	getStatus(): { enabled: boolean; ready: number; target: number; filling: boolean } {
		return {
			enabled: this.targetSize > 0,
			ready: this.pool.length,
			target: this.targetSize,
			filling: this.filling,
		};
	}

	/**
	 * Start filling the pool in the background. Call once after startup.
	 *
	 * @param activeWorktreePaths — Worktree paths currently owned by live sessions.
	 *   These are excluded from orphan reclamation to prevent the pool from stealing
	 *   a session's working directory on restart.
	 */
	startFilling(activeWorktreePaths?: Set<string>): void {
		this.reclaimOrphaned(activeWorktreePaths).then(() => this.replenish()).catch(() => this.replenish());
	}

	/**
	 * Update the setup command (e.g. when project config changes).
	 * Does NOT invalidate existing pool entries — they were built with the old command.
	 */
	setSetupCommand(cmd: string | undefined): void {
		this.setupCommand = cmd;
	}

	/**
	 * Replace the component set used for future pool fills. Existing entries
	 * stay in the pool until claimed; the next `_fill()` will use the new shape.
	 */
	setComponents(components: Component[] | PoolComponent[]): void {
		this.components = components as Component[];
	}

	/**
	 * Claim a pre-built worktree and rename it for a target branch.
	 *
	 * Steps performed synchronously (the caller awaits the rename):
	 *   1. `git branch -m pool/_pool-<id> <targetBranch>`
	 *   2. `git worktree move <oldPath> <newPath>` — degraded fallback if it fails
	 *
	 * Steps performed in the background (caller does NOT await):
	 *   3. `git fetch origin` + `git reset --hard <remote-primary>`
	 *   4. `git push -u origin <targetBranch>` (skipped under BOBBIT_TEST_NO_PUSH=1)
	 *
	 * Returns null if the pool is empty (caller falls back to createWorktree).
	 */
	async claim(targetBranch: string): Promise<PoolClaimResult | null> {
		const entry = this.pool.shift();
		if (!entry) return null;

		// Kick off background replenishment immediately
		this.replenish();

		// 1. Rename branch (fast — local ref op).
		try {
			await execFile("git", ["branch", "-m", entry.branchName, targetBranch], {
				cwd: entry.worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			console.error(`[worktree-pool] Branch rename failed (${entry.branchName} → ${targetBranch}):`, err);
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
			return null;
		}

		// 2. Move worktree directory to match the new branch slug. Degraded fallback
		//    on failure — the branch rename succeeded so the agent can still work;
		//    only the dir name is stale. The boot sweeper will reclaim it later.
		const targetSlug = branchToSlug(targetBranch);
		const wtRoot = path.dirname(entry.worktreePath);
		const newPath = path.join(wtRoot, targetSlug);
		let finalPath = entry.worktreePath;
		let degraded = false;
		if (newPath !== entry.worktreePath) {
			try {
				await moveWorktree(this.repoPath, entry.worktreePath, newPath);
				finalPath = newPath;
			} catch (err) {
				degraded = true;
				console.warn(`[worktree-pool] degraded: dir kept at ${entry.worktreePath} (move to ${newPath} failed: ${err instanceof Error ? err.message : err})`);
			}
		}

		// 3 + 4. Background freshen + push. Don't await — caller gets the worktree now.
		this.freshenInBackground(finalPath, targetBranch);

		console.log(`[worktree-pool] Claimed worktree: ${targetBranch} at ${finalPath}${degraded ? " (degraded)" : ""} (pool: ${this.pool.length}/${this.targetSize})`);
		const result: PoolClaimResult = { worktreePath: finalPath, branchName: targetBranch, degraded };
		if (entry.worktrees && entry.worktrees.length > 0) {
			// TODO Phase 4 follow-up: claim() does not yet rename per-repo
			// worktrees in parallel for multi-repo entries. Today the pool
			// fills single-repo only (see `_fill`). When multi-repo prebuild
			// lands, this block must `Promise.all(entry.worktrees.map(...))` the
			// rename + move per repo.
			result.worktrees = entry.worktrees.map(w => ({ repo: w.repo, worktreePath: w.worktreePath }));
			result.container = finalPath;
		}
		return result;
	}

	/**
	 * Take a pool entry as-is, without renaming branch or directory.
	 *
	 * Used by the session creation path: the session lives on the temporary
	 * `pool/_pool-<id>` branch until the user sends their first prompt, at
	 * which point session-manager calls a separate rename helper.
	 *
	 * Returns null if the pool is empty.
	 */
	claimUnnamed(): UnnamedClaim | null {
		const entry = this.pool.shift();
		if (!entry) return null;
		this.replenish();
		// Strip prefix to get the opaque pool id (`_pool-<8hex>`).
		// Strip the leading `pool/` (or legacy `session/`) ref-namespace, keeping the
		// `_pool-<8hex>` opaque id that callers thread through session metadata.
		const poolId = entry.branchName.startsWith("pool/")
			? entry.branchName.slice("pool/".length)
			: entry.branchName.startsWith("session/")
				? entry.branchName.slice("session/".length)
				: entry.branchName;
		console.log(`[worktree-pool] Claimed (unnamed): ${entry.branchName} at ${entry.worktreePath} (pool: ${this.pool.length}/${this.targetSize})`);
		return { poolId, branchName: entry.branchName, worktreePath: entry.worktreePath };
	}

	/** Resolve the remote primary branch (e.g. origin/master). */
	private async resolveRemotePrimary(): Promise<string> {
		try {
			const { stdout } = await execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: this.repoPath,
				timeout: 5_000,
			});
			const ref = stdout.trim().replace("refs/remotes/", "");
			if (ref) return ref;
		} catch {
			// Fall back if origin/HEAD is not set
		}
		return "origin/master";
	}

	/**
	 * Background freshen: fetch origin + reset --hard <primary> + push -u.
	 * Errors are non-fatal and logged — the worktree is still usable.
	 */
	private freshenInBackground(worktreePath: string, branch: string): void {
		(async () => {
			try {
				await execFile("git", ["fetch", "origin"], { cwd: worktreePath, timeout: 30_000 });
				const remotePrimary = await this.resolveRemotePrimary();
				await execFile("git", ["reset", "--hard", remotePrimary], { cwd: worktreePath, timeout: 10_000 });
			} catch (err) {
				console.warn(`[worktree-pool] Background reset failed for ${branch}:`, err instanceof Error ? err.message : err);
			}
			if (!shouldSkipRemotePush()) {
				try {
					await execFile("git", ["push", "-u", "origin", branch], { cwd: worktreePath, timeout: 30_000 });
				} catch {
					// Push failure is non-fatal (offline, auth issues, etc.)
				}
			}
		})().catch(() => { /* swallow — already logged */ });
	}

	/**
	 * Scan for orphaned pool worktrees from a previous server instance and reclaim them.
	 * An orphaned pool worktree is a directory under `<repo>-wt/` whose branch is still
	 * a pool branch (i.e. it was never claimed by a session/goal).
	 *
	 * Accepts both the new `pool/_pool-*` and legacy `session/_pool-*` prefixes.
	 *
	 * @param activeWorktreePaths — Paths owned by live sessions; skip these even if
	 *   the branch name looks like a pool branch (the session may not have renamed it
	 *   yet, or recovery may have restored the original pool branch name).
	 */
	private async reclaimOrphaned(activeWorktreePaths?: Set<string>): Promise<void> {
		try {
			const wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`);
			if (!fs.existsSync(wtRoot)) return;

			const entries = fs.readdirSync(wtRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (this.pool.length >= this.targetSize) break;
				if (!entry.isDirectory()) continue;
				// Match new (`pool-_pool-*`) and legacy (`session-_pool-*`) flattened slugs.
				if (!entry.name.startsWith("pool-_pool-") && !entry.name.startsWith("session-_pool-")) continue;

				const wtPath = path.join(wtRoot, entry.name);
				if (activeWorktreePaths?.has(wtPath)) continue;

				const gitFile = path.join(wtPath, ".git");
				if (!fs.existsSync(gitFile)) continue;

				try {
					const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
						cwd: wtPath,
						timeout: 5_000,
					});
					const branch = stdout.trim();
					if (!isPoolBranch(branch)) continue;

					this.pool.push({ branchName: branch, worktreePath: wtPath, createdAt: Date.now() });
					console.log(`[worktree-pool] Reclaimed orphaned: ${branch} at ${wtPath} (pool: ${this.pool.length}/${this.targetSize})`);
				} catch {
					continue;
				}
			}
		} catch (err) {
			console.warn("[worktree-pool] Orphan reclaim scan failed:", err);
		}
	}

	/** Fill pool up to targetSize in the background. */
	private replenish(): void {
		if (this.filling || this.pool.length >= this.targetSize) return;
		this.filling = true;
		this._fill().catch((err) => {
			console.error("[worktree-pool] Fill error:", err);
		}).finally(() => {
			this.filling = false;
		});
	}

	private async _fill(): Promise<void> {
		while (this.pool.length < this.targetSize) {
			const uuid8 = randomUUID().slice(0, 8);
			const branchName = `${POOL_BRANCH_PREFIX}${uuid8}`;
			try {
				if (this.isMultiRepo() && this.components) {
					// Multi-repo prebuild via createWorktreeSet — entry carries per-repo paths.
					const set = await createWorktreeSet(this.repoPath, this.components, branchName);
					this.pool.push({
						branchName,
						worktreePath: set.container,
						worktrees: set.worktrees,
						createdAt: Date.now(),
					});
					console.log(`[worktree-pool] Ready (multi-repo): ${branchName} (pool: ${this.pool.length}/${this.targetSize})`);
					continue;
				}
				const result = await createWorktree(this.repoPath, branchName, {
					setupCommand: this.setupCommand,
					skipPush: true,
				});
				this.pool.push({
					branchName: result.branchName,
					worktreePath: result.worktreePath,
					createdAt: Date.now(),
				});
				console.log(`[worktree-pool] Ready: ${branchName} (pool: ${this.pool.length}/${this.targetSize})`);
			} catch (err) {
				console.error(`[worktree-pool] Failed to pre-build ${branchName}:`, err);
				break;
			}
		}
	}

	/** Push a pre-existing pool entry into the in-memory pool. Used by the boot sweeper. */
	registerExternalEntry(branchName: string, worktreePath: string): void {
		if (!isPoolBranch(branchName)) return;
		// Avoid duplicates
		if (this.pool.some(e => e.worktreePath === worktreePath)) return;
		this.pool.push({ branchName, worktreePath, createdAt: Date.now() });
	}

	/** Clean up all pool entries. Call on shutdown. */
	async drain(): Promise<void> {
		const entries = this.pool.splice(0);
		if (entries.length === 0) return;
		await Promise.allSettled(
			entries.map(e => cleanupWorktree(this.repoPath, e.worktreePath, e.branchName, true)),
		);
		console.log(`[worktree-pool] Drained ${entries.length} pre-built worktree(s)`);
	}
}
