/**
 * SandboxPool — Pre-warmed Docker containers with dedicated git clones.
 *
 * Each pool slot is a (container, clone) pair:
 *   - The clone is a local git clone checked out on the default branch
 *   - The container has that clone bind-mounted as /workspace
 *
 * On claim, the caller can request a branch checkout (for goals/members).
 * On release, the slot is destroyed (container killed, clone deleted).
 *
 * Design: slots are cheap to create (~3-5s — git clone --local + docker create).
 * The worktree setup command is skipped for pool slots because the container
 * entrypoint handles cross-platform dependency installation via its own cache.
 * This keeps the pool simple: no readoption, no idle culling, no health checks
 * trying to keep long-lived containers alive. Fresh containers on every cycle
 * eliminates the entire class of "dead container handed out" race conditions.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildDockerRunArgs } from "./docker-args.js";

const execFileAsync = promisify(execFileCb);

// ── Types ──────────────────────────────────────────────────────────────────

type SlotState = "warming" | "idle" | "claimed";

interface PoolSlot {
	containerId: string;
	shortId: string;             // first 12 chars of containerId
	worktreePath: string;        // host path to this slot's clone directory
	state: SlotState;
	sessions: Set<string>;       // session IDs using this slot
	branch: string;              // current branch (default branch when idle)
}

export interface SandboxPoolOptions {
	poolSize: number;
	maxIdleSeconds: number;      // kept for API compat — unused in simplified pool
	image: string;
	projectDir: string;          // primary project dir (repo root)
	repoPath: string;            // git repo root (may differ from projectDir)
	healthCheckIntervalMs: number; // kept for API compat — unused in simplified pool
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	sandboxNetwork?: string;
	worktreeSetupCommand?: string; // kept for API compat — intentionally not run for pool slots
}

export interface ClaimResult {
	containerId: string;
	worktreePath: string;
}

export interface ClaimOptions {
	/** Create a new branch with this name */
	branch?: string;
	/** Base ref to branch from (default: HEAD on default branch) */
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
	private _shutdownRequested = false;
	private _replenishing = false;
	readonly label: string;
	private _poolDir: string;    // host path to pool clone directories
	private _defaultBranch = "master";

	constructor(readonly options: SandboxPoolOptions) {
		this.label = poolHash(options.projectDir);
		this._poolDir = path.join(
			path.resolve(options.projectDir, "..", `${path.basename(options.projectDir)}-wt`),
			".sandbox-pool",
		);
	}

	/** Initialize the pool: kill old containers, pre-warm fresh ones. */
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

		// Kill ALL containers from previous runs — no readoption. Fresh slots are
		// cheap (~3-5s) and eliminate stale-container bugs entirely.
		await this._killAllPreviousContainers();

		// Clean up stale clone directories on disk (background — can be slow on Windows
		// with hundreds of deep node_modules trees, don't block server startup)
		this._cleanupStaleCloneDirs();

		// Pre-warm to target size (background — don't block server startup)
		console.log(`[sandbox-pool] Pre-warming ${this.options.poolSize} slot(s) in background...`);
		Promise.all(Array.from({ length: this.options.poolSize }, () => this._createSlot()))
			.then(() => console.log(`[sandbox-pool] Ready — ${this._statsString()}`))
			.catch(err => console.error("[sandbox-pool] Pre-warming failed:", err));
	}

	/**
	 * Claim an idle slot. Optionally check out a branch.
	 * If no idle slots are available, creates one on-demand.
	 * Validates the container is alive before handing it out.
	 */
	async claim(sessionId: string, opts?: ClaimOptions): Promise<ClaimResult | null> {
		// Find an idle slot, verifying the container is actually alive.
		// Dead containers are evicted and we retry with the next idle slot.
		let slot: PoolSlot | undefined;
		const maxRetries = 3;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			slot = undefined;
			for (const s of this.slots.values()) {
				if (s.state === "idle") { slot = s; break; }
			}
			if (!slot) break; // no idle slots left — fall through to on-demand creation

			// Liveness probe: verify the container is still running
			if (!(await this._isContainerAlive(slot))) {
				console.warn(`[sandbox-pool] Idle slot ${slot.shortId} has a dead container — evicting and retrying`);
				await this._destroySlot(slot);
				slot = undefined;
				continue;
			}
			break; // slot is alive
		}

		if (!slot) {
			console.log(`[sandbox-pool] Pool exhausted — creating on-demand slot for session ${sessionId.slice(0, 8)}`);
			slot = await this._createSlot();
			if (!slot) return null;
		}

		slot.state = "claimed";
		slot.sessions.add(sessionId);

		// Checkout the requested branch
		if (opts?.branch) {
			try {
				await this._checkoutBranch(slot, opts.branch, opts.from);
			} catch (err) {
				console.error(`[sandbox-pool] Branch checkout failed for slot ${slot.shortId}:`, err);
				// Destroy broken slot — don't try to reset, just kill it
				slot.sessions.delete(sessionId);
				await this._destroySlot(slot);
				return null;
			}
		} else {
			// Pull latest default branch for regular sessions
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

	/** Release a session from its slot. Destroys the slot when all sessions are done. */
	async release(sessionId: string, containerId: string): Promise<void> {
		const slot = this.slots.get(containerId);
		if (!slot) return;

		slot.sessions.delete(sessionId);
		if (slot.sessions.size > 0) return; // other sessions still using this slot

		// Destroy the slot — fresh containers on every cycle
		await this._destroySlot(slot);
		console.log(`[sandbox-pool] Released and destroyed slot ${containerId.slice(0, 12)} — ${this._statsString()}`);

		// Replenish in background
		this._replenish().catch(() => {});
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

	/** Graceful shutdown: drain sessions, stop containers, clean up directories. */
	async shutdown(): Promise<void> {
		this._shutdownRequested = true;

		// Wait briefly for claimed containers to drain
		const drainTimeout = 10_000;
		const start = Date.now();
		while (this._countByState("claimed") > 0 && Date.now() - start < drainTimeout) {
			await new Promise(r => setTimeout(r, 500));
		}

		// Destroy all slots (kill container + remove directory)
		const destroyPromises = [...this.slots.values()].map(slot => this._destroySlot(slot));
		await Promise.allSettled(destroyPromises);
		this.slots.clear();
	}

	/** No-op — kept for API compatibility. Simplified pool has no timers. */
	dispose(): void {
		// Nothing to dispose — simplified pool has no periodic timers
	}

	// ── Slot lifecycle ─────────────────────────────────────────────────────

	/** Create a new pool slot: clone repo + create container. Returns the slot, or undefined on failure. */
	private async _createSlot(): Promise<PoolSlot | undefined> {
		if (this._shutdownRequested) return undefined;

		const slotId = crypto.randomUUID().slice(0, 8);
		const slotName = `pool-${slotId}`;
		const worktreePath = path.join(this._poolDir, slotName);

		try {
			// Clone the repo into the slot directory (not a git worktree — avoids
			// absolute path issues in Docker where .git pointers don't resolve).
			// Uses --local for speed (hard-links objects).
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
			// real upstream remote URL so push/fetch/PR work inside the container.
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

			// NOTE: worktreeSetupCommand is intentionally NOT run for pool slots.
			// The container entrypoint (bobbit-entrypoint.sh) handles cross-platform
			// dependency installation with its own cache. Running npm ci on the host
			// would install host-platform (e.g. Windows) native modules that the Linux
			// container replaces anyway — wasted work.

			// Create Docker container with this clone mounted as /workspace
			const dockerArgs = this._buildDockerArgs(worktreePath);
			const { stdout } = await execFileAsync("docker", dockerArgs, {
				timeout: 30_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			});

			const containerId = stdout.trim();
			if (!containerId) {
				console.warn(`[sandbox-pool] docker run returned empty container ID for ${slotName}`);
				await this._removeCloneDir(worktreePath);
				return undefined;
			}

			// Defense-in-depth: mask /proc/1/environ so env vars can't be read by the agent
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
			};
			this.slots.set(containerId, slot);
			console.log(`[sandbox-pool] Created slot ${slot.shortId} at ${slotName}`);
			return slot;
		} catch (err) {
			console.warn(`[sandbox-pool] Failed to create slot ${slotName}:`, err);
			await this._removeCloneDir(worktreePath);
			return undefined;
		}
	}

	/** Build docker run args for a pool container. */
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

	/** Checkout a branch in a slot's clone. */
	private async _checkoutBranch(slot: PoolSlot, branch: string, from?: string): Promise<void> {
		const wt = slot.worktreePath;

		// Fetch latest from origin
		await git(["fetch", "origin"], wt, 30_000);

		// Try to checkout the branch — may already exist on the remote
		try {
			if (from) {
				await git(["checkout", "-b", branch, from], wt, 15_000);
			} else {
				await git(["checkout", "-b", branch], wt, 15_000);
			}
		} catch {
			// Branch already exists — checkout the existing remote branch
			try {
				await git(["checkout", branch], wt, 15_000);
			} catch {
				await git(["checkout", "-B", branch, `origin/${branch}`], wt, 15_000);
			}
		}

		// Pull latest from remote
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
		} catch { /* push may fail — not fatal */ }
	}

	/** Quick liveness probe — returns true if the container is running. */
	private async _isContainerAlive(slot: PoolSlot): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect", "--format", "{{.State.Running}}", slot.containerId,
			], {
				timeout: 5_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});
			return stdout.trim() === "true";
		} catch {
			return false; // container doesn't exist or inspect failed
		}
	}

	/** Destroy a slot entirely (kill container, remove clone directory). */
	private async _destroySlot(slot: PoolSlot): Promise<void> {
		this.slots.delete(slot.containerId);
		try {
			await execFileAsync("docker", ["rm", "-f", slot.containerId], {
				timeout: 15_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});
		} catch { /* already gone */ }
		await this._removeCloneDir(slot.worktreePath);
	}

	/** Remove a pool slot's cloned repo from disk. Retries on Windows lock failures. */
	private async _removeCloneDir(clonePath: string): Promise<void> {
		const maxAttempts = 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await fs.promises.rm(clonePath, { recursive: true, force: true });
				return;
			} catch (err: any) {
				// EBUSY/EPERM/ENOTEMPTY are common on Windows (locked files, antivirus)
				if (attempt < maxAttempts && (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "ENOTEMPTY")) {
					await new Promise(r => setTimeout(r, 500 * attempt));
					continue;
				}
				console.warn(`[sandbox-pool] Failed to remove ${path.basename(clonePath)} after ${attempt} attempt(s): ${err?.code || err}`);
			}
		}
	}

	// ── Pool maintenance ───────────────────────────────────────────────────

	/** Kill all containers from previous gateway runs. No readoption — start fresh. */
	private async _killAllPreviousContainers(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "-a",
				"--filter", `label=bobbit-sandbox=${this.label}`,
				"--format", "{{.ID}}",
			], {
				timeout: 10_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			});

			const ids = stdout.trim().split("\n").filter(Boolean);
			if (ids.length === 0) return;

			console.log(`[sandbox-pool] Removing ${ids.length} container(s) from previous run...`);
			await Promise.allSettled(ids.map(id =>
				execFileAsync("docker", ["rm", "-f", id], {
					timeout: 10_000,
					env: { ...process.env, MSYS_NO_PATHCONV: "1" },
				}).catch(() => {}),
			));
		} catch { /* no containers */ }
	}

	/** Remove stale clone directories that have no matching container (async, non-blocking). */
	private _cleanupStaleCloneDirs(): void {
		try {
			if (!fs.existsSync(this._poolDir)) return;
			const entries = fs.readdirSync(this._poolDir)
				.filter(e => e.startsWith("pool-"));
			if (entries.length === 0) return;
			console.log(`[sandbox-pool] Cleaning up ${entries.length} stale clone dir(s) in background...`);
			// Delete sequentially via async chain to avoid blocking the event loop.
			// Each rm is awaited individually so Node can interleave other work.
			(async () => {
				let removed = 0;
				for (const entry of entries) {
					try {
						await fs.promises.rm(path.join(this._poolDir, entry), { recursive: true, force: true });
						removed++;
					} catch { /* best effort */ }
				}
				console.log(`[sandbox-pool] Cleaned up ${removed}/${entries.length} stale clone dir(s)`);
			})().catch(() => {});
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
