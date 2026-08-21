import { createHash } from "node:crypto";
import {
	HOST_NOTIFICATION_CATALOGUE,
	validateNotificationFilter,
	validateNotificationPayload,
	type HostHookScope,
	type HostNotification,
	type HostNotificationName,
} from "../../shared/extension-host/host-hooks.js";
import { realClock, type Clock } from "../gateway-deps.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import type { StaffManager } from "./staff-manager.js";
import type { NotificationStaffTrigger, PersistedStaff } from "./staff-store.js";
import { NotificationDeliveryStore, type NotificationDeliveryRow } from "./notification-delivery-store.js";

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_CAUSATION_DEPTH = 8;
const MAX_ATTEMPTS = 5;
const FINAL_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 32;

type Scalar = string | number | boolean;
type DefinitionView = {
	name: string;
	scope: HostHookScope;
	payloadVersion: number;
	aggregateKind: string;
	consumers: ReadonlySet<string> | readonly string[];
	filterFields: Readonly<Record<string, unknown>>;
};

export interface NotificationDeliveryControls {
	/** Host-owned root propagated from a prior notification staff wake. */
	rootCorrelationId?: string;
	causationDepth?: number;
}

export interface NotificationStaffDiagnostic {
	code: string;
	projectId: string;
	notificationName?: string;
	staffId?: string;
	triggerId?: string;
	deliveryId?: string;
	attempt?: number;
}

function definitionFor(name: string): DefinitionView | undefined {
	return (HOST_NOTIFICATION_CATALOGUE as unknown as Record<string, DefinitionView>)[name];
}

function consumerAllowed(definition: DefinitionView, consumer: string): boolean {
	return definition.consumers instanceof Set
		? definition.consumers.has(consumer)
		: Array.isArray(definition.consumers) && definition.consumers.includes(consumer);
}

function isBoundedString(value: unknown, max = 512): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

const ENVELOPE_KEYS = new Set(["id", "scope", "name", "payloadVersion", "occurredAt", "projectId", "sessionId", "aggregate", "correlationId", "causationId", "payload"]);
const AGGREGATE_KEYS = new Set(["kind", "id", "revision"]);

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stableFilter(filter: Readonly<Record<string, Scalar>>): Record<string, Scalar> {
	return Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)));
}

export function notificationDeliveryId(staffId: string, triggerId: string, notificationId: string): string {
	return createHash("sha256").update(`${staffId}|${triggerId}|${notificationId}`).digest("hex");
}

export function notificationSubscriberVersion(trigger: NotificationStaffTrigger): string {
	return createHash("sha256").update(JSON.stringify({
		enabled: trigger.enabled,
		notification: trigger.notification,
		filter: stableFilter(trigger.filter ?? {}),
		prompt: trigger.prompt ?? null,
	})).digest("hex");
}

function selectorAndFilterMatch(trigger: NotificationStaffTrigger, event: HostNotification): boolean {
	if (trigger.notification.scope !== event.scope || trigger.notification.name !== event.name) return false;
	const checked = validateNotificationFilter(event.scope, event.name, trigger.filter ?? {});
	if (!checked.ok) return false;
	const payload = event.payload as unknown as Record<string, unknown>;
	return Object.entries(checked.filter).every(([key, value]) => payload[key] === value);
}

/**
 * Revalidate and clone the complete canonical event before persistence or use.
 * The shared payload schema remains authoritative; this wrapper pins envelope,
 * scope, version, aggregate, consumer eligibility, partition, and size.
 */
export function validateStaffNotification(value: unknown, projectId: string): HostNotification | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	let encoded: string;
	try { encoded = JSON.stringify(value); } catch { return null; }
	if (Buffer.byteLength(encoded, "utf-8") > MAX_EVENT_BYTES) return null;
	const event = value as Record<string, unknown>;
	if (!hasOnlyKeys(event, ENVELOPE_KEYS)) return null;
	if (!isBoundedString(event.id) || !isBoundedString(event.name, 128)) return null;
	const definition = definitionFor(event.name);
	if (!definition || !consumerAllowed(definition, "staff")) return null;
	if (event.scope !== definition.scope || event.projectId !== projectId || !isBoundedString(event.projectId)) return null;
	if (event.payloadVersion !== definition.payloadVersion) return null;
	if (typeof event.occurredAt !== "number" || !Number.isFinite(event.occurredAt) || event.occurredAt < 0) return null;
	if (definition.scope === "session" && !isBoundedString(event.sessionId)) return null;
	if (event.sessionId !== undefined && !isBoundedString(event.sessionId)) return null;
	if (event.correlationId !== undefined && !isBoundedString(event.correlationId)) return null;
	if (event.causationId !== undefined && !isBoundedString(event.causationId)) return null;
	if (!event.aggregate || typeof event.aggregate !== "object" || Array.isArray(event.aggregate)) return null;
	const aggregate = event.aggregate as Record<string, unknown>;
	if (!hasOnlyKeys(aggregate, AGGREGATE_KEYS)) return null;
	if (aggregate.kind !== definition.aggregateKind || !isBoundedString(aggregate.id)) return null;
	if (aggregate.revision !== undefined
		&& typeof aggregate.revision !== "string"
		&& (typeof aggregate.revision !== "number" || !Number.isFinite(aggregate.revision))) return null;
	if (!validateNotificationPayload(event.name as HostNotificationName, event.payload)) return null;
	try {
		return deepFreeze(cloneJson(value as HostNotification));
	} catch {
		return null;
	}
}

function transientDeliveryError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "EAGAIN" || code === "EBUSY" || code === "ETIMEDOUT" || code === "UNAVAILABLE";
}

function currentNotificationTrigger(staff: PersistedStaff | undefined, triggerId: string): NotificationStaffTrigger | undefined {
	if (!staff || staff.state !== "active") return undefined;
	const trigger = staff.triggers.find((candidate) => candidate.id === triggerId);
	return trigger?.type === "notification" && trigger.enabled ? trigger : undefined;
}

/** Durable, project-partitioned delivery adapter for notification staff triggers. */
export class NotificationStaffDispatcher {
	private readonly stores = new Map<string, NotificationDeliveryStore>();
	private readonly aborters = new Map<string, AbortController>();
	private interval: ReturnType<Clock["setInterval"]> | null = null;
	private drainQueued = false;

	constructor(
		private readonly pcm: ProjectContextManager,
		private readonly staffManager: StaffManager,
		private readonly inboxManager: InboxManager,
		private readonly options: {
			clock?: Clock;
			storeFactory?: (stateDir: string, projectId: string) => NotificationDeliveryStore;
			onDiagnostic?: (diagnostic: NotificationStaffDiagnostic) => void;
		} = {},
	) {
		this.clock = options.clock ?? realClock;
		this.staffManager.setNotificationDeliveryReconciler?.((projectId, staffId) => {
			this.reconcileProject(projectId, staffId);
		});
	}

	private readonly clock: Clock;

	start(): void {
		if (this.interval) return;
		this.reconcileAll();
		this.interval = this.clock.setInterval(() => this.reconcileAll(), 1_000);
	}

	stop(): void {
		if (this.interval) this.clock.clearInterval(this.interval);
		this.interval = null;
		for (const aborter of this.aborters.values()) aborter.abort();
		this.aborters.clear();
	}

	private diagnostic(diagnostic: NotificationStaffDiagnostic): void {
		try { this.options.onDiagnostic?.(diagnostic); } catch { /* diagnostics cannot affect delivery */ }
	}

	private storeFor(projectId: string): NotificationDeliveryStore | null {
		const cached = this.stores.get(projectId);
		if (cached) return cached;
		const ctx = this.pcm.getOrCreate(projectId);
		if (!ctx || ctx.project.id !== projectId) return null;
		const store = this.options.storeFactory
			? this.options.storeFactory(ctx.stateDir, projectId)
			: new NotificationDeliveryStore(ctx.stateDir, projectId, undefined, this.clock);
		this.stores.set(projectId, store);
		return store;
	}

	/** Non-blocking fanout entry point used by the canonical dispatcher. */
	enqueue(notification: HostNotification, controls: NotificationDeliveryControls = {}): void {
		queueMicrotask(() => {
			try { this.enqueueNow(notification, controls); }
			catch { this.diagnostic({ code: "OUTBOX_INSERT_FAILED", projectId: notification.projectId, notificationName: notification.name }); }
		});
	}

	/** Alias suitable for a notification-dispatcher consumer callback. */
	onNotification(notification: HostNotification, controls?: NotificationDeliveryControls): void {
		this.enqueue(notification, controls);
	}

	/** Synchronous seam for boot reconciliation and focused tests. */
	enqueueNow(notification: HostNotification, controls: NotificationDeliveryControls = {}): number {
		const event = validateStaffNotification(notification, notification.projectId);
		if (!event) {
			this.diagnostic({ code: "INVALID_NOTIFICATION", projectId: notification.projectId, notificationName: notification.name });
			return 0;
		}
		const store = this.storeFor(event.projectId);
		if (!store) {
			this.diagnostic({ code: "UNKNOWN_PROJECT", projectId: event.projectId, notificationName: event.name });
			return 0;
		}
		const rootCorrelationId = controls.rootCorrelationId ?? event.correlationId ?? event.id;
		const causationDepth = controls.causationDepth ?? 0;
		let inserted = 0;
		for (const staff of this.staffManager.listStaff(event.projectId)) {
			if (staff.projectId !== event.projectId || staff.state !== "active") continue;
			for (const trigger of staff.triggers) {
				if (trigger.type !== "notification" || !trigger.enabled || !selectorAndFilterMatch(trigger, event)) continue;
				if (causationDepth > MAX_CAUSATION_DEPTH || store.hasSubscriberRoot(rootCorrelationId, staff.id, trigger.id)) {
					this.diagnostic({ code: "LOOP_SUPPRESSED", projectId: event.projectId, notificationName: event.name, staffId: staff.id, triggerId: trigger.id });
					continue;
				}
				const now = this.clock.now();
				const deliveryId = notificationDeliveryId(staff.id, trigger.id, event.id);
				const row: NotificationDeliveryRow = {
					deliveryId,
					projectId: event.projectId,
					staffId: staff.id,
					triggerId: trigger.id,
					subscriberVersion: notificationSubscriberVersion(trigger),
					notification: event,
					state: "pending",
					attempt: 0,
					nextAttemptAt: now,
					rootCorrelationId,
					causationDepth,
					createdAt: now,
					updatedAt: now,
				};
				if (store.insertPending(row).inserted) inserted++;
			}
		}
		this.queueDrain();
		return inserted;
	}

	private queueDrain(): void {
		if (this.drainQueued) return;
		this.drainQueued = true;
		queueMicrotask(() => {
			this.drainQueued = false;
			this.reconcileAll();
		});
	}

	reconcileAll(): void {
		for (const ctx of this.pcm.all()) this.reconcileProject(ctx.project.id);
	}

	reconcileProject(projectId: string, changedStaffId?: string): void {
		const store = this.storeFor(projectId);
		if (!store) return;
		try {
			const cancelled = store.cancelWhere((row) => {
				if (changedStaffId && row.staffId !== changedStaffId) return false;
				const staff = this.staffManager.getStaff(row.staffId);
				const trigger = currentNotificationTrigger(staff, row.triggerId);
				return !staff || staff.projectId !== projectId || !trigger;
			});
			for (const id of cancelled) {
				this.aborters.get(id)?.abort();
				this.aborters.delete(id);
			}
			const claimed = store.claimDue(this.clock.now(), LEASE_MS, BATCH_SIZE);
			for (const row of claimed) this.deliver(store, row);
		} catch {
			this.diagnostic({ code: "OUTBOX_RECONCILE_FAILED", projectId });
		}
	}

	private deliver(store: NotificationDeliveryStore, row: NotificationDeliveryRow): void {
		const leaseId = row.leaseId!;
		const aborter = new AbortController();
		this.aborters.set(row.deliveryId, aborter);
		try {
			if (row.attempt > 1 && this.clock.now() >= row.createdAt + FINAL_DEADLINE_MS) {
				store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "DELIVERY_DEADLINE_EXCEEDED" });
				return;
			}
			const event = validateStaffNotification(row.notification, row.projectId);
			if (!event || row.projectId !== store.projectId) {
				store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "INVALID_PERSISTED_NOTIFICATION" });
				return;
			}
			const staff = this.staffManager.getStaff(row.staffId);
			const trigger = currentNotificationTrigger(staff, row.triggerId);
			if (!staff || staff.projectId !== row.projectId || !trigger) {
				store.finishLease(row.deliveryId, leaseId, "cancelled", { diagnosticCode: "SUBSCRIBER_INACTIVE" });
				return;
			}
			if (notificationSubscriberVersion(trigger) !== row.subscriberVersion) {
				store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "SUBSCRIBER_VERSION_CHANGED" });
				return;
			}
			if (!selectorAndFilterMatch(trigger, event)) {
				store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "SELECTOR_MISMATCH" });
				return;
			}
			if (row.causationDepth > MAX_CAUSATION_DEPTH) {
				store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "CAUSATION_DEPTH_EXCEEDED" });
				return;
			}
			if (aborter.signal.aborted || currentNotificationTrigger(this.staffManager.getStaff(row.staffId), row.triggerId) !== trigger) {
				store.finishLease(row.deliveryId, leaseId, "cancelled", { diagnosticCode: "SUBSCRIBER_CANCELLED" });
				return;
			}
			this.inboxManager.enqueueWithId(row.deliveryId, row.staffId, {
				title: `Host notification: ${event.name}`,
				triggerId: row.triggerId,
				notification: event,
				rootCorrelationId: row.rootCorrelationId,
				causationDepth: row.causationDepth + 1,
			});
			if (store.finishLease(row.deliveryId, leaseId, "accepted")) {
				this.staffManager.updateTriggerState(row.staffId, row.triggerId, { lastFired: this.clock.now() });
			}
		} catch (err) {
			const now = this.clock.now();
			const retryable = transientDeliveryError(err)
				&& row.attempt < MAX_ATTEMPTS
				&& now < row.createdAt + FINAL_DEADLINE_MS;
			try {
				if (retryable) {
					const backoff = Math.min(60_000, 1_000 * (2 ** Math.max(0, row.attempt - 1)));
					store.finishLease(row.deliveryId, leaseId, "pending", { nextAttemptAt: now + backoff, diagnosticCode: "TRANSIENT_DELIVERY_FAILURE" });
				} else {
					store.finishLease(row.deliveryId, leaseId, "failed", { diagnosticCode: "PERMANENT_DELIVERY_FAILURE" });
				}
			} catch { /* leave the durable lease for restart recovery */ }
			this.diagnostic({ code: retryable ? "DELIVERY_RETRY" : "DELIVERY_FAILED", projectId: row.projectId, notificationName: row.notification.name, staffId: row.staffId, triggerId: row.triggerId, deliveryId: row.deliveryId, attempt: row.attempt });
		} finally {
			this.aborters.delete(row.deliveryId);
		}
	}
}
