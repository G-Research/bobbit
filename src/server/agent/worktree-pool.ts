/**
 * Pre-creates git worktrees so new sessions can claim one instantly
 * instead of waiting 10-30s for `git worktree add` + `npm ci` + `git push`.
 *
 * On startup, the pool fills to `targetSize` (default 2) in the background.
 * When a session claims a worktree, the pool renames the branch/directory
 * and starts replenishing immediately.
 *
 * If the pool is empty, callers fall back to the normal `createWorktree()` path.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree, cleanupWorktree, type WorktreeResult } from "../skills/git.js";

const execFile = promisify(execFileCb);

interface PoolEntry {
	branchName: string;
	worktreePath: string;
	createdAt: number;
}

export class WorktreePool {
	private pool: PoolEntry[] = [];
	private filling = false;
	private repoPath: string;
	private targetSize: number;
	private setupCommand?: string;

	constructor(opts: { repoPath: string; targetSize?: number; setupCommand?: string }) {
		this.repoPath = opts.repoPath;
		this.targetSize = opts.targetSize ?? 2;
		this.setupCommand = opts.setupCommand;
	}

	/** Number of ready worktrees available. */
	get size(): number { return this.pool.length; }

	/** Start filling the pool in the background. Call once after startup. */
	startFilling(): void {
		this.replenish();
	}

	/**
	 * Update the setup command (e.g. when project config changes).
	 * Does NOT invalidate existing pool entries — they were built with the old command.
	 */
	setSetupCommand(cmd: string | undefined): void {
		this.setupCommand = cmd;
	}

	/**
	 * Claim a pre-built worktree for a session.
	 *
	 * Renames the temporary branch to `targetBranch`, moves the directory
	 * to the conventional path, and pushes the branch to origin.
	 *
	 * Returns null if the pool is empty (caller should fall back to createWorktree).
	 */
	async claim(targetBranch: string): Promise<WorktreeResult | null> {
		const entry = this.pool.shift();
		if (!entry) return null;

		// Kick off background replenishment immediately
		this.replenish();

		// 1. Rename the git branch
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

		// 2. Move the directory to match the branch-name convention
		const wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`);
		const safeName = targetBranch.replace(/\//g, "-");
		const newPath = path.join(wtRoot, safeName);
		let finalPath = entry.worktreePath;

		if (newPath !== entry.worktreePath) {
			try {
				fs.renameSync(entry.worktreePath, newPath);
				finalPath = newPath;
			} catch (err) {
				// Directory rename failed — worktree still works at old path
				console.warn(`[worktree-pool] Directory rename failed, using original path:`, err);
			}

			// If directory was moved, tell git about the new location
			if (finalPath === newPath) {
				try {
					await execFile("git", ["worktree", "repair"], {
						cwd: this.repoPath,
						timeout: 10_000,
					});
				} catch (err) {
					// repair failure is non-fatal — git may still find it
					console.warn(`[worktree-pool] git worktree repair failed (non-fatal):`, err);
				}
			}
		}

		// 3. Push the renamed branch to origin (fire-and-forget, non-blocking)
		execFile("git", ["push", "-u", "origin", targetBranch], {
			cwd: finalPath,
			timeout: 30_000,
		}).catch(() => {
			// Push failure is non-fatal (offline, auth issues, etc.)
		});

		console.log(`[worktree-pool] Claimed worktree: ${targetBranch} at ${finalPath} (pool: ${this.pool.length}/${this.targetSize})`);
		return { worktreePath: finalPath, branchName: targetBranch };
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
			const branchName = `session/_pool-${uuid8}`;
			try {
				const result = await createWorktree(this.repoPath, branchName, {
					setupCommand: this.setupCommand,
					skipPush: true, // don't push pool branches — waste of time
				});
				this.pool.push({
					branchName: result.branchName,
					worktreePath: result.worktreePath,
					createdAt: Date.now(),
				});
				console.log(`[worktree-pool] Ready: ${branchName} (pool: ${this.pool.length}/${this.targetSize})`);
			} catch (err) {
				console.error(`[worktree-pool] Failed to pre-build ${branchName}:`, err);
				break; // Don't loop on persistent errors
			}
		}
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
