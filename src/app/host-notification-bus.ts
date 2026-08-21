// Canonical Extension Host notification delivery for browser surfaces.
//
// This is deliberately separate from session-event-bus.ts. The legacy bus maps
// rich raw session frames onto HostMessage/ToolCallRecord and must remain byte-
// compatible; this bus accepts only the bounded canonical host_notification
// protocol. Its authority key is the trusted RemoteAgent's bound session, never
// an identifier supplied by extension code.

import type {
	HostNotification,
	HostNotificationName,
	HostNotificationScope,
} from "../shared/extension-host/host-hooks.js";

export interface HostNotificationStreamPosition {
	readonly epoch: string;
	readonly sequence: number;
}

export interface HostNotificationFrame {
	readonly notification: HostNotification;
	readonly stream: HostNotificationStreamPosition;
}

export interface HostNotificationRefreshFrame {
	readonly scope: "session" | "project";
	readonly epoch: string;
	readonly sequence: number;
}

type NotificationHandler = (event: HostNotification) => void;
type RefreshHandler = () => void;
type Scope = "session" | "project";

interface Subscription<T> {
	readonly handler: T;
	active: boolean;
	generation: number;
}

interface StreamState {
	epoch?: string;
	sequence: number;
}

interface BoundBus {
	readonly notifications: Map<string, Set<Subscription<NotificationHandler>>>;
	readonly refresh: Record<Scope, Set<Subscription<RefreshHandler>>>;
	readonly streams: Record<Scope, StreamState>;
	readonly recentIds: Map<string, true>;
	readonly refreshScheduled: Record<Scope, boolean>;
	pendingDeliveries: number;
}

const buses = new Map<string, BoundBus>();
const MAX_RECENT_IDS = 512;
const MAX_PENDING_DELIVERIES = 512;

function createBoundBus(): BoundBus {
	return {
		notifications: new Map(),
		refresh: { session: new Set(), project: new Set() },
		streams: {
			session: { sequence: 0 },
			project: { sequence: 0 },
		},
		recentIds: new Map(),
		refreshScheduled: { session: false, project: false },
		pendingDeliveries: 0,
	};
}

function busFor(sessionId: string): BoundBus {
	let bus = buses.get(sessionId);
	if (!bus) {
		bus = createBoundBus();
		buses.set(sessionId, bus);
	}
	return bus;
}

function inertUnsubscribe(): () => void {
	return () => {};
}

function unsubscribeFrom<T>(set: Set<Subscription<T>>, subscription: Subscription<T>): () => void {
	return () => {
		if (!subscription.active) return;
		subscription.active = false;
		subscription.generation += 1;
		set.delete(subscription);
	};
}

function scheduleRefresh(bus: BoundBus, scope: Scope): void {
	if (bus.refreshScheduled[scope]) return;
	bus.refreshScheduled[scope] = true;
	queueMicrotask(() => {
		bus.refreshScheduled[scope] = false;
		for (const subscription of [...bus.refresh[scope]]) {
			const generation = subscription.generation;
			if (!subscription.active) continue;
			try {
				if (subscription.active && subscription.generation === generation) subscription.handler();
			} catch {
				// One contributed panel must not interrupt another panel's refresh.
			}
		}
	});
}

/** Subscribe within the RemoteAgent-owned session transport. An unbound host is inert. */
export function subscribeHostNotification<N extends HostNotificationName>(
	sessionId: string | undefined,
	scope: HostNotificationScope<N>,
	name: N,
	handler: (event: HostNotification<N>) => void,
): () => void {
	if (!sessionId) return inertUnsubscribe();
	const bus = busFor(sessionId);
	const key = `${scope}:${name}`;
	let subscriptions = bus.notifications.get(key);
	if (!subscriptions) {
		subscriptions = new Set();
		bus.notifications.set(key, subscriptions);
	}
	const subscription: Subscription<NotificationHandler> = {
		handler: handler as NotificationHandler,
		active: true,
		generation: 0,
	};
	subscriptions.add(subscription);
	return unsubscribeFrom(subscriptions, subscription);
}

/**
 * Observe snapshot invalidation for one server-bound scope. Registration itself
 * schedules the initial snapshot-first refresh; reconnect/gap bursts share the
 * same microtask coalescer.
 */
export function subscribeHostNotificationRefresh(
	sessionId: string | undefined,
	scope: Scope,
	handler: RefreshHandler,
): () => void {
	if (!sessionId) return inertUnsubscribe();
	const bus = busFor(sessionId);
	const subscription: Subscription<RefreshHandler> = { handler, active: true, generation: 0 };
	bus.refresh[scope].add(subscription);
	scheduleRefresh(bus, scope);
	return unsubscribeFrom(bus.refresh[scope], subscription);
}

function validPosition(value: unknown): value is HostNotificationStreamPosition {
	if (!value || typeof value !== "object") return false;
	const position = value as Partial<HostNotificationStreamPosition>;
	return typeof position.epoch === "string"
		&& position.epoch.length > 0
		&& position.epoch.length <= 256
		&& Number.isSafeInteger(position.sequence)
		&& (position.sequence ?? 0) > 0;
}

function structurallyBoundNotification(value: unknown, transportSessionId: string): value is HostNotification {
	if (!value || typeof value !== "object") return false;
	const notification = value as Partial<HostNotification>;
	if (typeof notification.id !== "string" || notification.id.length === 0) return false;
	if (typeof notification.name !== "string" || notification.name.length === 0) return false;
	if (notification.scope !== "session" && notification.scope !== "project") return false;
	// Session scope has an additional exact client-side fence. Project authority
	// remains server-owned because extension code never receives a project selector.
	if (notification.scope === "session" && notification.sessionId !== transportSessionId) return false;
	return true;
}

/**
 * Advance one ephemeral per-connection scope stream. False means the frame is a
 * duplicate/late frame or crossed a gap/epoch boundary and must not be applied as
 * a delta. The authoritative refresh is scheduled for discontinuities.
 */
function advanceStream(bus: BoundBus, scope: Scope, position: HostNotificationStreamPosition): boolean {
	const stream = bus.streams[scope];
	if (stream.epoch === undefined) {
		stream.epoch = position.epoch;
		stream.sequence = position.sequence;
		if (position.sequence !== 1) {
			scheduleRefresh(bus, scope);
			return false;
		}
		return true;
	}
	if (stream.epoch !== position.epoch) {
		stream.epoch = position.epoch;
		stream.sequence = position.sequence;
		scheduleRefresh(bus, scope);
		return false;
	}
	if (position.sequence <= stream.sequence) return false;
	const contiguous = position.sequence === stream.sequence + 1;
	stream.sequence = position.sequence;
	if (!contiguous) {
		scheduleRefresh(bus, scope);
		return false;
	}
	return true;
}

function rememberId(bus: BoundBus, id: string): boolean {
	if (bus.recentIds.has(id)) return false;
	bus.recentIds.set(id, true);
	while (bus.recentIds.size > MAX_RECENT_IDS) {
		const oldest = bus.recentIds.keys().next().value;
		if (oldest === undefined) break;
		bus.recentIds.delete(oldest);
	}
	return true;
}

/** Feed one server-canonical notification frame from its bound RemoteAgent. */
export function publishHostNotificationFrame(
	transportSessionId: string,
	frame: HostNotificationFrame,
): void {
	if (!transportSessionId || !validPosition(frame?.stream)) return;
	if (!structurallyBoundNotification(frame?.notification, transportSessionId)) return;
	const bus = busFor(transportSessionId);
	const notification = frame.notification;
	if (!advanceStream(bus, notification.scope, frame.stream)) return;
	if (!rememberId(bus, notification.id)) return;
	if (bus.pendingDeliveries >= MAX_PENDING_DELIVERIES) {
		scheduleRefresh(bus, notification.scope);
		return;
	}
	bus.pendingDeliveries += 1;
	const key = `${notification.scope}:${notification.name}`;
	// Snapshot the live subscribers at publication time: a panel mounted before
	// this microtask runs must not observe a fact emitted before it subscribed.
	const deliveries = [...(bus.notifications.get(key) ?? [])].map((subscription) => ({
		subscription,
		generation: subscription.generation,
	}));
	queueMicrotask(() => {
		bus.pendingDeliveries = Math.max(0, bus.pendingDeliveries - 1);
		for (const { subscription, generation } of deliveries) {
			if (!subscription.active) continue;
			try {
				if (subscription.generation === generation) subscription.handler(notification);
			} catch {
				// Observational callbacks are isolated and cannot affect publication.
			}
		}
	});
}

/** Feed the server's explicit queue-overflow/refresh-required frame. */
export function publishHostNotificationRefreshRequired(
	transportSessionId: string,
	frame: HostNotificationRefreshFrame,
): void {
	if (!transportSessionId || !frame || (frame.scope !== "session" && frame.scope !== "project")) return;
	if (!validPosition({ epoch: frame.epoch, sequence: frame.sequence })) return;
	const bus = busFor(transportSessionId);
	const stream = bus.streams[frame.scope];
	if (stream.epoch !== frame.epoch || frame.sequence > stream.sequence) {
		stream.epoch = frame.epoch;
		stream.sequence = frame.sequence;
	}
	scheduleRefresh(bus, frame.scope);
}

/**
 * Authentication establishes a fresh ephemeral stream. Called for initial auth
 * and every reconnect; recent semantic IDs intentionally survive to suppress a
 * replayed envelope while both scopes refresh from authority.
 */
export function resetHostNotificationStreams(transportSessionId: string): void {
	if (!transportSessionId) return;
	const bus = busFor(transportSessionId);
	bus.streams.session = { sequence: 0 };
	bus.streams.project = { sequence: 0 };
	scheduleRefresh(bus, "session");
	scheduleRefresh(bus, "project");
}

/** Test-only reset; production lifetime follows the app session cache. */
export function __resetHostNotificationBusForTests(): void {
	buses.clear();
}
