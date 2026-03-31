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
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { toDockerPath, resolveAgentModulesDir } from "./rpc-bridge.js";
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
	gatewayUrl: string;
	gatewayToken: string;
	sandboxProxyPort?: number;
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

		// Pre-warm to target size
		const idleCount = this._countByState("idle");
		const needed = Math.max(0, this.options.poolSize - idleCount);
		if (needed > 0) {
			console.log(`[sandbox-pool] Pre-warming ${needed} slot(s)...`);
			await Promise.all(Array.from({ length: needed }, () => this._createSlot()));
		}

		// Start periodic health checks
		this._healthCheckTimer = setInterval(() => {
			this._healthCheck().catch(err => console.warn("[sandbox-pool] Health check error:", err));
		}, this.options.healthCheckIntervalMs);

		console.log(`[sandbox-pool] Ready — ${this._statsString()}`);
	}

	/**
	 * Claim an idle slot. Optionally check out a branch.
	 * Returns null if no idle slots available (caller falls back to cold docker run).
	 */
	async claim(sessionId: string, opts?: ClaimOptions): Promise<ClaimResult | null> {
		// Find an idle slot
		let slot: PoolSlot | undefined;
		for (const s of this.slots.values()) {
			if (s.state === "idle") { slot = s; break; }
		}
		if (!slot) return null;

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

	/** Create a new pool slot: worktree + container. */
	private async _createSlot(): Promise<void> {
		if (this._shutdownRequested) return;

		const slotId = crypto.randomUUID().slice(0, 8);
		const slotName = `pool-${slotId}`;
		const worktreePath = path.join(this._poolDir, slotName);

		try {
			// Create git worktree on a detached HEAD from the default branch
			// Using detached HEAD avoids branch name conflicts between slots
			await git(
				["worktree", "add", "--detach", worktreePath, this._defaultBranch],
				this.options.repoPath,
				60_000,
			);

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
				return;
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
		} catch (err) {
			console.warn(`[sandbox-pool] Failed to create slot ${slotName}:`, err);
			// Clean up worktree if container creation failed
			await this._removeWorktree(worktreePath);
		}
	}

	/** Build docker run args for a pool container with a specific worktree. */
	private _buildDockerArgs(worktreePath: string): string[] {
		const { image } = this.options;
		const agentModulesDir = resolveAgentModulesDir();
		const toolsDir = TOOLS_DIR;

		const args: string[] = [
			"run", "-d",
			"--add-host=host.docker.internal:host-gateway",
			"--label", `bobbit-sandbox=${this.label}`,
			"--label", "bobbit-sandbox-version=2",
			"--label", `bobbit-sandbox-wt=${worktreePath}`,
		];

		// Mount THIS slot's worktree as /workspace (not the primary project dir)
		args.push("-v", `${toDockerPath(worktreePath)}:/workspace`);
		args.push("-v", `${toDockerPath(agentModulesDir)}:/node_modules:ro`);
		args.push("-v", `${toDockerPath(toolsDir)}:/tools:ro`);

		// Host agent dir
		const hostAgentDir = globalAgentDir();
		fs.mkdirSync(path.join(hostAgentDir, "sessions"), { recursive: true });
		args.push("-v", `${toDockerPath(hostAgentDir)}:/home/node/.bobbit/agent`);

		// Named volumes for caches
		args.push("-v", `bobbit-nm-cache-${this.label}:/home/node/.node_modules_cache`);
		args.push("-v", `bobbit-npm-cache-${this.label}:/home/node/.npm-cache`);

		// Session prompts directory
		const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
		fs.mkdirSync(sessionPromptsDir, { recursive: true });
		args.push("-v", `${toDockerPath(sessionPromptsDir)}:/tmp/session-prompts`);

		// User-configured mounts
		if (this.options.sandboxMounts) {
			for (const mount of this.options.sandboxMounts) {
				const parts = mount.split(":");
				if (parts.length >= 2) {
					parts[0] = toDockerPath(parts[0]);
					args.push("-v", parts.join(":"));
				}
			}
		}

		// Gateway URL — rewrite to host.docker.internal
		if (this.options.gatewayUrl) {
			let containerGatewayUrl = this.options.gatewayUrl;
			try {
				const parsed = new URL(this.options.gatewayUrl);
				containerGatewayUrl = `${parsed.protocol}//host.docker.internal:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
			} catch { /* keep original */ }
			args.push("-e", `BOBBIT_GATEWAY_URL=${containerGatewayUrl}`);
		}
		if (this.options.gatewayToken) {
			args.push("-e", `BOBBIT_TOKEN=${this.options.gatewayToken}`);
		}
		args.push("-e", "NODE_TLS_REJECT_UNAUTHORIZED=0");
		args.push("-e", "PI_CODING_AGENT_DIR=/home/node/.bobbit/agent");

		// Sandbox credentials
		if (this.options.sandboxCredentials) {
			for (const [key, value] of Object.entries(this.options.sandboxCredentials)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
				args.push("-e", `${key}=${value}`);
			}
		}

		// Proxy
		if (this.options.sandboxProxyPort) {
			const proxyUrl = `http://host.docker.internal:${this.options.sandboxProxyPort}`;
			args.push("-e", `http_proxy=${proxyUrl}`);
			args.push("-e", `https_proxy=${proxyUrl}`);
			args.push("-e", "no_proxy=host.docker.internal,localhost,127.0.0.1");
		}

		// MCP extensions
		const mcpExtDir = path.join(bobbitDir(), "state", "mcp-extensions");
		try {
			if (fs.statSync(mcpExtDir).isDirectory()) {
				args.push("-v", `${toDockerPath(mcpExtDir)}:/mcp-extensions:ro`);
			}
		} catch { /* doesn't exist — skip */ }

		// Image + command
		args.push(image, "sleep", "infinity");

		return args;
	}

	/** Checkout a branch in a slot's worktree. */
	private async _checkoutBranch(slot: PoolSlot, branch: string, from?: string): Promise<void> {
		const wt = slot.worktreePath;

		// Fetch latest from origin
		await git(["fetch", "origin"], wt, 30_000);

		// Create and checkout the new branch
		if (from) {
			// Branch from a specific ref (e.g. origin/goal-branch for members)
			await git(["checkout", "-b", branch, from], wt, 15_000);
		} else {
			// Branch from current HEAD (which is on the default branch)
			await git(["checkout", "-b", branch], wt, 15_000);
		}

		slot.branch = branch;

		// Push and set upstream (non-fatal)
		try {
			await git(["push", "-u", "origin", branch], wt, 30_000);
		} catch {
			// Push may fail — not fatal
		}
	}

	/** Reset a slot's worktree back to the default branch and clean up. */
	private async _resetSlot(slot: PoolSlot): Promise<void> {
		const wt = slot.worktreePath;
		try {
			// Discard all changes and switch back to detached HEAD on default branch
			await git(["checkout", "--detach", "--force"], wt, 15_000);
			await git(["clean", "-fdx"], wt, 30_000);
			await git(["fetch", "origin", this._defaultBranch], wt, 30_000);
			await git(["reset", "--hard", `origin/${this._defaultBranch}`], wt, 15_000);

			// Delete the branch that was checked out (clean up refs)
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

	/** Remove a git worktree from disk. */
	private async _removeWorktree(worktreePath: string): Promise<void> {
		try {
			await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
				cwd: this.options.repoPath,
				timeout: 15_000,
			});
		} catch {
			// If git worktree remove fails, try manual cleanup
			try {
				fs.rmSync(worktreePath, { recursive: true, force: true });
				await execFileAsync("git", ["worktree", "prune"], {
					cwd: this.options.repoPath,
					timeout: 10_000,
				});
			} catch { /* best effort */ }
		}
	}

	// ── Pool maintenance ───────────────────────────────────────────────────

	/** Re-adopt containers from a previous gateway run. */
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

			for (const containerId of containerIds) {
				if (this.slots.has(containerId)) continue;

				// Validate: check the worktree mount and label
				const valid = await this._validateSlot(containerId);
				if (valid) {
					console.log(`[sandbox-pool] Re-adopted container ${containerId.slice(0, 12)}`);
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

			// The mount source should be under our pool directory
			const normalizedMount = mountSource.replace(/\\/g, "/");
			const normalizedPoolDir = this._poolDir.replace(/\\/g, "/");
			if (!normalizedMount.startsWith(normalizedPoolDir)) return false;

			// Check worktree exists on disk
			const worktreePath = mountSource;
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
				// Create sequentially to avoid overwhelming Docker
				for (let i = 0; i < needed; i++) {
					await this._createSlot();
				}
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
