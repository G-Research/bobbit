import path from "node:path";
import pRetry from "p-retry";
import type { RuntimeContribution } from "../agent/pack-contributions.js";
import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";
import { isSafeServiceImageReference, type ServiceRuntimeManifest } from "./service-manifest.js";
import {
	SERVICE_RUNTIME_STORE_ERROR,
	ServiceRuntimeStore,
	type PersistedServiceRuntime,
	type RuntimeStorageDeclaration,
	type ServiceRuntimeDiagnostic,
	type ServiceRuntimeIdentity,
	type ServiceRuntimeMode,
	type ServiceRuntimeObservedState,
} from "./service-runtime-store.js";
import {
	selectServiceRunner,
	type ServiceRunner,
	type ServiceRunnerIdentity,
	type StartedService,
} from "./service-runners.js";

/** The intentionally mode-free interface injected into service consumers. */
export interface ServiceRuntimeContext {
	endpoint?: string;
	state: ServiceRuntimeObservedState;
	diagnostic?: { code: string; retryAt?: string };
}

/** Public status can also describe a configured external endpoint. External has
 * no generic runner and therefore is never accepted by a control request. */
export type ServiceRuntimeStatusMode = ServiceRuntimeMode | "external";

export interface ServiceRuntimeStatus extends ServiceRuntimeContext {
	identity: ServiceRuntimeIdentity;
	desired: "stopped" | "running";
	mode?: ServiceRuntimeStatusMode;
}

/** The control result retains the exact settings snapshot revision that the
 * supervisor applied. It is separate from the public status wire so callers
 * cannot accidentally replace it with a later EP-7 read. */
export interface ServiceRuntimeControlResult {
	status: ServiceRuntimeStatus;
	settingsRevision: string;
}

export interface ServiceRuntimeControlRequest extends ServiceRuntimeIdentity {
	projectId?: string;
	/** A caller may request a mode, but settings remains the source of truth. */
	mode?: ServiceRuntimeMode;
}

export interface ServiceRuntimeSettings {
	mode: ServiceRuntimeMode;
	revision: string;
	/** Descriptor-declared `setting` environment values only. */
	values: Readonly<Record<string, string | undefined>>;
	/** A canonical, descriptor-owned host path for the declared storage bind. */
	storage?: RuntimeStorageDeclaration;
	/** Validated user-selected OCI ref. It is materialized only for explicit start. */
	imageOverride?: string;
	/** Opaque settings-owner continuity key. The supervisor compares but never interprets it. */
	storageIdentity?: string;
	/**
	 * Secrets resolved alongside `values` and `revision` for this exact explicit
	 * control request. When present, materialization must not re-read the secret
	 * owner: doing so could combine a new credential with old public settings.
	 */
	resolvedSecrets?: Readonly<Record<string, string | undefined>>;
	/** A settings owner may fail closed where a selected backing is not durable. */
	storageContinuity?: "verified" | "unsupported";
}

/** Settings are resolved only for explicit control or durable reconciliation. */
export interface ServiceRuntimeSettingsResolver {
	resolve(input: ServiceRuntimeControlRequest & { contribution: RuntimeContribution }): Promise<ServiceRuntimeSettings> | ServiceRuntimeSettings;
	resolveSecret?(setting: string, input: ServiceRuntimeControlRequest & { contribution: RuntimeContribution }): Promise<string | undefined> | string | undefined;
}

export interface ServiceRuntimeAuthorizer {
	authorize(input: ServiceRuntimeControlRequest & { action: "start" | "stop" | "purge" }): Promise<boolean | void> | boolean | void;
}

export interface ServiceRuntimeClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** Probe receives no env, command output, or secret material. */
export type ServiceRuntimeProbe = (endpoint: string, manifest: ServiceRuntimeManifest) => Promise<boolean>;

export interface ServiceRuntimeLogger {
	warn(message: string, details?: Record<string, unknown>): void;
}

interface MaterializedServiceRuntime {
	environment: Record<string, string>;
	/** Owner-only file path, never its contents, for Compose lifecycle commands. */
	envFile?: string;
	secrets: string[];
	storage?: { hostPath: string; target: string };
}

export interface ServiceRuntimeSupervisorOptions {
	registry: Pick<PackContributionResolver, "getRuntime">;
	store: ServiceRuntimeStore;
	runners: readonly ServiceRunner[];
	authorizer: ServiceRuntimeAuthorizer;
	settings: ServiceRuntimeSettingsResolver;
	serverIdentity: string;
	clock?: ServiceRuntimeClock;
	probe?: ServiceRuntimeProbe;
	logger?: ServiceRuntimeLogger;
}

export class ServiceRuntimeError extends Error {
	constructor(readonly code: string, message = code, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ServiceRuntimeError";
	}
}

const STATUS_INSPECTION_TIMEOUT_MS = 2_000;

function boundedStatusInspection<T>(work: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ServiceRuntimeError("SERVICE_UNAVAILABLE")), STATUS_INSPECTION_TIMEOUT_MS);
		work.then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); },
		);
	});
}

const realClock: ServiceRuntimeClock = {
	now: Date.now,
	// Detached health monitors must not keep a CLI/session alive after all other
	// runtime work has completed.
	sleep: (ms) => new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	}),
};
function identityKey(identity: ServiceRuntimeIdentity): string {
	return `${identity.packId}\u0000${identity.runtimeId}`;
}

function toDiagnostic(error: unknown): ServiceRuntimeDiagnostic {
	const code = error instanceof ServiceRuntimeError
		? error.code
		: error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: "SERVICE_LAUNCH_FAILED";
	if (/AUTH|MANIFEST|SETTING|SECRET|INVALID/.test(code)) return { code: "SERVICE_BLOCKED" };
	if (/DOCKER|UNAVAILABLE/.test(code)) return { code: "SERVICE_UNAVAILABLE" };
	if (/HEALTH|PORT|LAUNCH|STOP/.test(code)) return { code: "SERVICE_DEGRADED" };
	return { code: "SERVICE_DEGRADED" };
}

function stateFromRecord(record: PersistedServiceRuntime): ServiceRuntimeObservedState {
	if (record.desired === "stopped") return "stopped";
	if (record.endpoint) return "ready";
	const code = record.lastDiagnostic?.code;
	if (code === "SERVICE_BLOCKED") return "blocked";
	if (code === "SERVICE_UNAVAILABLE") return "unavailable";
	if (code === "SERVICE_DEGRADED" || code === "SERVICE_DOWN") return "degraded";
	return "starting";
}

function withoutEndpoint(status: ServiceRuntimeStatus): ServiceRuntimeStatus {
	const { endpoint: _endpoint, ...without } = status;
	return without;
}

function recordContext(identity: ServiceRuntimeIdentity, record: PersistedServiceRuntime | undefined): ServiceRuntimeStatus {
	if (!record) return { identity, desired: "stopped", state: "stopped" };
	const state = stateFromRecord(record);
	return {
		identity,
		desired: record.desired,
		mode: record.selectedMode,
		state,
		...(state === "ready" && record.endpoint ? { endpoint: record.endpoint } : {}),
		...(record.lastDiagnostic ? { diagnostic: record.lastDiagnostic } : {}),
	};
}

async function probeOnce(endpoint: string, manifest: ServiceRuntimeManifest): Promise<boolean> {
	const { health } = manifest.endpoint;
	const url = new URL(health.path, `${endpoint}/`).toString();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), health.requestTimeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (response.status !== health.expectedStatus) throw new Error("health probe failed");
		return true;
	} finally {
		clearTimeout(timeout);
	}
}

/** Startup alone consumes the descriptor's full retry budget. */
async function defaultProbe(endpoint: string, manifest: ServiceRuntimeManifest): Promise<boolean> {
	const { health } = manifest.endpoint;
	const retries = Math.max(0, Math.ceil(health.startupTimeoutMs / health.intervalMs) - 1);
	await pRetry(() => probeOnce(endpoint, manifest), {
		retries, minTimeout: health.intervalMs, maxTimeout: health.intervalMs,
		factor: 1, randomize: false, maxRetryTime: health.startupTimeoutMs,
	});
	return true;
}

function asControl(identity: ServiceRuntimeIdentity, request: Partial<ServiceRuntimeControlRequest>): ServiceRuntimeControlRequest {
	return { ...identity, ...(request.projectId === undefined ? {} : { projectId: request.projectId }), ...(request.mode === undefined ? {} : { mode: request.mode }) };
}

/**
 * Sole owner of generic runtime lifecycle. Read APIs below deliberately never
 * call the authorizer, settings, secret owner, runner start, or storage writer.
 */
type StartOperationKind = "start" | "restart";

interface InFlightStartOperation {
	kind: StartOperationKind;
	mode?: ServiceRuntimeMode;
	promise: Promise<ServiceRuntimeControlResult>;
}

export class ServiceRuntimeSupervisor {
	private readonly inFlight = new Map<string, InFlightStartOperation>();
	private readonly lifecycle = new Map<string, Promise<void>>();
	private readonly restartTokens = new Map<string, number>();
	/** Cancels detached periodic health work without letting reads schedule it. */
	private readonly healthTokens = new Map<string, number>();

	constructor(private readonly options: ServiceRuntimeSupervisorOptions) {}

	async context(identity: ServiceRuntimeIdentity, projectId?: string): Promise<ServiceRuntimeContext> {
		const status = await this.status(identity, projectId);
		return status.diagnostic
			? { state: status.state, ...(status.endpoint ? { endpoint: status.endpoint } : {}), diagnostic: status.diagnostic }
			: { state: status.state, ...(status.endpoint ? { endpoint: status.endpoint } : {}) };
	}

	/** Read-only: it only loads persisted state and performs an adapter inspection. */
	async status(identity: ServiceRuntimeIdentity, projectId?: string): Promise<ServiceRuntimeStatus> {
		let record: PersistedServiceRuntime | undefined;
		try { record = await this.options.store.load(identity); }
		catch (error) {
			this.options.logger?.warn("service runtime state could not be read", { code: toDiagnostic(error).code });
			return { identity, desired: "stopped", state: "unavailable", diagnostic: { code: SERVICE_RUNTIME_STORE_ERROR } };
		}
		const base = recordContext(identity, record);
		if (!record || record.desired !== "running") return base;
		if (!record.runnerIdentity) {
			return record.endpoint
				? { ...withoutEndpoint(base), state: "degraded", diagnostic: { code: "SERVICE_DOWN" } }
				: base;
		}
		const contribution = this.options.registry.getRuntime(projectId, identity.packId, identity.runtimeId);
		// A persisted endpoint is never authority to use a removed or disabled
		// contribution. Keep the durable ownership record for a pre-invalidation
		// cleanup retry, but fail closed for every status/context reader.
		if (!contribution) {
			return {
				...withoutEndpoint(base),
				state: "unavailable",
				diagnostic: { code: "SERVICE_RUNTIME_NOT_FOUND" },
			};
		}
		try {
			const runner = selectServiceRunner(this.options.runners, record.runnerIdentity.kind);
			const inspected = await boundedStatusInspection(runner.inspect(await this.inspectInput(identity, contribution, record.runnerIdentity)));
			if (!inspected) {
				return { ...withoutEndpoint(base), state: "degraded", diagnostic: { code: "SERVICE_DOWN" } };
			}
			// Never surface an inspected endpoint that was not durably committed ready.
			return base.state === "ready" ? base : { ...base, state: "starting" };
		} catch (error) {
			return { ...withoutEndpoint(base), state: "unavailable", diagnostic: toDiagnostic(error) };
		}
	}

	async diagnostics(identity: ServiceRuntimeIdentity): Promise<string | undefined> {
		return this.options.store.readLog(identity);
	}

	start(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeStatus> {
		return this.startWithResult(request).then(result => result.status);
	}

	/** Resolves and applies one settings-owner snapshot for explicit control. */
	startWithResult(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeControlResult> {
		// Authorization is intentionally outside the shared in-flight operation:
		// every public caller is checked before it can observe another caller's
		// endpoint or status. doStart rechecks the live grant when queued work applies.
		return Promise.resolve()
			.then(() => this.authorize(request, "start"))
			.then(() => this.startAuthorized(request));
	}

	private startAuthorized(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeControlResult> {
		return this.enqueueStart(request, "start", () => this.doStart(request, false));
	}

	/**
	 * Restart retains the established stop-then-start lifecycle. It resolves one
	 * immutable settings-owner snapshot, preflights continuity before stopping,
	 * then applies that same snapshot without a second settings read.
	 */
	restart(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeStatus> {
		return this.restartWithResult(request).then(result => result.status);
	}

	restartWithResult(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeControlResult> {
		return Promise.resolve()
			.then(() => this.authorize(request, "start"))
			.then(() => this.enqueueStart(request, "restart", () => this.doRestart(request)));
	}

	private enqueueStart(
		request: ServiceRuntimeControlRequest,
		kind: StartOperationKind,
		operation: () => Promise<ServiceRuntimeControlResult>,
	): Promise<ServiceRuntimeControlResult> {
		const key = identityKey(request);
		const prior = this.inFlight.get(key);
		if (prior) {
			// `restart` must never inherit a plain start's result: its contract is a
			// stop followed by a fresh start. Identical control intents may share the
			// in-flight lifecycle, retaining start deduplication and mode conflicts.
			if (prior.kind !== kind) return Promise.reject(new ServiceRuntimeError("SERVICE_START_CONFLICT"));
			if (prior.mode === request.mode || prior.mode === undefined || request.mode === undefined) return prior.promise;
			return Promise.reject(new ServiceRuntimeError("SERVICE_START_CONFLICT"));
		}
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		const promise = this.enqueueLifecycle(identity, operation);
		this.inFlight.set(key, { kind, mode: request.mode, promise });
		void promise.finally(() => {
			if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
		}).catch(() => undefined);
		return promise;
	}

	private async doRestart(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeControlResult> {
		// The queued restart rechecks the live start grant before resolving settings
		// or touching the old resource. doStop and doStart retain their own live
		// action fences as they apply their respective lifecycle changes.
		await this.authorize(request, "start");
		const contribution = this.requireContribution(request);
		const settings = this.immutableSettingsSnapshot(await this.resolveControlSettings(request, contribution));
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		this.assertStorageContinuity(await this.options.store.load(identity), settings);
		await this.doStop(request);
		return this.doStart(request, false, false, settings);
	}

	stop(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeStatus> {
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		return this.enqueueLifecycle(identity, () => this.doStop(request));
	}

	/**
	 * Removes only the runner-owned process/container/Compose project while the
	 * old descriptor is still resolvable. This is intentionally distinct from
	 * purge: it retains the durable record, environment artifact, generated
	 * secrets, and any declared/named storage for diagnostics and retry.
	 *
	 * Marketplace lifecycle code must call this before invalidating a runtime
	 * contribution; otherwise the descriptor needed to prove runner ownership is
	 * no longer available and cleanup cannot be performed safely.
	 */
	removeOwnedResource(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeStatus> {
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		return this.enqueueLifecycle(identity, () => this.doRemoveOwnedResource(request));
	}

	purge(request: ServiceRuntimeControlRequest & { confirmation: ServiceRuntimeIdentity }): Promise<void> {
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		return this.enqueueLifecycle(identity, () => this.doPurge(request));
	}

	private async doStop(request: ServiceRuntimeControlRequest, alreadyAuthorized = false): Promise<ServiceRuntimeStatus> {
		if (!alreadyAuthorized) await this.authorize(request, "stop");
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		// A denied control request must leave detached restart/health work alone.
		this.cancelRestart(identity);
		this.cancelHealthMonitor(identity);
		const old = await this.options.store.load(identity);
		if (!old) return recordContext(identity, undefined);
		// Persist stopped intent and clear the endpoint before teardown, but retain
		// ownership until removal succeeds. It is needed to retry a failed stop or
		// to reconstruct cleanup after a process restart.
		const stopped = this.nextRecord(old, { desired: "stopped", endpoint: undefined, lastDiagnostic: undefined, restartAttempts: [] });
		await this.options.store.replace(identity, stopped);
		if (!old.runnerIdentity) return recordContext(identity, stopped);
		const contribution = this.requireContribution(request);
		try {
			const runner = selectServiceRunner(this.options.runners, old.runnerIdentity.kind);
			await runner.stop(await this.controlInput(identity, contribution, old.runnerIdentity));
			return recordContext(identity, stopped);
		} catch (error) {
			const failed = this.nextRecord(stopped, { lastDiagnostic: toDiagnostic(error) });
			try { await this.options.store.replace(identity, failed); }
			catch (persistError) { this.options.logger?.warn("service runtime stop failure could not be recorded", { code: toDiagnostic(persistError).code }); }
			this.options.logger?.warn("service runtime stop failed", { code: toDiagnostic(error).code });
			throw new ServiceRuntimeError(toDiagnostic(error).code, "service runtime stop failed", { cause: error });
		}
	}

	private async doRemoveOwnedResource(request: ServiceRuntimeControlRequest): Promise<ServiceRuntimeStatus> {
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		// Resolve the contribution before changing marketplace state. This also
		// prevents a stale cleanup request from operating on an unrelated runner.
		const contribution = this.requireContribution(request);
		const old = await this.options.store.load(identity);
		if (!old) return recordContext(identity, undefined);

		// Authorization is deliberately reread at both mutation boundaries: a
		// grant revoked while this cleanup was queued must prevent the persistent
		// state change and the subsequent runner side effect.
		await this.authorize(request, "stop");
		this.cancelRestart(identity);
		this.cancelHealthMonitor(identity);
		const stopped = this.nextRecord(old, {
			desired: "stopped",
			endpoint: undefined,
			lastDiagnostic: undefined,
			restartAttempts: [],
		});
		await this.options.store.replace(identity, stopped);
		if (!old.runnerIdentity) return recordContext(identity, stopped);

		try {
			const runner = selectServiceRunner(this.options.runners, old.runnerIdentity.kind);
			const input = await this.controlInput(identity, contribution, old.runnerIdentity);
			await this.authorize(request, "stop");
			await runner.remove(input);
			const removed = this.nextRecord(stopped, { runnerIdentity: undefined, lastDiagnostic: undefined });
			await this.options.store.replace(identity, removed);
			return recordContext(identity, removed);
		} catch (error) {
			const failed = this.nextRecord(stopped, { lastDiagnostic: toDiagnostic(error) });
			try { await this.options.store.replace(identity, failed); }
			catch (persistError) { this.options.logger?.warn("service runtime cleanup failure could not be recorded", { code: toDiagnostic(persistError).code }); }
			this.options.logger?.warn("service runtime cleanup failed", { code: toDiagnostic(error).code });
			throw new ServiceRuntimeError(toDiagnostic(error).code, "service runtime cleanup failed", { cause: error });
		}
	}

	private async doPurge(request: ServiceRuntimeControlRequest & { confirmation: ServiceRuntimeIdentity }): Promise<void> {
		await this.authorize(request, "purge");
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		// A denied purge must not suppress an independently authorized restart.
		this.cancelRestart(identity);
		this.cancelHealthMonitor(identity);
		const contribution = this.requireContribution(request);
		const settings = await this.options.settings.resolve({ ...request, contribution });
		const old = await this.options.store.load(identity);
		const generatedSecretNames = Object.values(contribution.manifest.environment)
			.flatMap((source) => "generatedSecret" in source ? [source.generatedSecret] : []);
		await this.options.store.purge(identity, {
			confirmation: request.confirmation,
			storage: contribution.manifest.storage ? settings.storage : undefined,
			generatedSecretNames,
			stop: async () => {
				await this.doStop(request, true);
				if (!old?.runnerIdentity) return;
				try {
					const runner = selectServiceRunner(this.options.runners, old.runnerIdentity.kind);
					await runner.remove(await this.controlInput(identity, contribution, old.runnerIdentity));
				} catch (error) {
					// purge leaves its durable stopped record intact when the resource
					// cannot be removed, including its runner identity for retry.
					const current = await this.options.store.load(identity);
					if (current) await this.options.store.replace(identity, this.nextRecord(current, { lastDiagnostic: toDiagnostic(error) }));
					throw error;
				}
			},
		});
	}

	/** Startup-only reconciliation. It never starts Docker/Compose resources. */
	async reconcile(projectId?: string): Promise<ServiceRuntimeStatus[]> {
		const records = await this.options.store.list();
		const results: ServiceRuntimeStatus[] = [];
		for (const { identity, record } of records) {
			if (record.desired !== "running") { results.push(recordContext(identity, record)); continue; }
			if (record.selectedMode === "local") {
				// Child PIDs cannot survive a gateway restart. Never reuse a durable
				// local endpoint/identity during reconciliation, even if an adapter
				// happens to report a matching in-memory resource.
				try {
					const request = asControl(identity, { projectId, mode: "local" });
					results.push((await this.enqueueLifecycle(identity, () => this.doStart(request, false, true))).status);
				} catch { results.push(await this.status(identity, projectId)); }
				continue;
			}
			// Docker/Compose may have survived the server, therefore inspect only.
			results.push(await this.status(identity, projectId));
		}
		return results;
	}

	private async doStart(
		request: ServiceRuntimeControlRequest,
		alreadyAuthorized: boolean,
		forceFresh = false,
		settingsSnapshot?: ServiceRuntimeSettings,
	): Promise<ServiceRuntimeControlResult> {
		const identity = this.options.store.identity(request.packId, request.runtimeId);
		try {
			if (!alreadyAuthorized) await this.authorize(request, "start");
			const contribution = this.requireContribution(request);
			const settings = settingsSnapshot ?? this.immutableSettingsSnapshot(await this.resolveControlSettings(request, contribution));
			const prior = await this.options.store.load(identity);
			// An unsupported backing may keep serving its exact already-ready
			// resource, but it must fail closed before any start path could remove
			// and recreate it. Inspection is read-only and does not resolve secrets.
			if (prior && settings.storageContinuity === "unsupported") {
				if (!forceFresh && await this.isReusableReady(identity, contribution, prior, settings)) {
					this.startHealthMonitor(identity, this.restartRequest(request), contribution);
					return { status: recordContext(identity, prior), settingsRevision: settings.revision };
				}
				throw new ServiceRuntimeError("SERVICE_CONTINUITY_REQUIRED");
			}
			this.assertStorageContinuity(prior, settings);
			// A durable endpoint is only reusable when it names the current settings
			// revision and the adapter proves that exact resource is still present.
			if (!forceFresh && await this.isReusableReady(identity, contribution, prior, settings)) {
				this.startHealthMonitor(identity, this.restartRequest(request), contribution);
				return { status: recordContext(identity, prior!), settingsRevision: settings.revision };
			}
			this.cancelHealthMonitor(identity);
			// Settings resolution and ready-resource inspection are asynchronous. The
			// live grant is therefore read again at the application boundary, directly
			// before the first durable desired-state mutation.
			await this.authorize(request, "start");
			// Keep a prior ownership identity durable until its resource has actually
			// been removed. A replacement must never launch over an unremoved stale
			// resource, even though desired-running was committed first.
			let desired = this.nextRecord(prior, {
				desired: "running", selectedMode: settings.mode, settingsRevision: settings.revision,
				storageIdentity: settings.storageIdentity,
				endpoint: undefined, runnerIdentity: prior?.runnerIdentity, lastDiagnostic: undefined,
			});
			await this.options.store.replace(identity, desired);
			let materialized: MaterializedServiceRuntime | undefined;
			let runner: ServiceRunner | undefined;
			let started: StartedService | undefined;
			try {
				if (prior?.runnerIdentity) {
					const staleRunner = selectServiceRunner(this.options.runners, prior.runnerIdentity.kind);
					const staleInput = await this.controlInput(identity, contribution, prior.runnerIdentity);
					await this.authorize(request, "start");
					try { await staleRunner.remove(staleInput); }
					catch (error) {
						return {
							status: await this.failStart(identity, desired, contribution, request, error, undefined, false),
							settingsRevision: settings.revision,
						};
					}
					desired = this.nextRecord(desired, { runnerIdentity: undefined });
					await this.options.store.replace(identity, desired);
				}
				// Secret generation/resolution and environment persistence are mutations.
				// Do not enter that materialization boundary on a revoked live grant.
				await this.authorize(request, "start");
				materialized = await this.materialize(identity, request, contribution, settings);
				runner = selectServiceRunner(this.options.runners, settings.mode);
				// Materialization awaits secret/storage-owner work, so fence the actual
				// launch separately. Ownership persistence below deliberately has no
				// intervening authorization await: a started resource is always recorded.
				await this.authorize(request, "start");
				started = await runner.start({
					manifest: contribution.manifest, mode: settings.mode, packRoot: contribution.packRoot, descriptorDir: path.dirname(contribution.sourceFile),
					serverIdentity: this.options.serverIdentity, serviceIdentity: identityKey(identity), packId: identity.packId,
					environment: materialized.environment, ...(materialized.envFile ? { envFile: materialized.envFile } : {}), storage: materialized.storage,
					...(settings.imageOverride ? { imageOverride: settings.imageOverride } : {}), redactions: materialized.secrets,
					onOutput: (output) => { void this.options.store.writeLog(identity, output, materialized!.secrets).catch(() => undefined); },
				});
				// A running resource is durably owned before readiness can fail.
				desired = this.nextRecord(desired, { runnerIdentity: started.runnerIdentity });
				await this.options.store.replace(identity, desired);
				await this.waitReady(started.endpoint, contribution.manifest);
				const ready = this.nextRecord(desired, { endpoint: started.endpoint, lastDiagnostic: undefined });
				await this.options.store.replace(identity, ready);
				this.startHealthMonitor(identity, this.restartRequest(request), contribution);
				return { status: recordContext(identity, ready), settingsRevision: settings.revision };
			} catch (error) {
				return {
					status: await this.failStart(identity, desired, contribution, request, error, started && runner
						? async () => runner!.remove(await this.controlInput(identity, contribution, started!.runnerIdentity, materialized?.secrets))
						: undefined),
					settingsRevision: settings.revision,
				};
			}
		} catch (error) {
			if (error instanceof ServiceRuntimeError && /AUTH|MANIFEST|MODE|SETTING|SECRET|CONTINUITY/.test(error.code)) throw error;
			throw new ServiceRuntimeError(toDiagnostic(error).code, "service runtime start failed", { cause: error });
		}
	}

	private async failStart(
		identity: ServiceRuntimeIdentity,
		desired: PersistedServiceRuntime,
		contribution: RuntimeContribution,
		request: ServiceRuntimeControlRequest,
		error: unknown,
		afterPersist?: () => Promise<void>,
		restartAllowed = true,
	): Promise<ServiceRuntimeStatus> {
		this.cancelHealthMonitor(identity);
		const diagnostic = error instanceof ServiceRuntimeError && error.code === "SERVICE_DOWN"
			? { code: "SERVICE_DOWN" }
			: toDiagnostic(error);
		const now = this.clock.now();
		const restart = contribution.manifest.lifecycle.restart;
		const attempts = desired.restartAttempts.filter((at) => at >= now - restart.windowMs);
		const willRestart = restartAllowed && desired.desired === "running" && restart.policy === "on-failure" && attempts.length < restart.maxAttempts;
		let delay: number | undefined;
		if (willRestart) {
			attempts.push(now);
			delay = Math.min(restart.maxBackoffMs, restart.initialBackoffMs * (2 ** (attempts.length - 1)));
			diagnostic.retryAt = new Date(now + delay).toISOString();
		}
		// Preserve the identity in the degraded record until cleanup proves the
		// owned resource is gone. This makes failed teardown recoverable.
		const degraded = this.nextRecord(desired, { endpoint: undefined, restartAttempts: attempts, lastDiagnostic: diagnostic });
		try { await this.options.store.replace(identity, degraded); }
		catch (persistError) {
			if (afterPersist) await afterPersist().catch((cleanupError) => this.options.logger?.warn("service runtime failed cleanup", { code: toDiagnostic(cleanupError).code }));
			throw persistError;
		}
		let finalRecord = degraded;
		if (afterPersist) {
			try {
				await afterPersist();
				if (degraded.runnerIdentity) {
					finalRecord = this.nextRecord(degraded, { runnerIdentity: undefined });
					await this.options.store.replace(identity, finalRecord);
				}
			} catch (cleanupError) {
				this.options.logger?.warn("service runtime failed cleanup", { code: toDiagnostic(cleanupError).code });
				// Do not schedule a replacement while the old resource may exist.
				return recordContext(identity, degraded);
			}
		}
		if (delay !== undefined) this.scheduleRestart(identity, request, delay);
		return recordContext(identity, finalRecord);
	}

	private async resolveControlSettings(request: ServiceRuntimeControlRequest, contribution: RuntimeContribution): Promise<ServiceRuntimeSettings> {
		const settings = await this.options.settings.resolve({ ...request, contribution });
		if (settings.imageOverride !== undefined && !isSafeServiceImageReference(settings.imageOverride)) throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
		if (request.mode && request.mode !== settings.mode) throw new ServiceRuntimeError("SERVICE_MODE_CONFLICT");
		return settings;
	}

	private immutableSettingsSnapshot(settings: ServiceRuntimeSettings): ServiceRuntimeSettings {
		return Object.freeze({
			...settings,
			values: Object.freeze({ ...settings.values }),
			...(settings.resolvedSecrets ? { resolvedSecrets: Object.freeze({ ...settings.resolvedSecrets }) } : {}),
			...(settings.storage ? { storage: Object.freeze({ ...settings.storage }) } : {}),
		});
	}

	private assertStorageContinuity(prior: PersistedServiceRuntime | undefined, settings: ServiceRuntimeSettings): void {
		// Both sides are optional to preserve generic runtimes that do not own a
		// continuity key. A legacy record without one is safely blocked if its
		// settings owner now resolves one, rather than guessing that an unknown
		// existing bank can be replaced. An explicitly unsupported backing must
		// never be torn down/replaced as though it preserved durable state.
		if (prior && (settings.storageContinuity === "unsupported" || prior.storageIdentity !== settings.storageIdentity)) {
			throw new ServiceRuntimeError("SERVICE_CONTINUITY_REQUIRED");
		}
	}

	private async isReusableReady(
		identity: ServiceRuntimeIdentity,
		contribution: RuntimeContribution,
		prior: PersistedServiceRuntime | undefined,
		settings: ServiceRuntimeSettings,
	): Promise<boolean> {
		if (!prior?.endpoint || !prior.runnerIdentity || prior.desired !== "running"
			|| prior.selectedMode !== settings.mode || prior.settingsRevision !== settings.revision) return false;
		try {
			const runner = selectServiceRunner(this.options.runners, prior.runnerIdentity.kind);
			const inspected = await runner.inspect(await this.inspectInput(identity, contribution, prior.runnerIdentity));
			return !!inspected && inspected.endpoint === prior.endpoint;
		} catch (error) {
			this.options.logger?.warn("service runtime ready reuse could not be verified", { code: toDiagnostic(error).code });
			return false;
		}
	}

	private startHealthMonitor(identity: ServiceRuntimeIdentity, request: ServiceRuntimeControlRequest, contribution: RuntimeContribution): void {
		const key = identityKey(identity);
		const token = (this.healthTokens.get(key) ?? 0) + 1;
		this.healthTokens.set(key, token);
		this.scheduleHealthCheck(identity, request, contribution, token);
	}

	private scheduleHealthCheck(identity: ServiceRuntimeIdentity, request: ServiceRuntimeControlRequest, contribution: RuntimeContribution, token: number): void {
		void (async () => {
			await this.clock.sleep(contribution.manifest.endpoint.health.intervalMs);
			if (!this.healthMonitorActive(identity, token)) return;
			const healthy = await this.enqueueLifecycle(identity, async () => {
				if (!this.healthMonitorActive(identity, token)) return false;
				return this.checkHealth(identity, request, contribution);
			});
			if (healthy && this.healthMonitorActive(identity, token)) {
				this.scheduleHealthCheck(identity, request, contribution, token);
			}
		})().catch((error) => this.options.logger?.warn("service runtime health monitor failed", { code: toDiagnostic(error).code }));
	}

	private async checkHealth(identity: ServiceRuntimeIdentity, request: ServiceRuntimeControlRequest, contribution: RuntimeContribution): Promise<boolean> {
		let record: PersistedServiceRuntime | undefined;
		try { record = await this.options.store.load(identity); }
		catch (error) {
			this.options.logger?.warn("service runtime health state could not be read", { code: toDiagnostic(error).code });
			return false;
		}
		if (record?.desired !== "running" || !record.endpoint || !record.runnerIdentity) return false;
		try {
			const runner = selectServiceRunner(this.options.runners, record.runnerIdentity.kind);
			const inspected = await runner.inspect(await this.inspectInput(identity, contribution, record.runnerIdentity));
			if (!inspected || inspected.endpoint !== record.endpoint) {
				throw new ServiceRuntimeError("SERVICE_DOWN");
			}
			if (!(await this.livenessProbe(record.endpoint, contribution.manifest))) throw new ServiceRuntimeError("SERVICE_HEALTH_TIMEOUT");
			return true;
		} catch (error) {
			await this.failStart(identity, record, contribution, request, error, async () => {
				const runner = selectServiceRunner(this.options.runners, record.runnerIdentity!.kind);
				await runner.remove(await this.controlInput(identity, contribution, record.runnerIdentity!));
			});
			return false;
		}
	}

	private async materialize(identity: ServiceRuntimeIdentity, request: ServiceRuntimeControlRequest, contribution: RuntimeContribution, settings: ServiceRuntimeSettings): Promise<MaterializedServiceRuntime> {
		const environment: Record<string, string> = {};
		const secrets: string[] = [];
		for (const [name, source] of Object.entries(contribution.manifest.environment)) {
			if ("value" in source) environment[name] = source.value;
			else if ("endpointPort" in source) environment[name] = String(contribution.manifest.endpoint.servicePort);
			else if ("setting" in source) {
				const value = settings.values[source.setting];
				if (typeof value !== "string") throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
				environment[name] = value;
			} else if ("generatedSecret" in source) {
				const value = await this.options.store.getOrCreateGeneratedSecret(identity, source.generatedSecret);
				environment[name] = value; secrets.push(value);
			} else {
				// A resolver-provided map is an immutable EP-7 snapshot. Never fall
				// through to resolveSecret when it is present: a concurrent settings
				// save must not splice new secret bytes into old public settings.
				const value = settings.resolvedSecrets
					? settings.resolvedSecrets[source.secret]
					: this.options.settings.resolveSecret
						? await this.options.settings.resolveSecret(source.secret, { ...request, contribution })
						: await this.options.store.resolveUserSecret(source.secret);
				if (!value) {
					if (source.optional === true) continue;
					throw new ServiceRuntimeError("SERVICE_SECRET_UNAVAILABLE");
				}
				environment[name] = value; secrets.push(value);
			}
		}
		await this.options.store.writeEnvironment(identity, environment);
		// This obtains only an owner-validated filename; it never reads the
		// artifact or resolves settings/secrets on later control/read paths.
		const envFile = settings.mode === "compose" ? await this.runtimeEnvironmentFile(identity) : undefined;
		if (contribution.manifest.storage && !settings.storage) {
			throw new ServiceRuntimeError("SERVICE_SETTING_UNAVAILABLE");
		}
		const storage = contribution.manifest.storage && settings.storage
			? { hostPath: settings.storage.dataPath, target: contribution.manifest.storage.target }
			: undefined;
		return { environment, envFile, secrets, ...(storage ? { storage } : {}) };
	}

	/** Periodic liveness has one request-sized budget, never startup's retry budget. */
	private async livenessProbe(endpoint: string, manifest: ServiceRuntimeManifest): Promise<boolean> {
		return this.options.probe ? this.options.probe(endpoint, manifest) : probeOnce(endpoint, manifest);
	}

	private async waitReady(endpoint: string, manifest: ServiceRuntimeManifest): Promise<void> {
		// The production probe owns exactly one p-retry startup budget. Injected
		// probes retain the fake-clock loop needed by deterministic supervisor tests.
		if (!this.options.probe) {
			await defaultProbe(endpoint, manifest);
			return;
		}
		const deadline = this.clock.now() + manifest.endpoint.health.startupTimeoutMs;
		for (;;) {
			try { if (await this.probe(endpoint, manifest)) return; } catch { /* bounded retry below */ }
			if (this.clock.now() >= deadline) throw new ServiceRuntimeError("SERVICE_HEALTH_TIMEOUT");
			await this.clock.sleep(manifest.endpoint.health.intervalMs);
		}
	}

	private enqueueLifecycle<T>(identity: ServiceRuntimeIdentity, operation: () => Promise<T>): Promise<T> {
		const key = identityKey(identity);
		const previous = this.lifecycle.get(key) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const settled = result.then(() => undefined, () => undefined);
		this.lifecycle.set(key, settled);
		void settled.finally(() => {
			if (this.lifecycle.get(key) === settled) this.lifecycle.delete(key);
		});
		return result;
	}

	private scheduleRestart(identity: ServiceRuntimeIdentity, request: ServiceRuntimeControlRequest, delay: number): void {
		const key = identityKey(identity);
		const token = (this.restartTokens.get(key) ?? 0) + 1;
		this.restartTokens.set(key, token);
		void (async () => {
			await this.clock.sleep(delay);
			if (this.restartTokens.get(key) !== token) return;
			const record = await this.options.store.load(identity).catch(() => undefined);
			if (record?.desired !== "running") return;
			// A restart is detached from the caller that originally opted in. Resolve
			// the live grant again only when its queued lifecycle work applies.
			try { await this.enqueueLifecycle(identity, () => this.doStart(this.restartRequest(request), false)); }
			catch (error) { this.options.logger?.warn("service runtime restart failed", { code: toDiagnostic(error).code }); }
		})();
	}

	private cancelRestart(identity: ServiceRuntimeIdentity): void {
		const key = identityKey(identity);
		this.restartTokens.set(key, (this.restartTokens.get(key) ?? 0) + 1);
	}

	private cancelHealthMonitor(identity: ServiceRuntimeIdentity): void {
		const key = identityKey(identity);
		this.healthTokens.set(key, (this.healthTokens.get(key) ?? 0) + 1);
	}

	private healthMonitorActive(identity: ServiceRuntimeIdentity, token: number): boolean {
		return this.healthTokens.get(identityKey(identity)) === token;
	}

	/** Restart resolution remains settings-owned instead of pinning an old mode. */
	private restartRequest(request: ServiceRuntimeControlRequest): ServiceRuntimeControlRequest {
		return asControl({ packId: request.packId, runtimeId: request.runtimeId }, { projectId: request.projectId });
	}

	private requireContribution(request: ServiceRuntimeControlRequest): RuntimeContribution {
		const contribution = this.options.registry.getRuntime(request.projectId, request.packId, request.runtimeId);
		if (!contribution) throw new ServiceRuntimeError("SERVICE_RUNTIME_NOT_FOUND");
		return contribution;
	}

	private async authorize(request: ServiceRuntimeControlRequest, action: "start" | "stop" | "purge"): Promise<void> {
		const allowed = await this.options.authorizer.authorize({ ...request, action });
		if (allowed === false) throw new ServiceRuntimeError("SERVICE_AUTHORIZATION_DENIED");
	}

	private nextRecord(previous: PersistedServiceRuntime | undefined, patch: Partial<PersistedServiceRuntime>): PersistedServiceRuntime {
		return {
			version: 1, serverIdentity: this.options.serverIdentity, desired: "stopped", selectedMode: "local", settingsRevision: "unknown",
			restartAttempts: [],
			...previous, ...patch,
			updatedAt: new Date(this.clock.now()).toISOString(),
		};
	}

	private async inspectInput(identity: ServiceRuntimeIdentity, contribution: RuntimeContribution, runnerIdentity: ServiceRunnerIdentity) {
		const envFile = runnerIdentity.kind === "compose" ? await this.runtimeEnvironmentFile(identity) : undefined;
		return {
			manifest: contribution.manifest, packRoot: contribution.packRoot, descriptorDir: path.dirname(contribution.sourceFile),
			serverIdentity: this.options.serverIdentity, serviceIdentity: identityKey(identity), packId: identity.packId,
			...(envFile ? { envFile } : {}), runnerIdentity,
		};
	}

	private async controlInput(identity: ServiceRuntimeIdentity, contribution: RuntimeContribution, runnerIdentity: ServiceRunnerIdentity, redactions?: string[]) {
		return { ...(await this.inspectInput(identity, contribution, runnerIdentity)), ...(redactions ? { redactions } : {}) };
	}

	/** A path lookup only: it intentionally never reads runtime.env or resolves settings/secrets. */
	private async runtimeEnvironmentFile(identity: ServiceRuntimeIdentity): Promise<string | undefined> {
		const store = this.options.store as ServiceRuntimeStore & { environmentFile?: (value: ServiceRuntimeIdentity) => Promise<string> };
		return typeof store.environmentFile === "function" ? store.environmentFile(identity) : undefined;
	}

	private get clock(): ServiceRuntimeClock { return this.options.clock ?? realClock; }
	private get probe(): ServiceRuntimeProbe { return this.options.probe ?? defaultProbe; }
}
