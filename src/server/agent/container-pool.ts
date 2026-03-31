import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { toDockerPath, resolveAgentModulesDir } from "./rpc-bridge.js";

const execFileAsync = promisify(execFile);

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface PoolContainer {
	id: string;             // Docker container ID (full SHA)
	shortId: string;        // First 12 chars for logging
	state: "warming" | "idle" | "claimed";
	sessions: Set<string>;  // Session IDs using this container
	createdAt: number;
	lastActivity: number;   // Updated when container transitions to 'idle' (on release)
}

export interface ContainerPoolOptions {
	poolSize: number;                           // Target idle containers (default: 2)
	maxIdleSeconds: number;                     // Cull excess idle containers after this (default: 300)
	image: string;                              // Docker image name
	projectDir: string;                         // Host project directory to mount
	healthCheckIntervalMs: number;              // Default: 30000 (30s)
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	gatewayUrl: string;
	gatewayToken: string;
	sandboxProxyPort?: number;
}

/**
 * Simple hash of the project directory to create a unique label for this project's pool.
 */
function projectHash(projectDir: string): string {
	return crypto.createHash("sha256").update(projectDir).digest("hex").substring(0, 12);
}

// ── ContainerPool ─────────────────────────────────────────────────────────────

export class ContainerPool {
	private containers = new Map<string, PoolContainer>();
	private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private _replenishing = false;
	private _shutdownRequested = false;
	private readonly label: string;

	constructor(readonly options: ContainerPoolOptions) {
		this.label = projectHash(options.projectDir);
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/** Initialize pool: re-adopt existing containers, cleanup stopped orphans, pre-warm to target size */
	async init(): Promise<void> {
		console.log(`[container-pool] Initializing pool (size=${this.options.poolSize}, image=${this.options.image}, label=bobbit-pool=${this.label})`);

		// 1. Cleanup stopped orphans
		await this._cleanupStopped();

		// 2. Re-adopt running containers from previous gateway
		await this._readopt();

		// 3. Pre-warm to target size
		const idleCount = this._countByState("idle");
		const needed = Math.max(0, this.options.poolSize - idleCount);
		if (needed > 0) {
			console.log(`[container-pool] Pre-warming ${needed} container(s)`);
			const promises = Array.from({ length: needed }, () => this._createContainer());
			await Promise.allSettled(promises);
		}

		console.log(`[container-pool] Pool ready: ${this._statsString()}`);

		// 4. Start health check
		this._healthCheckTimer = setInterval(() => {
			this._healthCheck().catch((err) => {
				console.error(`[container-pool] Health check error:`, err);
			});
		}, this.options.healthCheckIntervalMs);
	}

	/**
	 * Claim a container for a session. Returns containerId or null if exhausted.
	 * SYNCHRONOUS — never awaits Docker. Safe for concurrent calls.
	 */
	claim(sessionId: string): string | null {
		for (const container of this.containers.values()) {
			if (container.state === "idle") {
				container.state = "claimed";
				container.sessions.add(sessionId);
				console.log(`[container-pool] Claimed container ${container.shortId} for session ${sessionId}`);

				// Fire-and-forget async replenish
				this._replenish().catch((err) => {
					console.error(`[container-pool] Replenish error:`, err);
				});

				return container.id;
			}
		}

		console.warn(`[container-pool] Pool exhausted — no idle containers available`);
		return null;
	}

	/** Release a session from its container */
	release(sessionId: string, containerId: string): void {
		const container = this.containers.get(containerId);
		if (!container) {
			console.warn(`[container-pool] release: unknown container ${containerId.substring(0, 12)}`);
			return;
		}

		container.sessions.delete(sessionId);
		if (container.sessions.size === 0) {
			container.state = "idle";
			container.lastActivity = Date.now();
			console.log(`[container-pool] Released container ${container.shortId} — now idle`);
		} else {
			console.log(`[container-pool] Released session ${sessionId} from container ${container.shortId} — ${container.sessions.size} session(s) remaining`);
		}
	}

	/** Get pool stats for the status endpoint */
	getStats(): { total: number; idle: number; claimed: number; warming: number } {
		return {
			total: this.containers.size,
			idle: this._countByState("idle"),
			claimed: this._countByState("claimed"),
			warming: this._countByState("warming"),
		};
	}

	/** Graceful shutdown — wait for sessions to drain, then stop containers */
	async shutdown(): Promise<void> {
		this._shutdownRequested = true;
		this.dispose();

		console.log(`[container-pool] Shutting down — waiting up to 10s for sessions to drain`);

		// Phase 1: Wait up to 10s for all claimed containers to drain
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const claimed = this._countByState("claimed");
			if (claimed === 0) break;
			await new Promise((r) => setTimeout(r, 250));
		}

		// Phase 2: Stop all containers
		const ids = Array.from(this.containers.keys());
		if (ids.length === 0) return;

		console.log(`[container-pool] Stopping ${ids.length} container(s)`);
		try {
			await execFileAsync("docker", ["stop", ...ids], { timeout: 15_000 });
		} catch (err) {
			console.error(`[container-pool] Error stopping containers:`, err);
		}

		this.containers.clear();
		console.log(`[container-pool] Shutdown complete`);
	}

	/** Stop health check timer (for testing and shutdown) */
	dispose(): void {
		if (this._healthCheckTimer) {
			clearInterval(this._healthCheckTimer);
			this._healthCheckTimer = null;
		}
	}

	// ── Private: Container Creation ────────────────────────────────────────

	/** Create a new pool container via docker run -d */
	private async _createContainer(): Promise<void> {
		const dockerArgs = this._buildDockerArgs();

		try {
			const { stdout } = await execFileAsync("docker", dockerArgs, {
				timeout: 30_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			});

			const containerId = stdout.trim();
			if (!containerId) {
				console.warn(`[container-pool] docker run -d returned empty container ID`);
				return;
			}

			const container: PoolContainer = {
				id: containerId,
				shortId: containerId.substring(0, 12),
				state: "idle",
				sessions: new Set(),
				createdAt: Date.now(),
				lastActivity: Date.now(),
			};
			this.containers.set(containerId, container);
			console.log(`[container-pool] Created container ${container.shortId}`);
		} catch (err) {
			console.warn(`[container-pool] Failed to create container:`, err);
		}
	}

	/** Build docker run -d args for a pool container */
	private _buildDockerArgs(): string[] {
		const { projectDir, image } = this.options;
		const agentModulesDir = resolveAgentModulesDir();
		const toolsDir = TOOLS_DIR;

		const args: string[] = [
			"run", "-d",
			"--add-host=host.docker.internal:host-gateway",
			"--label", `bobbit-pool=${this.label}`,
			"--label", "bobbit-pool-version=1",
		];

		// Bind mounts (identical to rpc-bridge spawnDocker)
		args.push("-v", `${toDockerPath(projectDir)}:/workspace`);
		args.push("-v", `${toDockerPath(agentModulesDir)}:/node_modules:ro`);
		args.push("-v", `${toDockerPath(toolsDir)}:/tools:ro`);

		// Mount the worktree root so goal worktrees are accessible inside pool containers.
		// Worktrees live at <projectDir>-wt/ (sibling of the project dir).
		const wtRoot = projectDir.replace(/\\/g, "/").replace(/\/$/, "") + "-wt";
		fs.mkdirSync(wtRoot, { recursive: true });
		args.push("-v", `${toDockerPath(wtRoot)}:/worktrees`);

		// Host agent dir (~/.bobbit/agent/ or legacy ~/.pi/agent/)
		const hostAgentDir = globalAgentDir();
		fs.mkdirSync(path.join(hostAgentDir, "sessions"), { recursive: true });
		args.push("-v", `${toDockerPath(hostAgentDir)}:/home/node/.bobbit/agent`);

		// Persistent named volume for node_modules cache — survives container restarts
		// and is shared across pool containers. On cross-platform setups (Windows host,
		// Linux container), this cache stores Linux-native node_modules indexed by
		// package-lock.json hash, so only the first container pays the npm ci cost.
		args.push("-v", `bobbit-nm-cache-${this.label}:/home/node/.node_modules_cache`);
		// Also persist npm download cache for faster installs
		args.push("-v", `bobbit-npm-cache-${this.label}:/home/node/.npm-cache`);

		// Session prompts directory (read-write, live bind mount)
		const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
		fs.mkdirSync(sessionPromptsDir, { recursive: true });
		args.push("-v", `${toDockerPath(sessionPromptsDir)}:/tmp/session-prompts`);

		// Additional user-configured mounts
		if (this.options.sandboxMounts) {
			for (const mount of this.options.sandboxMounts) {
				const parts = mount.split(":");
				if (parts.length >= 2) {
					parts[0] = toDockerPath(parts[0]);
					args.push("-v", parts.join(":"));
				}
			}
		}

		// Gateway URL — pass the real address (traffic routes through sandbox proxy)
		if (this.options.gatewayUrl) {
			args.push("-e", `BOBBIT_GATEWAY_URL=${this.options.gatewayUrl}`);
		}
		if (this.options.gatewayToken) {
			args.push("-e", `BOBBIT_TOKEN=${this.options.gatewayToken}`);
		}
		args.push("-e", "NODE_TLS_REJECT_UNAUTHORIZED=0");
		// Tell the agent CLI to use .bobbit/agent instead of .pi/agent
		args.push("-e", "PI_CODING_AGENT_DIR=/home/node/.bobbit/agent");

		// Sandbox credentials
		if (this.options.sandboxCredentials) {
			for (const [key, value] of Object.entries(this.options.sandboxCredentials)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
					console.warn(`[container-pool] Skipping invalid credential key: ${key}`);
					continue;
				}
				args.push("-e", `${key}=${value}`);
			}
		}

		// Proxy env vars
		if (this.options.sandboxProxyPort) {
			const proxyUrl = `http://host.docker.internal:${this.options.sandboxProxyPort}`;
			args.push("-e", `http_proxy=${proxyUrl}`);
			args.push("-e", `https_proxy=${proxyUrl}`);
			args.push("-e", "no_proxy=localhost,127.0.0.1");
		}

		// MCP extensions directory
		const mcpExtDir = path.join(bobbitDir(), "state", "mcp-extensions");
		try {
			const mcpStat = fs.statSync(mcpExtDir);
			if (mcpStat.isDirectory()) {
				args.push("-v", `${toDockerPath(mcpExtDir)}:/mcp-extensions:ro`);
			}
		} catch {
			// MCP extensions dir doesn't exist — skip
		}

		// Image + entrypoint
		args.push(image, "sleep", "infinity");

		return args;
	}

	// ── Private: Re-adopt ──────────────────────────────────────────────────

	/** Re-adopt running containers from a previous gateway instance */
	private async _readopt(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "-q", "--filter", `label=bobbit-pool=${this.label}`,
			], { timeout: 10_000 });

			const ids = stdout.trim().split("\n").filter(Boolean);
			if (ids.length === 0) return;

			console.log(`[container-pool] Found ${ids.length} existing container(s) to re-adopt`);

			for (const id of ids) {
				const valid = await this._validateContainer(id);
				if (valid) {
					const container: PoolContainer = {
						id,
						shortId: id.substring(0, 12),
						state: "idle",
						sessions: new Set(),
						createdAt: Date.now(),
						lastActivity: Date.now(),
					};
					this.containers.set(id, container);
					console.log(`[container-pool] Re-adopted container ${container.shortId}`);
				} else {
					console.log(`[container-pool] Stopping stale container ${id.substring(0, 12)}`);
					try {
						await execFileAsync("docker", ["stop", id], { timeout: 15_000 });
						await execFileAsync("docker", ["rm", id], { timeout: 10_000 });
					} catch {
						// best effort
					}
				}
			}
		} catch (err) {
			console.warn(`[container-pool] Re-adopt failed:`, err);
		}
	}

	/**
	 * Validate a container's mounts match current config.
	 * Checks that /workspace mount points to the current projectDir.
	 */
	private async _validateContainer(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect", "--format", "{{json .Mounts}}", containerId,
			], { timeout: 10_000 });

			const mounts = JSON.parse(stdout.trim()) as Array<{ Type: string; Source: string; Destination: string }>;
			const workspaceMount = mounts.find((m) => m.Destination === "/workspace");
			if (!workspaceMount) return false;

			// Normalize paths for comparison
			const expectedSource = toDockerPath(this.options.projectDir);
			const actualSource = toDockerPath(workspaceMount.Source);
			return actualSource === expectedSource;
		} catch {
			return false;
		}
	}

	// ── Private: Cleanup ───────────────────────────────────────────────────

	/** Remove stopped orphan containers from previous runs */
	private async _cleanupStopped(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "-aq", "--filter", `label=bobbit-pool=${this.label}`, "--filter", "status=exited",
			], { timeout: 10_000 });

			const ids = stdout.trim().split("\n").filter(Boolean);
			if (ids.length === 0) return;

			console.log(`[container-pool] Cleaning up ${ids.length} stopped orphan(s)`);
			for (const id of ids) {
				try {
					await execFileAsync("docker", ["rm", id], { timeout: 10_000 });
				} catch {
					// best effort
				}
			}
		} catch (err) {
			console.warn(`[container-pool] Orphan cleanup failed:`, err);
		}
	}

	// ── Private: Replenish ─────────────────────────────────────────────────

	/** Replenish pool to target size if below threshold */
	private async _replenish(): Promise<void> {
		if (this._replenishing || this._shutdownRequested) return;

		const idleCount = this._countByState("idle");
		const needed = this.options.poolSize - idleCount;
		if (needed <= 0) return;

		this._replenishing = true;
		try {
			console.log(`[container-pool] Replenishing ${needed} container(s)`);
			const promises = Array.from({ length: needed }, () => this._createContainer());
			await Promise.allSettled(promises);
		} finally {
			this._replenishing = false;
		}
	}

	// ── Private: Health Check ──────────────────────────────────────────────

	private async _healthCheck(): Promise<void> {
		if (this._shutdownRequested) return;

		// Snapshot container IDs before async work
		const snapshot = Array.from(this.containers.entries());
		const toRemove: string[] = [];

		for (const [id, container] of snapshot) {
			try {
				const { stdout } = await execFileAsync("docker", [
					"inspect", "--format", "{{.State.Status}}", id,
				], { timeout: 10_000 });

				const status = stdout.trim();
				if (status !== "running") {
					console.warn(`[container-pool] Container ${container.shortId} is ${status} — removing`);
					toRemove.push(id);
				}
			} catch {
				// Container doesn't exist or inspect failed — remove it
				console.warn(`[container-pool] Container ${container.shortId} inspect failed — removing`);
				toRemove.push(id);
			}
		}

		// Apply removals — skip any that were claimed since snapshot
		for (const id of toRemove) {
			const current = this.containers.get(id);
			if (!current) continue; // already removed
			if (current.state === "claimed") continue; // claimed between snapshot and apply

			this.containers.delete(id);

			// Try to remove the stopped container
			try {
				await execFileAsync("docker", ["rm", "-f", id], { timeout: 10_000 });
			} catch {
				// best effort
			}
		}

		// Idle culling: remove excess idle containers that have been idle too long
		this._cullExcessIdle();

		// Replenish if needed
		await this._replenish();
	}

	/** Cull idle containers that exceed the target pool size and have been idle too long */
	private _cullExcessIdle(): void {
		const now = Date.now();
		const maxIdleMs = this.options.maxIdleSeconds * 1000;
		let idleCount = this._countByState("idle");

		for (const [id, container] of this.containers) {
			if (idleCount <= this.options.poolSize) break;
			if (container.state !== "idle") continue;
			if (now - container.lastActivity <= maxIdleMs) continue;

			console.log(`[container-pool] Culling excess idle container ${container.shortId}`);
			this.containers.delete(id);
			idleCount--;

			// Fire-and-forget stop+rm
			execFileAsync("docker", ["stop", id], { timeout: 15_000 })
				.then(() => execFileAsync("docker", ["rm", id], { timeout: 10_000 }))
				.catch(() => { /* best effort */ });
		}
	}

	// ── Private: Utility ───────────────────────────────────────────────────

	private _countByState(state: PoolContainer["state"]): number {
		let count = 0;
		for (const c of this.containers.values()) {
			if (c.state === state) count++;
		}
		return count;
	}

	private _statsString(): string {
		const stats = this.getStats();
		return `total=${stats.total} idle=${stats.idle} claimed=${stats.claimed} warming=${stats.warming}`;
	}
}
