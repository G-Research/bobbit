// src/server/extension-host/service-extension-runtime.ts
//
// Core-owned lifecycle manager for declarative service extensions. No pack code
// ever receives one of these seams or a process handle.

import {
	type ServiceExtensionSpec,
	type ServiceInstancePublicRef,
	type ServiceInstanceRef,
	type ServiceRunMode,
	type ServiceState,
	type ServiceStatus,
	type ServiceStatusDetail,
	validateServiceExtensionSpec,
} from "./service-extension-contract.js";

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
	ref: ServiceInstanceRef;
	spec: ServiceExtensionSpec;
	/** Core-derived worktree root. Available only to a core launch adapter. */
	workingDirectory: string;
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
	lease(ref: ServiceInstanceRef, port: number): Promise<ServicePortLease | undefined>;
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
	resolveDataDir(ref: ServiceInstanceRef, declaredPath: string): string;
	/** Owner-only settings/secret read performed immediately before launch. */
	resolveSettings?(ref: ServiceInstanceRef): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
}

export interface ServiceExtensionRuntime {
	reconcile(ref: ServiceInstanceRef): Promise<void>;
	status(ref: ServiceInstancePublicRef): ServiceStatus | undefined;
	stop(ref?: ServiceInstanceRef): Promise<void>;
}

interface DesiredService {
	ref: ServiceInstanceRef;
	spec: ServiceExtensionSpec;
	fingerprint: string;
}

interface LifecycleFence {
	global: number;
	instance: number;
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

/**
 * The internal lifecycle, queue, lease, and fence key. The canonical root is
 * intentionally included here and intentionally omitted from ServiceStatus.
 */
export function serviceInstanceKey(ref: ServiceInstanceRef): string {
	return [
		ref.projectId,
		ref.component,
		ref.canonicalWorktreeRoot,
		ref.packId,
		ref.serviceId,
		ref.discriminator,
	].join("\0");
}

function fingerprint(spec: ServiceExtensionSpec): string {
	return JSON.stringify({
		id: spec.id, runMode: spec.runMode, readiness: spec.readiness,
		stopGraceMs: spec.stopGraceMs, restart: spec.restart, ports: spec.ports ?? [], dataDir: spec.dataDir,
	});
}

function publicRef(ref: ServiceInstanceRef): ServiceInstancePublicRef {
	return {
		projectId: ref.projectId,
		component: ref.component,
		worktreeKey: ref.worktreeKey,
		packId: ref.packId,
		serviceId: ref.serviceId,
		discriminator: ref.discriminator,
	};
}

function samePublicRef(left: ServiceInstancePublicRef, right: ServiceInstancePublicRef): boolean {
	return left.projectId === right.projectId
		&& left.component === right.component
		&& left.worktreeKey === right.worktreeKey
		&& left.packId === right.packId
		&& left.serviceId === right.serviceId
		&& left.discriminator === right.discriminator;
}

async function releaseLeases(leases: readonly ServicePortLease[]): Promise<void> {
	await Promise.allSettled(leases.map(lease => lease.release()));
}

/**
 * Maintains one core-owned process per full ServiceInstanceRef. Per-instance
 * queues and fences keep linked worktrees, components, and discriminators
 * independent even when they share a project, pack, and declared service ID.
 */
export class ServiceExtensionRuntimeManager implements ServiceExtensionRuntime {
	private readonly desired = new Map<string, DesiredService>();
	private readonly running = new Map<string, RunningService>();
	private readonly statuses = new Map<string, ServiceStatus>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly instanceGenerations = new Map<string, number>();
	private globalGeneration = 0;
	private closed = false;
	private nextGeneration = 0;

	constructor(private readonly deps: ServiceExtensionRuntimeDeps) {}

	async reconcile(ref: ServiceInstanceRef): Promise<void> {
		const key = serviceInstanceKey(ref);
		const fence = this.openReconcileFence(key);
		if (!fence) return;

		let declarations: readonly ActiveServiceExtension[];
		try {
			declarations = await this.deps.listActive(ref.projectId);
		} catch {
			if (!this.isCurrent(fence, key)) return;
			this.desired.delete(key);
			await this.enqueue(key, async () => {
				if (!this.isCurrent(fence, key)) return;
				const running = this.running.get(key);
				if (running) await this.stopRunning(key, running);
				if (this.isCurrent(fence, key)) this.publish(ref, "failed", "configuration-unavailable");
			});
			return;
		}
		if (!this.isCurrent(fence, key)) return;

		let selected: ServiceExtensionSpec | undefined;
		let duplicate = false;
		for (const declaration of declarations) {
			if (declaration.packId !== ref.packId) continue;
			const validated = validateServiceExtensionSpec(declaration.spec);
			if (!validated.ok || validated.value.id !== ref.serviceId) continue;
			if (selected) duplicate = true;
			else selected = validated.value;
		}

		this.desired.delete(key);
		if (selected && !duplicate && this.isAuthorized(ref)) {
			this.desired.set(key, { ref, spec: selected, fingerprint: fingerprint(selected) });
		}
		if (!this.isCurrent(fence, key)) return;

		await this.enqueue(key, async () => {
			if (!this.isCurrent(fence, key)) return;
			const running = this.running.get(key);
			const desired = this.desired.get(key);
			// Re-read the deny-wins grant after waiting for this instance queue.
			if (desired && !this.isAuthorized(ref)) {
				this.desired.delete(key);
				if (running) await this.stopRunning(key, running);
				return;
			}
			if (!desired) {
				if (running) await this.stopRunning(key, running);
				return;
			}
			if (running && running.fingerprint !== desired.fingerprint) {
				await this.stopRunning(key, running);
				if (!this.isCurrent(fence, key)) return;
			}
			if (!this.running.has(key)) await this.start(key, desired, 0, fence);
			else this.running.get(key)!.fence = fence;
		});
	}

	status(ref: ServiceInstancePublicRef): ServiceStatus | undefined {
		const matches = [...this.statuses.values()].filter(status => samePublicRef(status.ref, ref));
		if (matches.length !== 1) return undefined;
		const status = matches[0];
		return { ...status, ref: { ...status.ref } };
	}

	async stop(ref?: ServiceInstanceRef): Promise<void> {
		if (ref === undefined) {
			this.closed = true;
			this.globalGeneration++;
			this.desired.clear();
			await Promise.all([...this.running.keys()].map(key => this.enqueue(key, async () => {
				const running = this.running.get(key);
				if (running) await this.stopRunning(key, running);
			})));
			return;
		}

		const key = serviceInstanceKey(ref);
		this.instanceGenerations.set(key, (this.instanceGenerations.get(key) ?? 0) + 1);
		this.desired.delete(key);
		await this.enqueue(key, async () => {
			const running = this.running.get(key);
			if (running) await this.stopRunning(key, running);
		});
	}

	private openReconcileFence(key: string): LifecycleFence | undefined {
		if (this.closed) return undefined;
		const instance = (this.instanceGenerations.get(key) ?? 0) + 1;
		this.instanceGenerations.set(key, instance);
		return { global: this.globalGeneration, instance };
	}

	private isCurrent(fence: LifecycleFence, key: string): boolean {
		return !this.closed
			&& fence.global === this.globalGeneration
			&& fence.instance === this.instanceGenerations.get(key);
	}

	/** Never cache an allow: revoked authorization must win over awaited work. */
	private isAuthorized(ref: ServiceInstanceRef): boolean {
		try {
			return this.deps.authorize(ref.projectId, { kind: "pack", packId: ref.packId }, "service.manage").allowed === true;
		} catch {
			return false;
		}
	}

	private canRun(fence: LifecycleFence, key: string, ref: ServiceInstanceRef): boolean {
		return this.isCurrent(fence, key) && this.isAuthorized(ref);
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

	private publish(ref: ServiceInstanceRef, state: ServiceState, detail?: ServiceStatusDetail): void {
		this.statuses.set(serviceInstanceKey(ref), {
			ref: publicRef(ref),
			state,
			updatedAt: this.deps.clock.now().toISOString(),
			...(detail === undefined ? {} : { detail }),
		});
	}

	private request(entry: RunningService): ServiceExtensionLaunchRequest {
		return {
			ref: entry.ref,
			spec: entry.spec,
			workingDirectory: entry.ref.canonicalWorktreeRoot,
			...(entry.dataDir === undefined ? {} : { dataDir: entry.dataDir }),
			...(entry.settings === undefined ? {} : { settings: entry.settings }),
		};
	}

	private async start(key: string, desired: DesiredService, restarts: number, fence: LifecycleFence): Promise<void> {
		if (!this.canRun(fence, key, desired.ref)) return;
		const entry: RunningService = { ...desired, generation: ++this.nextGeneration, fence, restarts, stopping: false, leases: [] };
		this.running.set(key, entry);
		this.publish(entry.ref, "starting", "starting");
		try {
			if (this.deps.resolveSettings) entry.settings = await this.deps.resolveSettings(entry.ref);
			if (!this.canRun(fence, key, entry.ref)) return await this.abandonStart(key, entry);
			if (entry.spec.dataDir !== undefined) {
				entry.dataDir = this.deps.resolveDataDir(entry.ref, entry.spec.dataDir);
				await this.deps.filesystem.ensureDirectory(entry.dataDir);
				if (!this.canRun(fence, key, entry.ref)) return await this.abandonStart(key, entry);
			}
			for (const port of entry.spec.ports ?? []) {
				const lease = await this.deps.ports.lease(entry.ref, port);
				if (!this.canRun(fence, key, entry.ref)) {
					if (lease) await releaseLeases([lease]);
					return await this.abandonStart(key, entry);
				}
				if (!lease) return await this.failStart(key, entry, "unhealthy", "port-conflict");
				entry.leases.push(lease);
			}
			if (!this.canRun(fence, key, entry.ref)) return await this.abandonStart(key, entry);
			entry.process = await this.deps.launchers[entry.spec.runMode](this.request(entry));
			if (!this.canRun(fence, key, entry.ref)) return await this.abandonStart(key, entry);
			const generation = entry.generation;
			entry.unsubscribeExit = entry.process.onExit(() => {
				void this.enqueue(key, () => this.processExited(key, entry, generation));
			});
			const deadline = this.deps.clock.now().getTime() + entry.spec.readiness.timeoutMs;
			while (this.running.get(key) === entry && !entry.stopping && this.canRun(fence, key, entry.ref)) {
				const ready = await this.deps.probe(this.request(entry));
				if (!this.canRun(fence, key, entry.ref)) return await this.abandonStart(key, entry);
				if (ready) {
					if (this.running.get(key) === entry && !entry.stopping) this.publish(entry.ref, "ready");
					return;
				}
				const remaining = deadline - this.deps.clock.now().getTime();
				if (remaining <= 0) return await this.failStart(key, entry, "unhealthy", "readiness-timeout");
				await this.deps.clock.sleep(Math.min(READINESS_POLL_MS, remaining));
			}
			if (this.running.get(key) === entry && !entry.stopping) await this.abandonStart(key, entry);
		} catch {
			if (!this.canRun(fence, key, entry.ref)) await this.abandonStart(key, entry);
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
		this.publish(entry.ref, "stopped");
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
		this.publish(entry.ref, state, detail);
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
		this.publish(entry.ref, "stopped");
	}

	private async processExited(key: string, entry: RunningService, generation: number): Promise<void> {
		if (this.running.get(key) !== entry || entry.generation !== generation || entry.stopping) return;
		entry.process = undefined;
		entry.unsubscribeExit = undefined;
		await releaseLeases(entry.leases);
		entry.leases = [];
		this.publish(entry.ref, "failed", "process-exited");
		const desired = this.desired.get(key);
		if (!this.isCurrent(entry.fence, key)
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
