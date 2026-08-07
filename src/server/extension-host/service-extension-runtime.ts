// src/server/extension-host/service-extension-runtime.ts
//
// Core-owned lifecycle manager for declarative service extensions. No pack code
// ever receives one of these seams or a process handle.

import {
	type ServiceExtensionSpec,
	type ServiceRunMode,
	type ServiceState,
	type ServiceStatus,
	type ServiceStatusDetail,
	validateServiceExtensionSpec,
} from "./service-extension-contract.js";

export interface ServiceExtensionIdentity {
	projectId: string;
	packId: string;
	serviceId: string;
}

/** A declaration has already passed active-pack and settings filtering. */
export interface ActiveServiceExtension {
	packId: string;
	spec: ServiceExtensionSpec;
}

export interface ServiceExtensionProcess {
	/** Must terminate the entire adapter-owned process/container invocation. */
	stop(graceMs: number): Promise<void>;
	/** Returns an unsubscribe function. An exit may happen synchronously. */
	onExit(listener: () => void): () => void;
}

export interface ServicePortLease {
	release(): Promise<void>;
}

export interface ServiceExtensionLaunchRequest {
	identity: ServiceExtensionIdentity;
	spec: ServiceExtensionSpec;
	/** Core-resolved owned directory, never a pack-selected absolute path. */
	dataDir?: string;
	/** Runtime-only values, including resolved secrets. This never enters status. */
	settings?: Readonly<Record<string, unknown>>;
}

export type ServiceExtensionLauncher = (request: ServiceExtensionLaunchRequest) => Promise<ServiceExtensionProcess>;

export interface ServiceReadinessProbeRequest extends ServiceExtensionLaunchRequest {}
export type ServiceReadinessProbe = (request: ServiceReadinessProbeRequest) => Promise<boolean>;

export interface ServiceExtensionClock {
	now(): Date;
	sleep(ms: number): Promise<void>;
}

export interface ServiceExtensionFilesystem {
	ensureDirectory(path: string): Promise<void>;
}

export interface ServiceExtensionPortAllocator {
	lease(identity: ServiceExtensionIdentity, port: number): Promise<ServicePortLease | undefined>;
}

/**
 * Structural view of the platform authorization seam. The server supplies the
 * resolver; this runtime never reads durable authorization state itself.
 */
export type ServiceExtensionAuthorizationResolver = (
	projectId: string,
	principal: { kind: "pack"; packId: string },
	capability: "service.manage",
) => { allowed: boolean };

export interface ServiceExtensionRuntimeDeps {
	/** Active declarations only. A thrown error fails closed for this reconcile. */
	listActive(projectId: string): Promise<readonly ActiveServiceExtension[]> | readonly ActiveServiceExtension[];
	/** Required authorization fence for every service lifecycle action. */
	authorize: ServiceExtensionAuthorizationResolver;
	launchers: Readonly<Record<ServiceRunMode, ServiceExtensionLauncher>>;
	probe: ServiceReadinessProbe;
	ports: ServiceExtensionPortAllocator;
	filesystem: ServiceExtensionFilesystem;
	clock: ServiceExtensionClock;
	/** Resolve a declared relative dataDir under a project-owned root. */
	resolveDataDir(identity: ServiceExtensionIdentity, declaredPath: string): string;
	/** Owner-only settings/secret read performed immediately before launch. */
	resolveSettings?(identity: ServiceExtensionIdentity): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
}

export interface ServiceExtensionRuntime {
	reconcile(projectId: string): Promise<void>;
	status(projectId: string, id: string): ServiceStatus | undefined;
	stop(projectId?: string): Promise<void>;
}

interface DesiredService {
	identity: ServiceExtensionIdentity;
	spec: ServiceExtensionSpec;
	fingerprint: string;
}

interface LifecycleFence {
	global: number;
	project: number;
}

interface RunningService extends DesiredService {
	generation: number;
	fence: LifecycleFence;
	restarts: number;
	stopping: boolean;
	process?: ServiceExtensionProcess;
	unsubscribeExit?: () => void;
	leases: ServicePortLease[];
	dataDir?: string;
	settings?: Readonly<Record<string, unknown>>;
}

const READINESS_POLL_MS = 100;

function identityKey(identity: ServiceExtensionIdentity): string {
	return `${identity.projectId}\u0000${identity.packId}\u0000${identity.serviceId}`;
}

function projectKey(projectId: string): string {
	return `${projectId}\u0000`;
}

function fingerprint(spec: ServiceExtensionSpec): string {
	return JSON.stringify({
		id: spec.id, runMode: spec.runMode, readiness: spec.readiness,
		stopGraceMs: spec.stopGraceMs, restart: spec.restart, ports: spec.ports ?? [], dataDir: spec.dataDir,
	});
}

async function releaseLeases(leases: readonly ServicePortLease[]): Promise<void> {
	await Promise.allSettled(leases.map(lease => lease.release()));
}

/**
 * Maintains one core-owned process per `(project, pack, service)` identity.
 * Per-identity queues make process exit/start/stop races generation-safe while
 * allowing independent projects and services to make progress concurrently.
 */
export class ServiceExtensionRuntimeManager implements ServiceExtensionRuntime {
	private readonly desired = new Map<string, DesiredService>();
	private readonly running = new Map<string, RunningService>();
	private readonly statuses = new Map<string, ServiceStatus>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly projectGenerations = new Map<string, number>();
	private globalGeneration = 0;
	private closed = false;
	private nextGeneration = 0;

	constructor(private readonly deps: ServiceExtensionRuntimeDeps) {}

	async reconcile(projectId: string): Promise<void> {
		const fence = this.openReconcileFence(projectId);
		if (!fence) return;

		let declarations: readonly ActiveServiceExtension[];
		try {
			declarations = await this.deps.listActive(projectId);
		} catch {
			if (!this.isCurrent(fence, projectId)) return;
			// A settings/registry read failure never justifies retaining a stale process.
			const stale = [...this.desired.entries()].filter(([key]) => key.startsWith(projectKey(projectId)));
			for (const [key] of stale) this.desired.delete(key);
			await Promise.all(stale.map(([key, desired]) => this.enqueue(key, async () => {
				if (!this.isCurrent(fence, projectId)) return;
				const running = this.running.get(key);
				if (running) await this.stopRunning(key, running);
				if (this.isCurrent(fence, projectId)) this.publish(desired.identity, "failed", "configuration-unavailable");
			})));
			return;
		}
		if (!this.isCurrent(fence, projectId)) return;

		const wanted = new Map<string, DesiredService>();
		for (const declaration of declarations) {
			const validated = validateServiceExtensionSpec(declaration.spec);
			if (!validated.ok) continue; // Registry input is untrusted; a bad declaration never starts.
			const identity = { projectId, packId: declaration.packId, serviceId: validated.value.id };
			// A denied declaration is removed like any inactive declaration, so
			// ordinary reconciliation stops an already-running service.
			if (!this.isAuthorized(identity)) continue;
			const key = identityKey(identity);
			if (wanted.has(key)) continue; // Duplicate active identity is fail-closed.
			wanted.set(key, { identity, spec: validated.value, fingerprint: fingerprint(validated.value) });
		}
		if (!this.isCurrent(fence, projectId)) return;

		const currentKeys = [...this.desired.keys()].filter(key => key.startsWith(projectKey(projectId)));
		for (const key of currentKeys) this.desired.delete(key);
		for (const [key, value] of wanted) this.desired.set(key, value);

		const affected = new Set<string>([
			...currentKeys,
			...wanted.keys(),
			...[...this.running.keys()].filter(key => key.startsWith(projectKey(projectId))),
		]);
		await Promise.all([...affected].map(key => this.enqueue(key, async () => {
			if (!this.isCurrent(fence, projectId)) return;
			const running = this.running.get(key);
			const desired = this.desired.get(key);
			if (!desired) {
				if (running) await this.stopRunning(key, running);
				return;
			}
			if (running && running.fingerprint !== desired.fingerprint) {
				await this.stopRunning(key, running);
				if (!this.isCurrent(fence, projectId)) return;
			}
			if (!this.running.has(key)) await this.start(key, desired, 0, fence);
			else this.running.get(key)!.fence = fence;
		})));
	}

	status(projectId: string, id: string): ServiceStatus | undefined {
		// IDs are pack-local. Status intentionally refuses an ambiguous cross-pack projection.
		const matches = [...this.statuses.entries()]
			.filter(([key, status]) => key.startsWith(projectKey(projectId)) && status.id === id)
			.map(([, status]) => status);
		if (matches.length !== 1) return undefined;
		return { ...matches[0] };
	}

	async stop(projectId?: string): Promise<void> {
		if (projectId === undefined) {
			this.closed = true;
			this.globalGeneration++;
			this.desired.clear();
		} else {
			this.projectGenerations.set(projectId, (this.projectGenerations.get(projectId) ?? 0) + 1);
			for (const key of [...this.desired.keys()]) {
				if (key.startsWith(projectKey(projectId))) this.desired.delete(key);
			}
		}
		const keys = [...this.running.keys()].filter(key => projectId === undefined || key.startsWith(projectKey(projectId)));
		await Promise.all(keys.map(key => this.enqueue(key, async () => {
			const running = this.running.get(key);
			if (running) await this.stopRunning(key, running);
		})));
	}

	private openReconcileFence(projectId: string): LifecycleFence | undefined {
		if (this.closed) return undefined;
		const project = (this.projectGenerations.get(projectId) ?? 0) + 1;
		this.projectGenerations.set(projectId, project);
		return { global: this.globalGeneration, project };
	}

	private isCurrent(fence: LifecycleFence, projectId: string): boolean {
		return !this.closed
			&& fence.global === this.globalGeneration
			&& fence.project === this.projectGenerations.get(projectId);
	}

	/** Never cache an allow: revoked authorization must win over awaited work. */
	private isAuthorized(identity: ServiceExtensionIdentity): boolean {
		try {
			return this.deps.authorize(
				identity.projectId,
				{ kind: "pack", packId: identity.packId },
				"service.manage",
			).allowed === true;
		} catch {
			return false;
		}
	}

	private canRun(fence: LifecycleFence, identity: ServiceExtensionIdentity): boolean {
		return this.isCurrent(fence, identity.projectId) && this.isAuthorized(identity);
	}

	private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
		const prior = this.queues.get(key) ?? Promise.resolve();
		const next = prior.catch(() => undefined).then(operation);
		this.queues.set(key, next);
		void next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		}).catch(() => undefined);
		return next;
	}

	private publish(identity: ServiceExtensionIdentity, state: ServiceState, detail?: ServiceStatusDetail): void {
		this.statuses.set(identityKey(identity), {
			id: identity.serviceId,
			state,
			updatedAt: this.deps.clock.now().toISOString(),
			...(detail === undefined ? {} : { detail }),
		});
	}

	private async start(key: string, desired: DesiredService, restarts: number, fence: LifecycleFence): Promise<void> {
		if (!this.canRun(fence, desired.identity)) return;
		const entry: RunningService = { ...desired, generation: ++this.nextGeneration, fence, restarts, stopping: false, leases: [] };
		this.running.set(key, entry);
		this.publish(entry.identity, "starting", "starting");
		try {
			if (this.deps.resolveSettings) entry.settings = await this.deps.resolveSettings(entry.identity);
			if (!this.canRun(fence, entry.identity)) {
				await this.abandonStart(key, entry);
				return;
			}
			if (entry.spec.dataDir !== undefined) {
				entry.dataDir = this.deps.resolveDataDir(entry.identity, entry.spec.dataDir);
				await this.deps.filesystem.ensureDirectory(entry.dataDir);
				if (!this.canRun(fence, entry.identity)) {
					await this.abandonStart(key, entry);
					return;
				}
			}
			for (const port of entry.spec.ports ?? []) {
				const lease = await this.deps.ports.lease(entry.identity, port);
				if (!this.canRun(fence, entry.identity)) {
					if (lease) await releaseLeases([lease]);
					await this.abandonStart(key, entry);
					return;
				}
				if (!lease) {
					await this.failStart(key, entry, "unhealthy", "port-conflict");
					return;
				}
				entry.leases.push(lease);
			}
			const launch = this.deps.launchers[entry.spec.runMode];
			if (!this.canRun(fence, entry.identity)) {
				await this.abandonStart(key, entry);
				return;
			}
			entry.process = await launch({ identity: entry.identity, spec: entry.spec, ...(entry.dataDir === undefined ? {} : { dataDir: entry.dataDir }), ...(entry.settings === undefined ? {} : { settings: entry.settings }) });
			if (!this.canRun(fence, entry.identity)) {
				await this.abandonStart(key, entry);
				return;
			}
			const generation = entry.generation;
			entry.unsubscribeExit = entry.process.onExit(() => {
				void this.enqueue(key, () => this.processExited(key, entry, generation));
			});
			const deadline = this.deps.clock.now().getTime() + entry.spec.readiness.timeoutMs;
			while (this.running.get(key) === entry && !entry.stopping && this.canRun(fence, entry.identity)) {
				const ready = await this.deps.probe({ identity: entry.identity, spec: entry.spec, ...(entry.dataDir === undefined ? {} : { dataDir: entry.dataDir }), ...(entry.settings === undefined ? {} : { settings: entry.settings }) });
				if (!this.canRun(fence, entry.identity)) {
					await this.abandonStart(key, entry);
					return;
				}
				if (ready) {
					if (this.running.get(key) === entry && !entry.stopping) this.publish(entry.identity, "ready");
					return;
				}
				const remaining = deadline - this.deps.clock.now().getTime();
				if (remaining <= 0) {
					await this.failStart(key, entry, "unhealthy", "readiness-timeout");
					return;
				}
				await this.deps.clock.sleep(Math.min(READINESS_POLL_MS, remaining));
			}
			if (this.running.get(key) === entry && !entry.stopping) await this.abandonStart(key, entry);
		} catch {
			if (!this.canRun(fence, entry.identity)) await this.abandonStart(key, entry);
			else await this.failStart(key, entry, "failed", "configuration-unavailable");
		}
	}

	private async abandonStart(key: string, entry: RunningService): Promise<void> {
		if (this.running.get(key) !== entry) return;
		entry.stopping = true;
		entry.unsubscribeExit?.();
		entry.unsubscribeExit = undefined;
		try { await entry.process?.stop(entry.spec.stopGraceMs); } catch { /* cleanup is best effort */ }
		await releaseLeases(entry.leases);
		entry.leases = [];
		entry.process = undefined;
		if (this.running.get(key) === entry) this.running.delete(key);
		this.publish(entry.identity, "stopped");
	}

	private async failStart(key: string, entry: RunningService, state: ServiceState, detail: ServiceStatusDetail): Promise<void> {
		if (this.running.get(key) !== entry) return;
		entry.stopping = true;
		entry.unsubscribeExit?.();
		entry.unsubscribeExit = undefined;
		try { await entry.process?.stop(entry.spec.stopGraceMs); } catch { /* state is already safe */ }
		await releaseLeases(entry.leases);
		entry.leases = [];
		entry.process = undefined;
		if (this.running.get(key) === entry) this.running.delete(key);
		this.publish(entry.identity, state, detail);
	}

	private async stopRunning(key: string, entry: RunningService): Promise<void> {
		if (this.running.get(key) !== entry) return;
		entry.stopping = true;
		entry.unsubscribeExit?.();
		entry.unsubscribeExit = undefined;
		try { await entry.process?.stop(entry.spec.stopGraceMs); } catch { /* stop must still release resources */ }
		await releaseLeases(entry.leases);
		entry.leases = [];
		if (this.running.get(key) === entry) this.running.delete(key);
		this.publish(entry.identity, "stopped");
	}

	private async processExited(key: string, entry: RunningService, generation: number): Promise<void> {
		if (this.running.get(key) !== entry || entry.generation !== generation || entry.stopping) return;
		entry.process = undefined;
		entry.unsubscribeExit = undefined;
		await releaseLeases(entry.leases);
		entry.leases = [];
		this.publish(entry.identity, "failed", "process-exited");
		const desired = this.desired.get(key);
		if (!this.isCurrent(entry.fence, entry.identity.projectId)
			|| entry.spec.restart !== "on-failure"
			|| entry.restarts >= 1
			|| !desired
			|| desired.fingerprint !== entry.fingerprint) {
			if (this.running.get(key) === entry) this.running.delete(key);
			return;
		}
		if (this.running.get(key) === entry) this.running.delete(key);
		await this.start(key, desired, entry.restarts + 1, entry.fence);
	}
}
