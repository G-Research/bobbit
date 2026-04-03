/**
 * SandboxPool — Pre-warmed Docker containers with dedicated git worktrees.
 *
 * Each pool slot is a (container, worktree) pair:
 *   - The worktree is a git worktree checked out on master
 *   - The container has that worktree bind-mounted as /workspace
 *
 * On claim, the caller can request a branch checkout (for goals/members).
 * On release, the worktree resets to master and the slot returns to idle.
 *
 * This ensures every sandboxed session sees only its own /workspace —
 * no access to the primary project dir or other sessions' worktrees.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildDockerRunArgs } from "./docker-args.js";
import { resolveShell } from "./shell-util.js";

const execFileAsync = promisify(execFileCb);

// ── Types ──────────────────────────────────────────────────────────────────

type SlotState = "warming" | "idle" | "claimed";

interface PoolSlot {
	containerId: string;
	shortId: string;             // first 12 chars of containerId
	worktreePath: string;        // host path to this slot's worktree
	state: SlotState;
	sessions: Set<string>;       // session IDs using this slot
	branch: string;              // current branch (master when idle)
	createdAt: number;
	lastActivity: number;
}

export interface SandboxPoolOptions {
	poolSize: number;
	maxIdleSeconds: number;
	image: string;
	projectDir: string;          // primary project dir (repo root)
	repoPath: string;            // git repo root (may differ from projectDir)
	healthCheckIntervalMs: number;
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	sandboxNetwork?: string;
	worktreeSetupCommand?: string;
}

export interface ClaimResult {
	containerId: string;
	worktreePath: string;
}

export interface ClaimOptions {
	/** Create a new branch with this name */
	branch?: string;
	/** Base ref to branch from (default: HEAD on master) */
	from?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function poolHash(projectDir: string): string {
	return crypto.createHash("sha256").update(projectDir).digest("hex").substring(0, 12);
}

/** Git exec helper with timeout */
async function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
	return stdout.toString().trim();
}

/** Get the default branch name (master or main) */
async function getDefaultBranch(repoPath: string): Promise<string> {
	try {
		const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath);
		return ref.replace("refs/remotes/origin/", "");
	} catch {
		// Fallback: check if master exists
		try {
			await git(["rev-parse", "--verify", "master"], repoPath);
			return "master";
		} catch {
			return "main";
		}
	}
}

// ── SandboxPool ────────────────────────────────────────────────────────────

export class SandboxPool {
	private slots = new Map<string, PoolSlot>(); // keyed by containerId
	private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private _replenishing = false;
	private _shutdownRequested = false;
	readonly label: string;
	private _poolDir: string;    // host path to pool worktrees directory
	private _defaultBranch = "master";

	constructor(readonly options: SandboxPoolOptions) {
		this.label = poolHash(options.projectDir);
		this._poolDir = path.join(
			path.resolve(options.projectDir, "..", `${path.basename(options.projectDir)}-wt`),
			".sandbox-pool",
		);
	}

	/** Initialize the pool: clean up, re-adopt, pre-warm, start health checks. */
	async init(): Promise<void> {
		console.log(`[sandbox-pool] Initializing (size=${this.options.poolSize}, image=${this.options.image}, label=bobbit-sandbox=${this.label})`);

		// Detect default branch
		try {
			this._defaultBranch = await getDefaultBranch(this.options.repoPath);
		} catch {
			this._defaultBranch = "master";
		}

		// Ensure pool directory exists
		fs.mkdirSync(this._poolDir, { recursive: true });

		// Clean up stopped orphans from previous runs
		await this._cleanupStopped();

		// Re-adopt running containers from a previous gateway
		await this._readopt();

		// Start periodic health checks
		this._healthCheckTimer = setInterval(() => {
			this._healthCheck().catch(err => console.warn("[sandbox-pool] Health check error:", err));
		}, this.options.healthCheckIntervalMs);

		// Pre-warm to target size (background — don't block server startup)
		const idleCount = this._countByState("idle");
		const needed = Math.max(0, this.options.poolSize - idleCount);
		if (needed > 0) {
			console.log(`[sandbox-pool] Pre-warming ${needed} slot(s) in background...`);
			Promise.all(Array.from({ length: needed }, () => this._createSlot()))
				.then(() => console.log(`[sandbox-pool] Ready — ${this._statsString()}`))
				.catch(err => console.error("[sandbox-pool] Pre-warming failed:", err));
		} else {
			console.log(`[sandbox-pool] Ready — ${this._statsString()}`);
		}
	}

	/**
	 * Claim an idle slot. Optionally check out a branch.
	 * If no idle slots are available, creates one on-demand (slower but
	 * identical in behavior to a pre-warmed slot).
	 */
	async claim(sessionId: string, opts?: ClaimOptions): Promise<ClaimResult | null> {
		// Find an idle slot
		let slot: PoolSlot | undefined;
		for (const s of this.slots.values()) {
			if (s.state === "idle") { slot = s; break; }
		}
		if (!slot) {
			console.log(`[sandbox-pool] Pool exhausted — creating on-demand slot for session ${sessionId.slice(0, 8)}`);
			slot = await this._createSlot();
			if (!slot) return null;
		}

		slot.state = "claimed";
		slot.sessions.add(sessionId);
		slot.lastActivity = Date.now();

		// Checkout the requested branch
		if (opts?.branch) {
			try {
				await this._checkoutBranch(slot, opts.branch, opts.from);
			} catch (err) {
				console.error(`[sandbox-pool] Branch checkout failed for slot ${slot.shortId}:`, err);
				// Reset and return to idle — don't hand out a broken slot
				slot.sessions.delete(sessionId);
				await this._resetSlot(slot);
				return null;
			}
		} else {
			// Pull latest master for regular sessions
			try {
				await git(["pull", "--ff-only", "origin", this._defaultBranch], slot.worktreePath, 30_000);
			} catch {
				// Pull failure is non-fatal — slot is usable on current HEAD
			}
		}

		console.log(`[sandbox-pool] Claimed slot ${slot.shortId} for session ${sessionId.slice(0, 8)} (branch: ${slot.branch}) — ${this._statsString()}`);

		// Replenish in background
		this._replenish().catch(() => {});

		return { containerId: slot.containerId, worktreePath: slot.worktreePath };
	}

	/** Release a session from its slot. Resets worktree when all sessions are done. */
	async release(sessionId: string, containerId: string): Promise<void> {
		const slot = this.slots.get(containerId);
		if (!slot) return;

		slot.sessions.delete(sessionId);
		if (slot.sessions.size > 0) return; // other sessions still using this slot

		// Reset worktree and return to idle
		await this._resetSlot(slot);
		console.log(`[sandbox-pool] Released slot ${slot.shortId} — ${this._statsString()}`);
	}

	/** Get pool statistics. */
	getStats(): { enabled: boolean; total: number; idle: number; claimed: number; warming: number } {
		return {
			enabled: true,
			total: this.slots.size,
			idle: this._countByState("idle"),
			claimed: this._countByState("claimed"),
			warming: this._countByState("warming"),
		};
	}

	/** Graceful shutdown: drain sessions, stop containers. */
	async shutdown(): Promise<void> {
		this._shutdownRequested = true;
		this.dispose();

		// Wait briefly for claimed containers to drain
		const drainTimeout = 10_000;
		const start = Date.now();
		while (this._countByState("claimed") > 0 && Date.now() - start < drainTimeout) {
			await new Promise(r => setTimeout(r, 500));
		}

		// Stop all containers
		const stopPromises = [...this.slots.values()].map(async (slot) => {
			try {
				await execFileAsync("docker", ["stop", "-t", "5", slot.containerId], {
					timeout: 15_000,
					env: { ...process.env, MSYS_NO_PATHCONV: "1" },
				});
			} catch { /* container may already be stopped */ }
		});
		await Promise.allSettled(stopPromises);
		this.slots.clear();
	}

	/** Clear health check timer. */
	dispose(): void {
		if (this._healthCheckTimer) {
			clearInterval(this._healthCheckTimer);
			this._healthCheckTimer = null;
		}
	}

	// ── Slot lifecycle ─────────────────────────────────────────────────────

	/** Create a new pool slot: worktree + container. Returns the slot, or undefined on failure. */
	private async _createSlot(): Promise<PoolSlot | undefined> {
		if (this._shutdownRequested) return undefined;

		const slotId = crypto.randomUUID().slice(0, 8);
		const slotName = `pool-${slotId}`;
		const worktreePath = path.join(this._poolDir, slotName);

		try {
			// Clone the repo into the slot directory (not a worktree — avoids
			// absolute path issues in Docker containers where worktree .git
			// pointers don't resolve). Uses --local for speed (hard-links objects).
			await execFileAsync("git", [
				"clone", "--local", "--no-checkout",
				this.options.repoPath, worktreePath,
			], {
				timeout: 60_000,
				cwd: this.options.repoPath,
			});
			// Checkout the default branch
			await git(["checkout", this._defaultBranch], worktreePath, 30_000);

			// Fix origin URL: `git clone --local` sets origin to the local host path,
			// which is inaccessible from inside a Docker container. Replace it with the
			// real upstream remote URL so push/fetch/PR work identically to non-sandbox.
			try {
				const { stdout: realOrigin } = await execFileAsync(
					"git", ["remote", "get-url", "origin"],
					{ cwd: this.options.repoPath, timeout: 5_000 },
				);
				const upstreamUrl = realOrigin.trim();
				if (upstreamUrl && upstreamUrl !== this.options.repoPath) {
					await git(["remote", "set-url", "origin", upstreamUrl], worktreePath, 5_000);
				}
			} catch {
				// No upstream remote — local-only repo, push won't work but that's expected
			}

			// Run worktree setup command if configured
			if (this.options.worktreeSetupCommand) {
				try {
					const shell = resolveShell();
					await execFileAsync(shell, ["-c", this.options.worktreeSetupCommand], {
						cwd: worktreePath,
						timeout: 120_000,
						env: { ...process.env, SOURCE_REPO: this.options.repoPath },
					});
				} catch (setupErr) {
					console.warn(`[sandbox-pool] Worktree setup failed for ${slotName} (non-fatal):`, setupErr);
				}
			}

			// Create Docker container with this worktree mounted as /workspace
			const dockerArgs = this._buildDockerArgs(worktreePath);
			const { stdout } = await execFileAsync("docker", dockerArgs, {
				timeout: 30_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			});

			const containerId = stdout.trim();
			if (!containerId) {
				console.warn(`[sandbox-pool] docker run returned empty container ID for ${slotName}`);
				await this._removeWorktree(worktreePath);
				return undefined;
			}

			// Defense-in-depth: try to mask /proc/1/environ so even if env vars are
			// accidentally re-added to docker run, they can't be read by the agent.
			// This uses bind-mount of /dev/null (same technique Docker uses for masked
			// paths). Falls back to chmod, but procfs ignores chmod on most kernels.
			try {
				await execFileAsync("docker", [
					"exec", containerId, "sh", "-c",
					"mount --bind /dev/null /proc/1/environ 2>/dev/null || chmod 0400 /proc/1/environ 2>/dev/null || true",
				], {
					timeout: 5_000,
					env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
				});
			} catch {
				// Non-fatal — the primary defense is not passing sensitive env vars
				// to `docker run` (they go via `docker exec -e` instead).
			}

			const slot: PoolSlot = {
				containerId,
				shortId: containerId.substring(0, 12),
				worktreePath,
				state: "idle",
				sessions: new Set(),
				branch: this._defaultBranch,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			};
			this.slots.set(containerId, slot);
			console.log(`[sandbox-pool] Created slot ${slot.shortId} at ${slotName}`);
			return slot;
		} catch (err) {
			console.warn(`[sandbox-pool] Failed to create slot ${slotName}:`, err);
			// Clean up worktree if container creation failed
			await this._removeWorktree(worktreePath);
			return undefined;
		}
	}

	/** Build docker run args for a pool container with a specific worktree. */
	private _buildDockerArgs(worktreePath: string): string[] {
		return buildDockerRunArgs({
			image: this.options.image,
			workspaceDir: worktreePath,
			label: this.label,
			labelPrefix: "bobbit-sandbox",
			labelVersion: "2",
			worktreePath,
			sandboxMounts: this.options.sandboxMounts,
			sandboxCredentials: this.options.sandboxCredentials,
			sandboxNetwork: this.options.sandboxNetwork,
		});
	}

	/** Checkout a branch in a slot's worktree. */
	private async _checkoutBranch(slot: PoolSlot, branch: string, from?: string): Promise<void> {
		const wt = slot.worktreePath;

		// Fetch latest from origin
		await git(["fetch", "origin"], wt, 30_000);

		// Try to checkout the branch. It may already exist on the remote
		// (e.g. goal branches are created and pushed before team starts).
		try {
			if (from) {
				// Branch from a specific ref (e.g. origin/goal-branch for members)
				await git(["checkout", "-b", branch, from], wt, 15_000);
			} else {
				// Try creating a new branch from HEAD
				await git(["checkout", "-b", branch], wt, 15_000);
			}
		} catch {
			// Branch already exists — checkout the existing remote branch
			try {
				await git(["checkout", branch], wt, 15_000);
			} catch {
				// Branch exists locally but maybe diverged — force track remote
				await git(["checkout", "-B", branch, `origin/${branch}`], wt, 15_000);
			}
		}

		// Pull latest from remote (in case branch existed and has updates)
		try {
			await git(["pull", "--ff-only", "origin", branch], wt, 30_000);
		} catch {
			// Pull may fail if no upstream or diverged — non-fatal
		}

		slot.branch = branch;

		// Set upstream tracking (non-fatal)
		try {
			await git(["branch", "--set-upstream-to", `origin/${branch}`], wt, 10_000);
		} catch { /* may not exist on remote yet */ }

		// Push if this is a new branch (non-fatal)
		try {
			await git(["push", "-u", "origin", branch], wt, 30_000);
		} catch {
			// Push may fail — not fatal
		}
	}

	/** Reset a slot's clone back to the default branch and clean up. */
	private async _resetSlot(slot: PoolSlot): Promise<void> {
		const wt = slot.worktreePath;
		try {
			// Discard all changes and return to the default branch
			await git(["checkout", "--force", this._defaultBranch], wt, 15_000);
			await git(["clean", "-fdx"], wt, 30_000);
			await git(["fetch", "origin"], wt, 30_000);
			await git(["reset", "--hard", `origin/${this._defaultBranch}`], wt, 15_000);

			// Delete the branch that was checked out (clean up local refs)
			if (slot.branch && slot.branch !== this._defaultBranch) {
				try {
					await git(["branch", "-D", slot.branch], wt, 5_000);
				} catch { /* branch may not exist locally */ }
			}

			slot.branch = this._defaultBranch;
			slot.state = "idle";
			slot.lastActivity = Date.now();
		} catch (err) {
			console.warn(`[sandbox-pool] Failed to reset slot ${slot.shortId}, removing:`, err);
			await this._destroySlot(slot);
		}
	}

	/** Destroy a slot entirely (stop container, remove worktree). */
	private async _destroySlot(slot: PoolSlot): Promise<void> {
		this.slots.delete(slot.containerId);
		try {
			await execFileAsync("docker", ["rm", "-f", slot.containerId], {
				timeout: 15_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});
		} catch { /* already gone */ }
		await this._removeWorktree(slot.worktreePath);
	}

	/** Remove a pool slot's cloned repo from disk. */
	private async _removeWorktree(worktreePath: string): Promise<void> {
		try {
			fs.rmSync(worktreePath, { recursive: true, force: true });
		} catch { /* best effort */ }
	}

	// ── Pool maintenance ───────────────────────────────────────────────────

	/** Re-adopt containers from a previous gateway run, killing any we can't adopt. */
	private async _readopt(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "--filter", `label=bobbit-sandbox=${this.label}`,
				"--filter", "status=running",
				"--format", "{{.ID}}",
			], {
				timeout: 10_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});

			const containerIds = stdout.trim().split("\n").filter(Boolean);
			if (containerIds.length === 0) return;

			const orphaned: string[] = [];
			for (const containerId of containerIds) {
				if (this.slots.has(containerId)) continue;

				// Validate: check the worktree mount and label
				const valid = await this._validateSlot(containerId);
				if (valid) {
					console.log(`[sandbox-pool] Re-adopted container ${containerId.slice(0, 12)}`);
				} else {
					orphaned.push(containerId);
				}
			}

			// Kill containers we couldn't re-adopt (e.g. validation failed due to
			// path format mismatches, missing worktrees, or stale containers from
			// a previous run that was force-killed without graceful shutdown).
			if (orphaned.length > 0) {
				console.log(`[sandbox-pool] Removing ${orphaned.length} orphaned running container(s)...`);
				for (const id of orphaned) {
					try {
						await execFileAsync("docker", ["rm", "-f", id], {
							timeout: 10_000,
							env: { ...process.env, MSYS_NO_PATHCONV: "1" },
						});
						console.log(`[sandbox-pool] Removed orphaned container ${id.slice(0, 12)}`);
					} catch { /* already gone */ }
				}
			}
		} catch { /* no running containers */ }
	}

	/** Validate a container and add it as an idle slot. */
	private async _validateSlot(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect", containerId,
				"--format", '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
			], {
				timeout: 10_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});

			const mountSource = stdout.trim();
			if (!mountSource) return false;

			// The mount source should be under our pool directory.
			// On Windows, Docker inspect may return paths in various formats
			// (e.g. "C:\Users\..." vs "/c/Users/..." vs "C:/Users/..."),
			// so normalize both sides to lowercase forward-slash paths.
			const normalizedMount = mountSource.replace(/\\/g, "/").toLowerCase();
			const normalizedPoolDir = this._poolDir.replace(/\\/g, "/").toLowerCase();
			if (!normalizedMount.startsWith(normalizedPoolDir)) return false;

			// Resolve the actual host path for fs.existsSync — use the original
			// mount source but also try our pool dir prefix for Windows path mismatches.
			const worktreePath = fs.existsSync(mountSource)
				? mountSource
				: path.join(this._poolDir, mountSource.replace(/\\/g, "/").slice(this._poolDir.replace(/\\/g, "/").length));
			if (!fs.existsSync(worktreePath)) return false;

			const slot: PoolSlot = {
				containerId,
				shortId: containerId.substring(0, 12),
				worktreePath,
				state: "idle",
				sessions: new Set(),
				branch: this._defaultBranch,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			};
			this.slots.set(containerId, slot);
			return true;
		} catch {
			return false;
		}
	}

	/** Remove stopped containers from previous runs. */
	private async _cleanupStopped(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "-a",
				"--filter", `label=bobbit-sandbox=${this.label}`,
				"--filter", "status=exited",
				"--filter", "status=created",
				"--format", "{{.ID}}",
			], {
				timeout: 10_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});

			const ids = stdout.trim().split("\n").filter(Boolean);
			if (ids.length === 0) return;

			console.log(`[sandbox-pool] Removing ${ids.length} stopped container(s)...`);
			for (const id of ids) {
				try {
					await execFileAsync("docker", ["rm", "-f", id], {
						timeout: 10_000,
						env: { ...process.env, MSYS_NO_PATHCONV: "1" },
					});
				} catch { /* already gone */ }
			}
		} catch { /* ignore */ }
	}

	/** Fill pool back to target size. */
	private async _replenish(): Promise<void> {
		if (this._replenishing || this._shutdownRequested) return;
		this._replenishing = true;
		try {
			const needed = Math.max(0, this.options.poolSize - this._countByState("idle"));
			if (needed > 0) {
				console.log(`[sandbox-pool] Replenishing ${needed} slot(s)...`);
				await Promise.allSettled(Array.from({ length: needed }, () => this._createSlot()));
			}
		} finally {
			this._replenishing = false;
		}
	}

	/** Periodic health check: remove dead containers, cull excess idle. */
	private async _healthCheck(): Promise<void> {
		if (this._shutdownRequested) return;

		const ids = [...this.slots.keys()];
		if (ids.length === 0) return;

		// Batch inspect all containers
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect", "--format", "{{.Id}} {{.State.Running}}", ...ids,
			], {
				timeout: 15_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});

			const lines = stdout.trim().split("\n");
			for (const line of lines) {
				const [fullId, running] = line.split(" ");
				if (!fullId) continue;
				const slot = this.slots.get(fullId) || [...this.slots.values()].find(s => fullId.startsWith(s.containerId));
				if (slot && running !== "true") {
					console.warn(`[sandbox-pool] Container ${slot.shortId} is dead, removing slot`);
					await this._destroySlot(slot);
				}
			}
		} catch {
			// Inspect failure — individual containers may have been removed
		}

		// Cull excess idle slots
		this._cullExcessIdle();

		// Replenish if needed
		await this._replenish();
	}

	/** Remove excess idle slots past the max idle time. */
	private _cullExcessIdle(): void {
		const idleSlots = [...this.slots.values()]
			.filter(s => s.state === "idle")
			.sort((a, b) => a.lastActivity - b.lastActivity);

		const excess = idleSlots.length - this.options.poolSize;
		if (excess <= 0) return;

		const now = Date.now();
		const maxIdleMs = this.options.maxIdleSeconds * 1000;

		for (let i = 0; i < excess; i++) {
			const slot = idleSlots[i];
			if (now - slot.lastActivity > maxIdleMs) {
				console.log(`[sandbox-pool] Culling excess idle slot ${slot.shortId}`);
				this._destroySlot(slot).catch(() => {});
			}
		}
	}

	// ── Utilities ──────────────────────────────────────────────────────────

	private _countByState(state: SlotState): number {
		let count = 0;
		for (const s of this.slots.values()) {
			if (s.state === state) count++;
		}
		return count;
	}

	private _statsString(): string {
		return `idle=${this._countByState("idle")} claimed=${this._countByState("claimed")} warming=${this._countByState("warming")} total=${this.slots.size}`;
	}
}
