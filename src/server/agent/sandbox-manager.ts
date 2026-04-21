/**
 * SandboxManager — Registry mapping projectId → ProjectSandbox.
 *
 * Coordinates lifecycle of per-project sandbox containers. Each project
 * with `sandbox: "docker"` gets exactly one long-lived container managed
 * by a ProjectSandbox instance.
 */

import { ProjectSandbox } from "./project-sandbox.js";
import type { ProjectSandboxOptions, ContainerState, SandboxHealthEvent } from "./project-sandbox.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SandboxManagerStats {
	projects: number;
	containers: ContainerState[];
}

/**
 * Resolves the per-project sandbox configuration for `ensureForProject`. Returns:
 * - a fully-resolved `ProjectSandboxOptions` → proceed with init,
 * - `null` → sandbox is not applicable for this project (disabled, not a git repo, etc.);
 *   `ensureForProject` returns without throwing in that case.
 *
 * Implementations are expected to encapsulate all cross-cutting plumbing (reading
 * project config, image build/version check, mounts/credentials parsing,
 * sandbox network creation, GitHub-token resolution) — keeping SandboxManager
 * itself decoupled from ProjectRegistry, ProjectContextManager, SessionManager, etc.
 */
export type SandboxBootstrap = (projectId: string) => Promise<ProjectSandboxOptions | null>;

export interface SandboxManagerOptions {
	/**
	 * Called by `ensureForProject(projectId)` the first time a project's sandbox
	 * is requested. The wiring for host-side state (registry, config store,
	 * image build, network, credentials) lives in the caller — SandboxManager
	 * just coordinates lifecycle.
	 */
	bootstrap?: SandboxBootstrap;
}

// ── SandboxManager ─────────────────────────────────────────────────────────

export class SandboxManager {
	private sandboxes = new Map<string, ProjectSandbox>();
	private _recoveryListeners: Array<(projectId: string, containerId: string) => void> = [];
	private _healthUnsubscribes = new Map<string, () => void>();
	/**
	 * Dedupes concurrent calls to `ensureForProject(projectId)`: while one init
	 * is in-flight, later callers await the same Promise. On failure the entry
	 * is cleared so the next caller can retry; on success it is left populated
	 * so later calls resolve immediately (idempotent).
	 */
	private _ensureInFlight = new Map<string, Promise<void>>();
	private _bootstrap: SandboxBootstrap | null;

	constructor(opts: SandboxManagerOptions = {}) {
		this._bootstrap = opts.bootstrap ?? null;
	}

	/** Set or replace the bootstrap function post-construction. */
	setBootstrap(bootstrap: SandboxBootstrap | null): void {
		this._bootstrap = bootstrap;
	}

	/** Subscribe to container recovery events across all projects. Returns unsubscribe function. */
	onContainerRecovered(listener: (projectId: string, containerId: string) => void): () => void {
		this._recoveryListeners.push(listener);
		return () => {
			const idx = this._recoveryListeners.indexOf(listener);
			if (idx >= 0) this._recoveryListeners.splice(idx, 1);
		};
	}

	/**
	 * Idempotent lazy per-project init. Safe to call concurrently — in-flight
	 * inits are deduped via a Promise map (see §3.3 of the design). On success,
	 * later calls short-circuit immediately. On failure the in-flight entry is
	 * cleared so the next call can retry, and the error propagates to the caller
	 * that triggered the failed init (callers for other projects are unaffected).
	 *
	 * If the bootstrap returns `null` (sandbox disabled / not a git repo) the
	 * call resolves without registering anything; subsequent calls will retry
	 * the bootstrap in case config has changed.
	 */
	async ensureForProject(projectId: string): Promise<void> {
		// Already fully initialized — fast path.
		const existing = this.sandboxes.get(projectId);
		if (existing && existing.getStatus().status === "ready") return;

		// Join an in-flight init for the same project.
		const inFlight = this._ensureInFlight.get(projectId);
		if (inFlight) return inFlight;

		if (!this._bootstrap) {
			throw new Error(`[sandbox-manager] ensureForProject(${projectId}) called but no bootstrap was provided`);
		}
		const bootstrap = this._bootstrap;

		const p = (async () => {
			const opts = await bootstrap(projectId);
			if (!opts) {
				// Sandbox not applicable (disabled, not a git repo). Not an error.
				return;
			}
			await this.initForProject(projectId, opts);
		})();

		this._ensureInFlight.set(projectId, p);
		try {
			await p;
		} finally {
			// Clear so a subsequent failing call can retry. Ready sandboxes are
			// detected via `sandboxes.get(...).getStatus().status === "ready"`
			// on the fast path above, so we don't need to keep the resolved
			// promise around.
			if (this._ensureInFlight.get(projectId) === p) {
				this._ensureInFlight.delete(projectId);
			}
		}
	}

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

			// Start health monitoring and subscribe to events
			sandbox.startHealthMonitor();
			const unsub = sandbox.onHealthEvent((event: SandboxHealthEvent) => {
				if (event.type === "container-died") {
					console.log(`[sandbox-manager] Container died for project ${projectId}`);
				} else if (event.type === "container-recovered") {
					for (const listener of this._recoveryListeners) {
						try { listener(projectId, event.containerId); } catch { /* ignore */ }
					}
				}
			});
			this._healthUnsubscribes.set(projectId, unsub);
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
		// Stop all health monitors first
		for (const sandbox of this.sandboxes.values()) {
			sandbox.stopHealthMonitor();
		}
		for (const unsub of this._healthUnsubscribes.values()) {
			try { unsub(); } catch { /* ignore */ }
		}
		this._healthUnsubscribes.clear();

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

		sandbox.stopHealthMonitor();
		const unsub = this._healthUnsubscribes.get(projectId);
		if (unsub) { try { unsub(); } catch { /* ignore */ } this._healthUnsubscribes.delete(projectId); }

		await sandbox.destroy();
		this.sandboxes.delete(projectId);
		console.log(`[sandbox-manager] Destroyed sandbox for project ${projectId}`);
	}

	/** Destroy all sandboxes. */
	async destroyAll(): Promise<void> {
		// Clean up health subscriptions
		for (const [, unsub] of this._healthUnsubscribes) {
			unsub();
		}
		this._healthUnsubscribes.clear();

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
