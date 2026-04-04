/**
 * SandboxManager — Registry mapping projectId → ProjectSandbox.
 *
 * Coordinates lifecycle of per-project sandbox containers. Each project
 * with `sandbox: "docker"` gets exactly one long-lived container managed
 * by a ProjectSandbox instance.
 */

import { ProjectSandbox } from "./project-sandbox.js";
import type { ProjectSandboxOptions, ContainerState } from "./project-sandbox.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SandboxManagerStats {
	projects: number;
	containers: ContainerState[];
}

// ── SandboxManager ─────────────────────────────────────────────────────────

export class SandboxManager {
	private sandboxes = new Map<string, ProjectSandbox>();

	/**
	 * Initialize sandbox for a project. Creates the ProjectSandbox and calls init().
	 * If a sandbox already exists for this project, reconnects to it.
	 */
	async initForProject(projectId: string, opts: ProjectSandboxOptions): Promise<void> {
		// If already tracked, just return — init was already done
		if (this.sandboxes.has(projectId)) {
			const existing = this.sandboxes.get(projectId)!;
			if (existing.getStatus().status === "ready") {
				return;
			}
			// Previous init failed — remove and retry
			this.sandboxes.delete(projectId);
		}

		const sandbox = new ProjectSandbox(opts);
		this.sandboxes.set(projectId, sandbox);

		try {
			await sandbox.init();
			console.log(`[sandbox-manager] Project ${projectId} sandbox ready (container: ${sandbox.getStatus().containerId.substring(0, 12)})`);
		} catch (err: any) {
			console.error(`[sandbox-manager] Failed to init sandbox for project ${projectId}:`, err?.message || err);
			// Keep it in the map so callers can see the error state.
			// They can call initForProject again to retry.
			throw err;
		}
	}

	/** Get the sandbox for a project. Returns undefined if not initialized. */
	get(projectId: string): ProjectSandbox | undefined {
		return this.sandboxes.get(projectId);
	}

	/** Check if a project has a sandbox registered (regardless of state). */
	has(projectId: string): boolean {
		return this.sandboxes.has(projectId);
	}

	/** Get stats for all sandboxes. */
	getStats(): SandboxManagerStats {
		const containers: ContainerState[] = [];
		for (const sandbox of this.sandboxes.values()) {
			containers.push(sandbox.getStatus());
		}
		return { projects: this.sandboxes.size, containers };
	}

	/** Shutdown all sandboxes gracefully (stop containers, preserve volumes). */
	async shutdownAll(): Promise<void> {
		const shutdownPromises = [...this.sandboxes.values()].map(sandbox =>
			sandbox.shutdown().catch(err => {
				console.warn(`[sandbox-manager] Shutdown error:`, err?.message || err);
			}),
		);
		await Promise.allSettled(shutdownPromises);
		console.log(`[sandbox-manager] All ${this.sandboxes.size} sandbox(es) shut down`);
	}

	/** Destroy sandbox for a project (remove container AND volume). */
	async destroy(projectId: string): Promise<void> {
		const sandbox = this.sandboxes.get(projectId);
		if (!sandbox) return;

		await sandbox.destroy();
		this.sandboxes.delete(projectId);
		console.log(`[sandbox-manager] Destroyed sandbox for project ${projectId}`);
	}

	/** Destroy all sandboxes. */
	async destroyAll(): Promise<void> {
		const destroyPromises = [...this.sandboxes.entries()].map(([projectId, sandbox]) =>
			sandbox.destroy().catch(err => {
				console.warn(`[sandbox-manager] Destroy error for project ${projectId}:`, err?.message || err);
			}),
		);
		await Promise.allSettled(destroyPromises);
		this.sandboxes.clear();
	}

	/** Number of tracked sandboxes. */
	get size(): number {
		return this.sandboxes.size;
	}
}
