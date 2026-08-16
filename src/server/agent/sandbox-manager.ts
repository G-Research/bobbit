/**
 * SandboxManager — Registry mapping projectId → ProjectSandbox.
 *
 * Coordinates lifecycle of per-project sandbox containers. Each project
 * with `sandbox: "docker"` gets exactly one long-lived container managed
 * by a ProjectSandbox instance.
 */

import { ProjectSandbox } from "./project-sandbox.js";
import type { ProjectSandboxOptions, ContainerState, SandboxHealthEvent } from "./project-sandbox.js";
import { sandboxImageRequirements } from "./sandbox-image-requirements.js";
import type { Clock, CommandRunner } from "../gateway-deps.js";
import { HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID } from "./project-registry.js";

/**
 * Headquarters and the hidden `system` compatibility anchor are data-only /
 * no-worktree / no-git scopes (their cwd is the Headquarters directory, not a
 * git checkout). They must NEVER participate in the per-project Docker sandbox
 * lifecycle: no container, no git clone/mount of the server-run-dir checkout,
 * and no one-off `<projectDir>/.bobbit/{state,config}` layout. This is the
 * single funnel where a `ProjectSandbox` is created/started, so gating here
 * covers every caller (session-setup, session-manager, staff-manager, …).
 */
export function isSandboxExemptProject(projectId: string): boolean {
	return projectId === HEADQUARTERS_PROJECT_ID || projectId === SYSTEM_PROJECT_ID;
}

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

/** Cheap, synchronous desired-image projection used only to skip a ready sandbox's heavyweight bootstrap. */
export type SandboxPlanIdentity = { readonly image: string; readonly fingerprint?: string };
export type SandboxPlanIdentityResolver = (projectId: string) => SandboxPlanIdentity | null;


export interface SandboxManagerOptions {
	/**
	 * Called by `ensureForProject(projectId)` the first time a project's sandbox
	 * is requested. The wiring for host-side state (registry, config store,
	 * image build, network, credentials) lives in the caller — SandboxManager
	 * just coordinates lifecycle.
	 */
	bootstrap?: SandboxBootstrap;
	/** Must avoid Docker, filesystem setup, and other bootstrap work. Null falls back to bootstrap. */
	planIdentity?: SandboxPlanIdentityResolver;
	commandRunner?: CommandRunner;
	clock?: Clock;
	worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string };
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
	/** Applied server-owned image identity for each live project sandbox. */
	private _appliedImagePlans = new Map<string, { image: string; fingerprint?: string }>();
	private _bootstrap: SandboxBootstrap | null;
	private _planIdentity: SandboxPlanIdentityResolver | null;
	private readonly deps: { commandRunner?: CommandRunner; clock?: Clock; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } };

	constructor(opts: SandboxManagerOptions = {}) {
		this._bootstrap = opts.bootstrap ?? null;
		this._planIdentity = opts.planIdentity ?? null;
		this.deps = { commandRunner: opts.commandRunner, clock: opts.clock, worktreeSetupRuntime: opts.worktreeSetupRuntime };
	}

	/** Set or replace the bootstrap function post-construction. */
	setBootstrap(bootstrap: SandboxBootstrap | null): void {
		this._bootstrap = bootstrap;
	}

	/** Set or replace the cheap desired-image projection post-construction. */
	setPlanIdentityResolver(resolver: SandboxPlanIdentityResolver | null): void {
		this._planIdentity = resolver;
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
		if (isSandboxExemptProject(projectId)) return;

		const existing = this.sandboxes.get(projectId);
		// A ready session sandbox can skip bootstrap only when the server-owned
		// image plan is unchanged. Otherwise bootstrap recreates it transactionally.
		if (existing?.getStatus().status === "ready" && this._planIdentity) {
			let desired: SandboxPlanIdentity | null = null;
			try { desired = this._planIdentity(projectId); } catch { /* bootstrap is authoritative */ }
			const applied = this._appliedImagePlans.get(projectId);
			if (desired && applied?.image === desired.image && applied.fingerprint === desired.fingerprint) return;
		}

		const inFlight = this._ensureInFlight.get(projectId);
		if (inFlight) return inFlight;
		if (!this._bootstrap) {
			throw new Error(`[sandbox-manager] ensureForProject(${projectId}) called but no bootstrap was provided`);
		}
		const bootstrap = this._bootstrap;
		const p = (async () => {
			const opts = await bootstrap(projectId);
			if (!opts) return;
			const current = this.sandboxes.get(projectId);
			if (current?.getStatus().status === "ready") {
				const applied = this._appliedImagePlans.get(projectId);
				if (applied?.image === opts.image && applied.fingerprint === opts.sandboxImageFingerprint) return;
				try {
					await current.recreate(opts);
				} catch (error) {
					if (opts.sandboxImageFingerprint) sandboxImageRequirements.recordBuildFailure(projectId, opts.sandboxImageFingerprint);
					throw error;
				}
				this._appliedImagePlans.set(projectId, { image: opts.image, fingerprint: opts.sandboxImageFingerprint });
				return;
			}
			await this.initForProject(projectId, opts);
		})();

		this._ensureInFlight.set(projectId, p);
		try {
			await p;
		} finally {
			if (this._ensureInFlight.get(projectId) === p) this._ensureInFlight.delete(projectId);
		}
	}

	/**
	 * Initialize sandbox for a project. Creates the ProjectSandbox and calls init().
	 * If a sandbox already exists for this project, reconnects to it.
	 */
	async initForProject(projectId: string, opts: ProjectSandboxOptions): Promise<void> {
		// Defensive: Headquarters / hidden `system` scopes must never construct a
		// ProjectSandbox even if a caller bypasses `ensureForProject`.
		if (isSandboxExemptProject(projectId)) {
			throw new Error(`[sandbox-manager] refusing to create a sandbox for exempt project ${projectId} (Headquarters/system are never sandboxed)`);
		}

		// If already tracked, just return — init was already done
		let sandbox = this.sandboxes.get(projectId);
		if (sandbox?.getStatus().status === "ready") return;
		if (!sandbox || sandbox.getStatus().status === "error") {
			sandbox = new ProjectSandbox(opts, this.deps);
			this.sandboxes.set(projectId, sandbox);
		}

		try {
			await sandbox.init();
			this.sandboxes.set(projectId, sandbox);
			this._appliedImagePlans.set(projectId, { image: opts.image, fingerprint: opts.sandboxImageFingerprint });
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

	/**
	 * Rebind immutable models.json file mounts after atomic host publication.
	 * Every tracked sandbox observes every publication, including one currently
	 * remounting or recovering from an error. ProjectSandbox's generation drain
	 * serializes the actual recreations. Wait for all projects before reporting
	 * an aggregate failure so one broken container cannot hide another result.
	 */
	async refreshAgentModelMounts(): Promise<void> {
		const sandboxes = [...this.sandboxes.values()];
		const results = await Promise.allSettled(sandboxes.map((sandbox) => sandbox.refreshAgentModelMount()));
		const failures = results.flatMap((result, index) => result.status === "rejected"
			? [{ projectId: sandboxes[index].getStatus().projectId, reason: result.reason }]
			: []);
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				`Failed to refresh AIGW models mount for project(s): ${failures.map((failure) => failure.projectId).join(", ")}`,
			);
		}
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
		this._appliedImagePlans.delete(projectId);
		console.log(`[sandbox-manager] Destroyed sandbox for project ${projectId}`);
	}

	/** Destroy all sandboxes. */
	async destroyAll(): Promise<void> {
		const destroyPromises = [...this.sandboxes.keys()].map(projectId => this.destroy(projectId).catch(err => {
			console.warn(`[sandbox-manager] Destroy error for project ${projectId}:`, err?.message || err);
		}));
		await Promise.allSettled(destroyPromises);
		this.sandboxes.clear();
		this._healthUnsubscribes.clear();
		this._appliedImagePlans.clear();
	}

	/** Number of tracked sandboxes. */
	get size(): number {
		return this.sandboxes.size;
	}
}
