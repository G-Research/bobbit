/**
 * Docker container pool for pre-warming sandbox containers.
 * Sessions start via `docker exec` inside already-running containers,
 * reducing startup from ~5-10s to ~200ms.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

export interface PoolContainer {
	id: string;            // Docker container ID (full SHA)
	shortId: string;       // First 12 chars for logging
	state: "warming" | "idle" | "claimed";
	sessions: Set<string>; // Session IDs using this container
	createdAt: number;
	lastActivity: number;  // Updated when container transitions to 'idle' (on release)
}

export interface ContainerPoolOptions {
	poolSize: number;             // Target idle containers (default: 2)
	maxIdleSeconds: number;       // Cull excess idle containers after this (default: 300)
	image: string;                // Docker image name
	projectDir: string;           // Host project directory to mount
	healthCheckIntervalMs: number; // Default: 30000 (30s)
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	gatewayUrl: string;
	gatewayToken: string;
	sandboxProxyPort?: number;
}

export class ContainerPool {
	private containers = new Map<string, PoolContainer>();
	private options: ContainerPoolOptions;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private _replenishing = false;
	private _shuttingDown = false;
	private projectHash: string;

	constructor(options: ContainerPoolOptions) {
		this.options = options;
		this.projectHash = createHash("md5").update(options.projectDir).digest("hex").slice(0, 12);
	}

	/** Initialize pool: re-adopt existing containers, clean up orphans, pre-warm to target size */
	async init(): Promise<void> {
		await this.cleanupStopped();
		await this.reAdopt();

		const idleCount = this.countByState("idle");
		const needed = Math.max(0, this.options.poolSize - idleCount);
		if (needed > 0) {
			console.log(`[container-pool] Pre-warming ${needed} container(s)...`);
			const promises = [];
			for (let i = 0; i < needed; i++) {
				promises.push(this.createContainer());
			}
			await Promise.allSettled(promises);
		}

		console.log(`[container-pool] Pool ready: ${this.getStats().idle} idle, ${this.getStats().total} total`);

		// Start health check interval
		this.healthCheckTimer = setInterval(() => this.healthCheck(), this.options.healthCheckIntervalMs);
	}

	/** Claim a container for a session. Returns containerId or null if exhausted. Synchronous. */
	claim(sessionId: string): string | null {
		for (const container of this.containers.values()) {
			if (container.state === "idle") {
				container.state = "claimed";
				container.sessions.add(sessionId);
				console.log(`[container-pool] Claimed ${container.shortId} for session ${sessionId}`);

				// Fire-and-forget replenish
				this.replenish().catch(err => {
					console.error("[container-pool] Replenish failed:", err);
				});

				return container.id;
			}
		}
		return null;
	}

	/** Release a session from its container */
	release(sessionId: string, containerId: string): void {
		const container = this.containers.get(containerId);
		if (!container) return;

		container.sessions.delete(sessionId);
		if (container.sessions.size === 0) {
			container.state = "idle";
			container.lastActivity = Date.now();
			console.log(`[container-pool] Released ${container.shortId} back to idle`);
		}
	}

	/** Get pool stats for the status endpoint */
	getStats(): { total: number; idle: number; claimed: number; warming: number } {
		let idle = 0, claimed = 0, warming = 0;
		for (const c of this.containers.values()) {
			if (c.state === "idle") idle++;
			else if (c.state === "claimed") claimed++;
			else if (c.state === "warming") warming++;
		}
		return { total: this.containers.size, idle, claimed, warming };
	}

	/** Graceful shutdown — wait for sessions to drain, then stop containers */
	async shutdown(): Promise<void> {
		this._shuttingDown = true;
		this.dispose();

		// Phase 1: Wait up to 10s for claimed containers to drain
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && this.countByState("claimed") > 0) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		// Phase 2: Stop all containers
		const ids = [...this.containers.keys()];
		if (ids.length > 0) {
			console.log(`[container-pool] Stopping ${ids.length} container(s)...`);
			try {
				await execFileAsync("docker", ["stop", ...ids], { timeout: 30_000 });
			} catch (err) {
				console.error("[container-pool] Error stopping containers:", err);
			}
		}
		this.containers.clear();
	}

	/** Stop health check timer (for testing and shutdown) */
	dispose(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	// ── Private helpers ──

	private countByState(state: PoolContainer["state"]): number {
		let count = 0;
		for (const c of this.containers.values()) {
			if (c.state === state) count++;
		}
		return count;
	}

	private buildDockerArgs(): string[] {
		const opts = this.options;
		const args: string[] = [
			"run", "-d",
			"--label", `bobbit-pool=${this.projectHash}`,
			"--label", "bobbit-pool-version=1",
			"--add-host=host.docker.internal:host-gateway",
			"-v", `${opts.projectDir}:/workspace`,
		];

		// Agent modules mount
		const agentPkg = this.resolveAgentModulesDir();
		if (agentPkg) {
			args.push("-v", `${agentPkg}:/node_modules/@mariozechner/pi-coding-agent:ro`);
		}

		// Tool extensions
		const toolsDir = path.resolve(".", ".bobbit", "config", "tools");
		args.push("-v", `${toolsDir}:/tools:ro`);

		// Agent sessions directory
		const hostAgentDir = path.join(os.homedir(), ".pi", "agent", "sessions");
		args.push("-v", `${hostAgentDir}:/home/node/.pi/agent/sessions`);

		// Session prompts directory (live bind mount — files written after creation are visible)
		const sessionPromptsDir = path.resolve(".", ".bobbit", "state", "session-prompts");
		args.push("-v", `${sessionPromptsDir}:/tmp/session-prompts`);

		// MCP extensions
		const mcpExtDir = path.resolve(".", ".bobbit", "state", "mcp-extensions");
		if (fs.existsSync(mcpExtDir)) {
			args.push("-v", `${mcpExtDir}:/mcp-extensions:ro`);
		}

		// Additional sandbox mounts
		if (opts.sandboxMounts) {
			for (const mount of opts.sandboxMounts) {
				args.push("-v", mount);
			}
		}

		// Environment variables
		args.push("-e", `BOBBIT_GATEWAY_URL=${opts.gatewayUrl}`);
		args.push("-e", `BOBBIT_TOKEN=${opts.gatewayToken}`);

		if (opts.sandboxProxyPort) {
			const proxyUrl = `http://host.docker.internal:${opts.sandboxProxyPort}`;
			args.push("-e", `http_proxy=${proxyUrl}`);
			args.push("-e", `https_proxy=${proxyUrl}`);
			args.push("-e", `no_proxy=host.docker.internal,localhost,127.0.0.1`);
		}

		// Sandbox credentials
		if (opts.sandboxCredentials) {
			for (const [key, value] of Object.entries(opts.sandboxCredentials)) {
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
					args.push("-e", `${key}=${value}`);
				}
			}
		}

		// Non-root user
		args.push("--user", "node");
		args.push("-w", "/workspace");

		args.push(opts.image, "sleep", "infinity");

		return args;
	}

	private resolveAgentModulesDir(): string | null {
		try {
			const mainPath = require.resolve("@mariozechner/pi-coding-agent");
			// Go up to the package root
			const parts = mainPath.replace(/\\/g, "/").split("/node_modules/");
			if (parts.length >= 2) {
				return parts[0] + "/node_modules/@mariozechner/pi-coding-agent";
			}
		} catch { /* ignore */ }
		return null;
	}

	private async createContainer(): Promise<void> {
		const args = this.buildDockerArgs();
		try {
			const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
			const containerId = stdout.trim();
			const shortId = containerId.slice(0, 12);
			const now = Date.now();
			this.containers.set(containerId, {
				id: containerId,
				shortId,
				state: "idle",
				sessions: new Set(),
				createdAt: now,
				lastActivity: now,
			});
			console.log(`[container-pool] Created container ${shortId}`);
		} catch (err) {
			console.warn("[container-pool] Failed to create container:", err);
		}
	}

	private async replenish(): Promise<void> {
		if (this._replenishing || this._shuttingDown) return;
		const idleCount = this.countByState("idle");
		if (idleCount >= this.options.poolSize) return;

		this._replenishing = true;
		try {
			const needed = this.options.poolSize - idleCount;
			for (let i = 0; i < needed; i++) {
				await this.createContainer();
			}
		} finally {
			this._replenishing = false;
		}
	}

	private async healthCheck(): Promise<void> {
		if (this._shuttingDown) return;

		// Snapshot container IDs to avoid concurrent mutation issues
		const ids = [...this.containers.keys()];
		for (const id of ids) {
			const container = this.containers.get(id);
			if (!container) continue;

			try {
				const { stdout } = await execFileAsync(
					"docker", ["inspect", "--format", "{{.State.Status}}", id],
					{ timeout: 5_000 },
				);
				const status = stdout.trim();
				if (status !== "running") {
					console.warn(`[container-pool] Container ${container.shortId} is ${status}, removing`);
					this.containers.delete(id);
				}
			} catch {
				console.warn(`[container-pool] Container ${container.shortId} inspect failed, removing`);
				this.containers.delete(id);
			}
		}

		// Idle culling: cull excess idle containers past maxIdleSeconds
		const idleContainers = [...this.containers.values()].filter(c => c.state === "idle");
		if (idleContainers.length > this.options.poolSize) {
			const excess = idleContainers
				.filter(c => Date.now() - c.lastActivity > this.options.maxIdleSeconds * 1000)
				.slice(0, idleContainers.length - this.options.poolSize);
			for (const c of excess) {
				console.log(`[container-pool] Culling idle container ${c.shortId}`);
				this.containers.delete(c.id);
				execFileAsync("docker", ["stop", c.id], { timeout: 15_000 }).catch(() => {});
			}
		}

		// Replenish to target
		await this.replenish();
	}

	private async reAdopt(): Promise<void> {
		try {
			const { stdout } = await execFileAsync(
				"docker",
				["ps", "-q", "--filter", `label=bobbit-pool=${this.projectHash}`],
				{ timeout: 10_000 },
			);
			const ids = stdout.trim().split("\n").filter(Boolean);
			if (ids.length === 0) return;

			console.log(`[container-pool] Found ${ids.length} existing container(s) to re-adopt`);

			for (const id of ids) {
				try {
					// Verify bind mounts match current config
					const { stdout: mountsJson } = await execFileAsync(
						"docker",
						["inspect", "--format", "{{json .Mounts}}", id],
						{ timeout: 5_000 },
					);
					const mounts = JSON.parse(mountsJson.trim());
					const hasWorkspace = mounts.some((m: any) =>
						m.Destination === "/workspace" &&
						m.Source.replace(/\\/g, "/") === this.options.projectDir.replace(/\\/g, "/")
					);

					if (!hasWorkspace) {
						console.warn(`[container-pool] Stale container ${id.slice(0, 12)} has mismatched mounts, removing`);
						execFileAsync("docker", ["stop", id], { timeout: 15_000 }).catch(() => {});
						execFileAsync("docker", ["rm", id], { timeout: 10_000 }).catch(() => {});
						continue;
					}

					const now = Date.now();
					this.containers.set(id, {
						id,
						shortId: id.slice(0, 12),
						state: "idle",
						sessions: new Set(),
						createdAt: now,
						lastActivity: now,
					});
					console.log(`[container-pool] Re-adopted container ${id.slice(0, 12)}`);
				} catch (err) {
					console.warn(`[container-pool] Failed to re-adopt ${id.slice(0, 12)}:`, err);
				}
			}
		} catch (err) {
			console.warn("[container-pool] Failed to find existing containers:", err);
		}
	}

	private async cleanupStopped(): Promise<void> {
		try {
			const { stdout } = await execFileAsync(
				"docker",
				["ps", "-aq", "--filter", `label=bobbit-pool=${this.projectHash}`, "--filter", "status=exited"],
				{ timeout: 10_000 },
			);
			const ids = stdout.trim().split("\n").filter(Boolean);
			for (const id of ids) {
				try {
					await execFileAsync("docker", ["rm", id], { timeout: 10_000 });
					console.log(`[container-pool] Cleaned up stopped container ${id.slice(0, 12)}`);
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}
}
