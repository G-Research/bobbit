import { randomUUID } from "node:crypto";
import {
	HOST_NOTIFICATION_CATALOGUE,
	buildHostNotification,
	validateNotificationPayload,
	type HostNotification,
	type HostNotificationName,
	type HostNotificationPayload,
	type HostNotificationScope,
} from "../../shared/extension-host/host-hooks.js";

export interface HostNotificationPublication<N extends HostNotificationName> {
	readonly projectId: string;
	readonly sessionId?: HostNotificationScope<N> extends "session" ? string : string | undefined;
	readonly aggregateId: string;
	readonly aggregateRevision?: string | number;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly payload: HostNotificationPayload<N>;
}

export type HostNotificationConsumer = "browser" | "module" | "staff";

/**
 * One asynchronous fanout target. The adapter receives the exact frozen event
 * returned by publish; it must not re-project mutable aggregate state.
 */
export interface HostNotificationDeliveryAdapter {
	readonly consumer: HostNotificationConsumer;
	/** Durable subscriber adapters own their admission scheduling and persistence.
	 * They bypass bounded live queues so browser/module pressure cannot discard an
	 * event before the subscriber outbox sees it. Their deliver method must return
	 * without awaiting durable delivery; failures remain observational. */
	readonly admission?: "bounded-live" | "durable-subscriber";
	deliver(notification: HostNotification): void | Promise<void>;
	/** Called asynchronously after an overflow. Browser adapters use it to issue
	 * a refresh-required frame; live module delivery simply reports the drop. */
	refreshRequired?(notification: HostNotification): void | Promise<void>;
}

export type HostNotificationDiagnosticCode =
	| "invalid_name"
	| "invalid_publication"
	| "invalid_payload"
	| "project_mismatch"
	| "queue_overflow"
	| "consumer_failure";

export interface HostNotificationDiagnostic {
	readonly code: HostNotificationDiagnosticCode;
	readonly consumer?: HostNotificationConsumer;
	readonly projectId?: string;
	readonly name?: string;
	readonly occurredAt: number;
}

export interface HostNotificationModuleHandler {
	readonly projectId: string;
	readonly packId: string;
	readonly contributionId: string;
	readonly scope: "session" | "project";
	readonly name: HostNotificationName;
	readonly timeoutMs?: number;
}

export type HostNotificationModuleDiagnosticCode =
	| "handler_timeout"
	| "handler_failure"
	| "handler_revoked";

export interface HostNotificationModuleAdapterOptions {
	/** Must return the normalized winning contributions in deterministic order. */
	readonly resolve: (notification: HostNotification) => readonly HostNotificationModuleHandler[];
	/** Live pack activation, winning-ref, and capability authorization check. Called
	 * before invoke and again after settlement so invalidated late work has no
	 * host-observed effect. */
	readonly isAuthorized: (handler: HostNotificationModuleHandler, notification: HostNotification) => boolean;
	/** ModuleHost-backed invocation. It must observe signal cancellation and receives
	 * the exact frozen canonical event. Return values are deliberately discarded. */
	readonly invoke: (handler: HostNotificationModuleHandler, notification: HostNotification, signal: AbortSignal) => void | Promise<unknown>;
	readonly maxHandlersPerNotification?: number;
	readonly defaultTimeoutMs?: number;
	readonly maxTimeoutMs?: number;
	readonly onDiagnostic?: (diagnostic: Readonly<{
		code: HostNotificationModuleDiagnosticCode;
		projectId: string;
		packId: string;
		contributionId: string;
		name: HostNotificationName;
	}>) => void;
}

/** Ordered observational module delivery; every handler failure is isolated. */
export class HostNotificationModuleAdapter implements HostNotificationDeliveryAdapter {
	readonly consumer = "module" as const;
	private readonly maxHandlers: number;
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;

	constructor(private readonly options: HostNotificationModuleAdapterOptions) {
		this.maxHandlers = Math.max(1, Math.min(options.maxHandlersPerNotification ?? 64, 256));
		this.maxTimeoutMs = Math.max(1, Math.min(options.maxTimeoutMs ?? 5_000, 30_000));
		this.defaultTimeoutMs = Math.max(1, Math.min(options.defaultTimeoutMs ?? 1_500, this.maxTimeoutMs));
	}

	async deliver(notification: HostNotification): Promise<void> {
		const handlers = this.options.resolve(notification).slice(0, this.maxHandlers);
		for (const handler of handlers) {
			if (handler.projectId !== notification.projectId
				|| handler.scope !== notification.scope
				|| handler.name !== notification.name) continue;
			if (!this.safeAuthorized(handler, notification)) {
				this.report("handler_revoked", handler, notification);
				continue;
			}
			const controller = new AbortController();
			const declaredTimeout = typeof handler.timeoutMs === "number" && Number.isFinite(handler.timeoutMs)
				? handler.timeoutMs
				: this.defaultTimeoutMs;
			const timeoutMs = Math.max(1, Math.min(declaredTimeout, this.maxTimeoutMs));
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const invocation = Promise.resolve(this.options.invoke(handler, notification, controller.signal));
				await Promise.race([
					invocation,
					new Promise<void>((_, reject) => {
						timer = setTimeout(() => {
							timedOut = true;
							controller.abort(new Error("notification handler deadline exceeded"));
							reject(new Error("notification handler deadline exceeded"));
						}, timeoutMs);
					}),
				]);
				// Return values are ignored. This second live check is the settlement
				// fence and intentionally performs no action when authority was revoked.
				if (!this.safeAuthorized(handler, notification)) this.report("handler_revoked", handler, notification);
			} catch {
				this.report(timedOut ? "handler_timeout" : "handler_failure", handler, notification);
			} finally {
				if (timer) clearTimeout(timer);
				controller.abort();
			}
		}
	}

	private safeAuthorized(handler: HostNotificationModuleHandler, notification: HostNotification): boolean {
		try { return this.options.isAuthorized(handler, notification); }
		catch { return false; }
	}

	private report(
		code: HostNotificationModuleDiagnosticCode,
		handler: HostNotificationModuleHandler,
		notification: HostNotification,
	): void {
		if (!this.options.onDiagnostic) return;
		try {
			this.options.onDiagnostic(Object.freeze({
				code,
				projectId: notification.projectId.slice(0, 128),
				packId: handler.packId.slice(0, 128),
				contributionId: handler.contributionId.slice(0, 128),
				name: notification.name,
			}));
		} catch { /* observational diagnostics never affect delivery */ }
	}
}

export interface HostNotificationDispatcherOptions {
	readonly adapters?: readonly HostNotificationDeliveryAdapter[];
	/** Authoritative session-to-project lookup. Session-scoped facts fail closed
	 * when this authority is absent or disagrees with the publication. */
	readonly resolveSessionProject?: (sessionId: string) => string | undefined;
	readonly queueCapacity?: number;
	readonly diagnosticCapacity?: number;
	readonly now?: () => number;
	readonly idGenerator?: () => string;
	readonly onDiagnostic?: (diagnostic: HostNotificationDiagnostic) => void | Promise<void>;
}

type QueueLane = {
	items: HostNotification[];
	running: boolean;
};

/** A bounded, independently draining FIFO per project. */
class ProjectOrderedQueue {
	private readonly lanes = new Map<string, QueueLane>();
	readonly consumer: HostNotificationConsumer;

	constructor(
		private readonly adapter: HostNotificationDeliveryAdapter,
		private readonly capacity: number,
		private readonly onFailure: (consumer: HostNotificationConsumer, notification: HostNotification) => void,
	) {
		this.consumer = adapter.consumer;
	}

	refreshRequired(notification: HostNotification): void {
		if (!this.adapter.refreshRequired) return;
		queueMicrotask(() => {
			let delivery: void | Promise<void>;
			try { delivery = this.adapter.refreshRequired!(notification); }
			catch { this.onFailure(this.consumer, notification); return; }
			void Promise.resolve(delivery).catch(() => {
				this.onFailure(this.consumer, notification);
			});
		});
	}

	enqueue(notification: HostNotification): boolean {
		let lane = this.lanes.get(notification.projectId);
		if (!lane) {
			lane = { items: [], running: false };
			this.lanes.set(notification.projectId, lane);
		}
		if (lane.items.length >= this.capacity) return false;
		lane.items.push(notification);
		if (!lane.running) {
			lane.running = true;
			queueMicrotask(() => void this.drain(notification.projectId, lane!));
		}
		return true;
	}

	private async drain(projectId: string, lane: QueueLane): Promise<void> {
		try {
			while (lane.items.length > 0) {
				const notification = lane.items.shift()!;
				try {
					await this.adapter.deliver(notification);
				} catch {
					this.onFailure(this.adapter.consumer, notification);
				}
			}
		} finally {
			lane.running = false;
			if (lane.items.length > 0) {
				lane.running = true;
				queueMicrotask(() => void this.drain(projectId, lane));
			} else if (this.lanes.get(projectId) === lane) {
				this.lanes.delete(projectId);
			}
		}
	}
}

function isNonEmptyBoundedString(value: unknown, max = 512): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validRevision(value: unknown): value is string | number {
	return (typeof value === "string" && value.length > 0 && value.length <= 512)
		|| (typeof value === "number" && Number.isFinite(value));
}

function cloneProjection<T>(value: T): T | undefined {
	try {
		return structuredClone(value);
	} catch {
		return undefined;
	}
}

/**
 * Canonical post-authority publication point. publish performs only bounded
 * validation/copying and queue admission. Socket sends, module invocation, and
 * durable staff-intent writes always start in a later microtask and can never
 * fail or roll back the source mutation.
 */
export class HostNotificationDispatcher {
	private readonly queues: ProjectOrderedQueue[];
	private readonly durableAdapters: HostNotificationDeliveryAdapter[];
	private readonly resolveSessionProject?: (sessionId: string) => string | undefined;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private readonly diagnosticCapacity: number;
	private readonly onDiagnostic?: HostNotificationDispatcherOptions["onDiagnostic"];
	private readonly diagnosticRows: HostNotificationDiagnostic[] = [];
	private pendingDiagnosticCallbacks = 0;

	constructor(options: HostNotificationDispatcherOptions = {}) {
		const queueCapacity = Math.max(1, Math.min(options.queueCapacity ?? 256, 4096));
		this.resolveSessionProject = options.resolveSessionProject;
		this.now = options.now ?? Date.now;
		this.idGenerator = options.idGenerator ?? randomUUID;
		this.diagnosticCapacity = Math.max(1, Math.min(options.diagnosticCapacity ?? 256, 2048));
		this.onDiagnostic = options.onDiagnostic;
		const seen = new Set<HostNotificationConsumer>();
		this.queues = [];
		this.durableAdapters = [];
		for (const adapter of options.adapters ?? []) {
			if (seen.has(adapter.consumer)) continue;
			seen.add(adapter.consumer);
			if (adapter.admission === "durable-subscriber") {
				this.durableAdapters.push(adapter);
				continue;
			}
			this.queues.push(new ProjectOrderedQueue(
				adapter,
				queueCapacity,
				(consumer, notification) => this.diagnostic("consumer_failure", notification, consumer),
			));
		}
	}

	publish<N extends HostNotificationName>(
		name: N,
		publication: HostNotificationPublication<N>,
	): HostNotification<N> | undefined {
		try {
			return this.publishValidated(name, publication);
		} catch {
			this.diagnostic("invalid_publication", undefined, undefined, undefined, String(name));
			return undefined;
		}
	}

	private publishValidated<N extends HostNotificationName>(
		name: N,
		publication: HostNotificationPublication<N>,
	): HostNotification<N> | undefined {
		const definition = HOST_NOTIFICATION_CATALOGUE[name];
		if (!definition) {
			this.diagnostic("invalid_name", undefined, undefined, undefined, String(name));
			return undefined;
		}
		if (!publication || typeof publication !== "object") {
			this.diagnostic("invalid_publication", undefined, undefined, undefined, name);
			return undefined;
		}
		if (!isNonEmptyBoundedString(publication.projectId)
			|| !isNonEmptyBoundedString(publication.aggregateId)
			|| !validRevision(publication.aggregateRevision)
			|| (publication.correlationId !== undefined && !isNonEmptyBoundedString(publication.correlationId))
			|| (publication.causationId !== undefined && !isNonEmptyBoundedString(publication.causationId))) {
			this.diagnostic("invalid_publication", undefined, undefined, publication.projectId, name);
			return undefined;
		}

		const sessionId = publication.sessionId;
		if (definition.scope === "session" && !isNonEmptyBoundedString(sessionId)) {
			this.diagnostic("invalid_publication", undefined, undefined, publication.projectId, name);
			return undefined;
		}
		if (sessionId !== undefined) {
			if (!isNonEmptyBoundedString(sessionId)
				|| !this.resolveSessionProject
				|| this.resolveSessionProject(sessionId) !== publication.projectId) {
				this.diagnostic("project_mismatch", undefined, undefined, publication.projectId, name);
				return undefined;
			}
		}

		const payload = cloneProjection(publication.payload);
		if (payload === undefined || !validateNotificationPayload(name, payload)) {
			this.diagnostic("invalid_payload", undefined, undefined, publication.projectId, name);
			return undefined;
		}

		const id = this.idGenerator();
		const occurredAt = this.now();
		if (!isNonEmptyBoundedString(id) || !Number.isFinite(occurredAt) || occurredAt < 0) {
			this.diagnostic("invalid_publication", undefined, undefined, publication.projectId, name);
			return undefined;
		}
		const notification = buildHostNotification(name, {
			id,
			occurredAt,
			projectId: publication.projectId,
			...(definition.scope === "session" ? { sessionId } : {}),
			aggregateId: publication.aggregateId,
			aggregateRevision: publication.aggregateRevision,
			...(publication.correlationId !== undefined ? { correlationId: publication.correlationId } : {}),
			...(publication.causationId !== undefined ? { causationId: publication.causationId } : {}),
			payload,
		});

		for (const queue of this.queues) {
			if (!definition.consumers.has(queue.consumer)) continue;
			if (queue.enqueue(notification)) continue;
			this.diagnostic("queue_overflow", notification, queue.consumer);
			queue.refreshRequired(notification);
		}
		for (const adapter of this.durableAdapters) {
			if (!definition.consumers.has(adapter.consumer)) continue;
			// The durable adapter owns matching, idempotency, and its disk-backed
			// admission seam. Schedule it independently of bounded live queues so a
			// browser/module burst cannot drop staff work before persistence.
			queueMicrotask(() => {
				let delivery: void | Promise<void>;
				try { delivery = adapter.deliver(notification); }
				catch {
					this.diagnostic("consumer_failure", notification, adapter.consumer);
					return;
				}
				void Promise.resolve(delivery).catch(() => {
					this.diagnostic("consumer_failure", notification, adapter.consumer);
				});
			});
		}
		return notification;
	}

	/** Bounded diagnostics contain attribution codes only, never payloads/errors. */
	getDiagnostics(): readonly HostNotificationDiagnostic[] {
		return this.diagnosticRows.slice();
	}

	private diagnostic(
		code: HostNotificationDiagnosticCode,
		notification?: HostNotification,
		consumer?: HostNotificationConsumer,
		projectId?: string,
		name?: string,
	): void {
		const rawProjectId = notification?.projectId ?? projectId;
		const boundedProjectId = typeof rawProjectId === "string" ? rawProjectId.slice(0, 128) : undefined;
		const boundedName = String(notification?.name ?? name ?? "").slice(0, 128) || undefined;
		let occurredAt = 0;
		try {
			const candidate = this.now();
			if (Number.isFinite(candidate) && candidate >= 0) occurredAt = candidate;
		} catch { /* diagnostics must not escape into the source operation */ }
		const row = Object.freeze({
			code,
			...(consumer ? { consumer } : {}),
			...(boundedProjectId ? { projectId: boundedProjectId } : {}),
			...(boundedName ? { name: boundedName } : {}),
			occurredAt,
		}) as HostNotificationDiagnostic;
		if (this.diagnosticRows.length >= this.diagnosticCapacity) this.diagnosticRows.shift();
		this.diagnosticRows.push(row);
		if (this.onDiagnostic && this.pendingDiagnosticCallbacks < this.diagnosticCapacity) {
			this.pendingDiagnosticCallbacks++;
			queueMicrotask(() => {
				let delivery: void | Promise<void>;
				try { delivery = this.onDiagnostic!(row); }
				catch { this.pendingDiagnosticCallbacks--; return; }
				void Promise.resolve(delivery)
					.catch(() => {})
					.finally(() => { this.pendingDiagnosticCallbacks--; });
			});
		}
	}
}
