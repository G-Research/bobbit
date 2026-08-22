import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { HostNotificationDispatcher } from "../../src/server/extension-host/host-notification-dispatcher.js";
import {
	HostNotificationSocketRouter,
	bindHostNotificationSocket,
	unbindHostNotificationSocket,
} from "../../src/server/extension-host/host-notification-socket-router.js";
import type { ServerMessage } from "../../src/server/ws/protocol.js";

interface FakeSocket {
	readyState: number;
	bufferedAmount: number;
	authenticated?: boolean;
	isViewer?: boolean;
	authPrincipal?: { kind: "admin" | "sandbox" | "localhost" };
	frames: ServerMessage[];
	sendErrors: Array<Error | undefined>;
	closes: Array<{ code?: number; reason?: string }>;
	terminated: boolean;
	closeListeners: Array<() => void>;
	send(data: string, callback?: (error?: Error) => void): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	once(event: string, listener: () => void): void;
	emitClose(): void;
}

const socketsToUnbind: WebSocket[] = [];

function socket(overrides: Partial<FakeSocket> = {}): FakeSocket {
	const ws: FakeSocket = {
		readyState: 1,
		bufferedAmount: 0,
		authenticated: true,
		authPrincipal: { kind: "admin" },
		frames: [],
		sendErrors: [],
		closes: [],
		terminated: false,
		closeListeners: [],
		send(data, callback) {
			this.frames.push(JSON.parse(data) as ServerMessage);
			callback?.(this.sendErrors.shift());
		},
		close(code, reason) {
			this.closes.push({ code, reason });
			this.readyState = 3;
		},
		terminate() { this.terminated = true; },
		once(event, listener) {
			if (event === "close") this.closeListeners.push(listener);
		},
		emitClose() {
			this.readyState = 3;
			for (const listener of this.closeListeners.splice(0)) listener();
		},
		...overrides,
	};
	return ws;
}

function bind(ws: FakeSocket, sessionId: string, projectId: string): void {
	const real = ws as unknown as WebSocket;
	bindHostNotificationSocket(real, { sessionId, projectId });
	socketsToUnbind.push(real);
}

async function settleRouting(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setImmediate(resolve));
}

afterEach(() => {
	for (const ws of socketsToUnbind.splice(0)) unbindHostNotificationSocket(ws);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function sessionPublication() {
	return {
		projectId: "project-a",
		sessionId: "session-a",
		aggregateId: "session-a",
		aggregateRevision: 1,
		payload: { previousStatus: "starting" as const, status: "idle" as const, statusVersion: 1 },
	};
}

function projectPublication() {
	return {
		projectId: "project-a",
		aggregateId: "goal-1",
		aggregateRevision: 2,
		payload: { goalId: "goal-1", state: "in-progress" as const, changedFields: ["title" as const] },
	};
}

function names(ws: FakeSocket): string[] {
	return ws.frames.flatMap(frame => frame.type === "host_notification" ? [frame.notification.name] : []);
}

function resolveTestSessionProject(sessionId: string): string | undefined {
	if (sessionId === "session-a" || sessionId === "session-b") return "project-a";
	if (sessionId === "session-c") return "project-b";
	return undefined;
}

describe("canonical host notification socket routing", () => {
	it("routes session facts to the exact server binding and project facts only to same-project app sockets", async () => {
		const exact = socket();
		const siblingSession = socket();
		const foreignProject = socket();
		const unbound = socket();
		const viewer = socket({ isViewer: true });
		const unauthenticated = socket({ authenticated: false });
		bind(exact, "session-a", "project-a");
		bind(siblingSession, "session-b", "project-a");
		bind(foreignProject, "session-c", "project-b");
		bind(viewer, "session-a", "project-a");
		bind(unauthenticated, "session-a", "project-a");
		const all = [exact, siblingSession, foreignProject, unbound, viewer, unauthenticated];
		const router = new HostNotificationSocketRouter(all as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			epochGenerator: () => "epoch",
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: sessionId => sessionId === "session-a" || sessionId === "session-b" ? "project-a" : undefined,
			idGenerator: (() => { let id = 0; return () => `notification-${++id}`; })(),
			now: () => 10,
		});

		expect(dispatcher.publish("statusChanged", sessionPublication())).toBeDefined();
		expect(dispatcher.publish("goalUpdated", projectPublication())).toBeDefined();
		await settleRouting();

		expect(names(exact)).toEqual(["statusChanged", "goalUpdated"]);
		expect(names(siblingSession)).toEqual(["goalUpdated"]);
		expect(names(foreignProject)).toEqual([]);
		expect(names(unbound)).toEqual([]);
		expect(names(viewer)).toEqual([]);
		expect(names(unauthenticated)).toEqual([]);
		const exactNotifications = exact.frames.filter(frame => frame.type === "host_notification");
		expect(exactNotifications.map(frame => frame.notification.projectId)).toEqual(["project-a", "project-a"]);
	});

	it("rebinds a moved session from host authority and refreshes before new-project deltas", async () => {
		const exact = socket();
		bind(exact, "session-a", "project-a");
		let authoritativeProject: string | undefined = "project-a";
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: sessionId => sessionId === "session-a" ? authoritativeProject : undefined,
			epochGenerator: () => "project-epoch",
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			idGenerator: (() => { let id = 0; return () => `moved-${++id}`; })(),
			now: () => 12,
		});

		authoritativeProject = "project-b";
		dispatcher.publish("goalUpdated", projectPublication());
		// A new-project delta racing the coalesced refresh must also be suppressed.
		dispatcher.publish("goalUpdated", { ...projectPublication(), projectId: "project-b", aggregateRevision: 3 });
		await settleRouting();

		expect(exact.frames).toEqual([
			expect.objectContaining({
				type: "host_notifications_refresh_required",
				scope: "project",
				epoch: "project-epoch",
				sequence: 1,
			}),
		]);

		dispatcher.publish("goalUpdated", { ...projectPublication(), projectId: "project-b", aggregateRevision: 4 });
		dispatcher.publish("goalUpdated", { ...projectPublication(), projectId: "project-c", aggregateRevision: 5 });
		await settleRouting();

		expect(exact.frames.slice(1)).toEqual([
			expect.objectContaining({
				type: "host_notification",
				notification: expect.objectContaining({ projectId: "project-b" }),
				stream: { epoch: "project-epoch", sequence: 2 },
			}),
		]);
	});

	it("unbinds and fails closed when live session authority disappears", async () => {
		const exact = socket();
		bind(exact, "session-a", "project-a");
		let authoritativeProject: string | undefined;
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: () => authoritativeProject,
		});
		const dispatcher = new HostNotificationDispatcher({ adapters: [router] });

		dispatcher.publish("goalUpdated", projectPublication());
		await settleRouting();
		authoritativeProject = "project-a";
		dispatcher.publish("goalUpdated", { ...projectPublication(), aggregateRevision: 3 });
		await settleRouting();

		expect(exact.frames).toEqual([]);
	});

	it("revalidates a pressured refresh and replaces a stale session refresh with a project refresh", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const exact = socket({ bufferedAmount: 100 });
		bind(exact, "session-a", "project-a");
		let authoritativeProject = "project-a";
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: () => authoritativeProject,
			maxBufferedBytes: 10,
			refreshRetryDelayMs: 5,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => authoritativeProject,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		await settleRouting();
		authoritativeProject = "project-b";
		exact.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(5);
		await settleRouting();

		expect(exact.frames).toEqual([
			expect.objectContaining({ type: "host_notifications_refresh_required", scope: "project", sequence: 1 }),
		]);
	});

	it("refuses sandbox-principal bindings and rechecks principal authority for deltas and refreshes", async () => {
		const sandbox = socket({ authPrincipal: { kind: "sandbox" } });
		const revoked = socket();
		bind(sandbox, "session-a", "project-a");
		bind(revoked, "session-a", "project-a");
		revoked.authPrincipal = { kind: "sandbox" };
		const router = new HostNotificationSocketRouter([sandbox, revoked] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			epochGenerator: () => "epoch",
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			idGenerator: () => "notification-1",
			now: () => 15,
		});

		const notification = dispatcher.publish("statusChanged", sessionPublication());
		expect(notification).toBeDefined();
		router.refreshRequired(notification!);
		await settleRouting();

		expect(sandbox.frames).toEqual([]);
		expect(revoked.frames).toEqual([]);
	});

	it("cancels an already-scheduled refresh when UI principal authority is revoked", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const exact = socket({ bufferedAmount: 100 });
		bind(exact, "session-a", "project-a");
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			maxBufferedBytes: 10,
			refreshRetryDelayMs: 5,
			maxRefreshRetries: 3,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			now: () => 16,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		await settleRouting();
		expect(vi.getTimerCount()).toBe(1);

		exact.authPrincipal = { kind: "sandbox" };
		exact.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(5);

		expect(exact.frames).toEqual([]);
		expect(exact.closes).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses independent scope epochs, monotonic sequences, and one coalesced refresh frame after dispatcher gaps", async () => {
		const exact = socket();
		bind(exact, "session-a", "project-a");
		let epoch = 0;
		let notificationId = 0;
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			epochGenerator: () => `epoch-${++epoch}`,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			queueCapacity: 1,
			resolveSessionProject: sessionId => sessionId === "session-a" ? "project-a" : undefined,
			idGenerator: () => `notification-${++notificationId}`,
			now: () => 20,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		dispatcher.publish("statusChanged", { ...sessionPublication(), aggregateRevision: 2, payload: { ...sessionPublication().payload, statusVersion: 2 } });
		dispatcher.publish("statusChanged", { ...sessionPublication(), aggregateRevision: 3, payload: { ...sessionPublication().payload, statusVersion: 3 } });
		await settleRouting();

		expect(exact.frames).toEqual([
			expect.objectContaining({ type: "host_notification", stream: { epoch: "epoch-1", sequence: 1 } }),
			expect.objectContaining({ type: "host_notifications_refresh_required", scope: "session", epoch: "epoch-1", sequence: 2 }),
		]);
		expect(dispatcher.getDiagnostics().filter(row => row.code === "queue_overflow")).toHaveLength(2);

		dispatcher.publish("statusChanged", { ...sessionPublication(), aggregateRevision: 4, payload: { ...sessionPublication().payload, statusVersion: 4 } });
		await settleRouting();
		dispatcher.publish("goalUpdated", projectPublication());
		await settleRouting();
		dispatcher.publish("goalUpdated", { ...projectPublication(), aggregateRevision: 3 });
		await settleRouting();

		expect(exact.frames.slice(2)).toEqual([
			expect.objectContaining({ type: "host_notification", stream: { epoch: "epoch-1", sequence: 3 } }),
			expect.objectContaining({ type: "host_notification", stream: { epoch: "epoch-2", sequence: 1 } }),
			expect.objectContaining({ type: "host_notification", stream: { epoch: "epoch-2", sequence: 2 } }),
		]);
	});

	it("retries a final pressure gap without another event while preserving healthy peer order", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pressured = socket({ bufferedAmount: 100 });
		const healthy = socket();
		bind(pressured, "session-a", "project-a");
		bind(healthy, "session-a", "project-a");
		const router = new HostNotificationSocketRouter([pressured, healthy] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			epochGenerator: (() => { let epoch = 0; return () => `epoch-${++epoch}`; })(),
			maxBufferedBytes: 10,
			refreshRetryDelayMs: 5,
			maxRefreshRetries: 4,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			idGenerator: (() => { let id = 0; return () => `notification-${++id}`; })(),
			now: () => 30,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		dispatcher.publish("statusChanged", {
			...sessionPublication(),
			aggregateRevision: 2,
			payload: { ...sessionPublication().payload, statusVersion: 2 },
		});
		await settleRouting();

		expect(pressured.frames).toEqual([]);
		expect(healthy.frames).toEqual([
			expect.objectContaining({ type: "host_notification", stream: expect.objectContaining({ sequence: 1 }) }),
			expect.objectContaining({ type: "host_notification", stream: expect.objectContaining({ sequence: 2 }) }),
		]);
		expect(healthy.frames.flatMap(frame => frame.type === "host_notification"
			? [frame.notification.aggregate.revision]
			: [])).toEqual([1, 2]);

		pressured.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(5);

		expect(pressured.frames).toEqual([
			expect.objectContaining({ type: "host_notifications_refresh_required", scope: "session", sequence: 1 }),
		]);
		expect(names(healthy)).toEqual(["statusChanged", "statusChanged"]);
	});

	it("retries failed delta and refresh sends without another event", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const exact = socket({ sendErrors: [new Error("delta failed"), new Error("refresh failed"), undefined] });
		bind(exact, "session-a", "project-a");
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			epochGenerator: () => "epoch",
			refreshRetryDelayMs: 7,
			maxRefreshRetries: 4,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			idGenerator: () => "notification-1",
			now: () => 40,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		await settleRouting();
		expect(exact.frames.map(frame => frame.type)).toEqual([
			"host_notification",
			"host_notifications_refresh_required",
		]);

		await vi.advanceTimersByTimeAsync(7);

		expect(exact.frames).toEqual([
			expect.objectContaining({ type: "host_notification", stream: { epoch: "epoch", sequence: 1 } }),
			expect.objectContaining({ type: "host_notifications_refresh_required", epoch: "epoch", sequence: 2 }),
			expect.objectContaining({ type: "host_notifications_refresh_required", epoch: "epoch", sequence: 3 }),
		]);
		expect(exact.closes).toEqual([]);
	});

	it("closes with 1013 after persistent refresh pressure", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const exact = socket({ bufferedAmount: 100 });
		bind(exact, "session-a", "project-a");
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			maxBufferedBytes: 10,
			refreshRetryDelayMs: 5,
			maxRefreshRetries: 3,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			now: () => 50,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		await settleRouting();
		await vi.advanceTimersByTimeAsync(5);
		expect(exact.closes).toEqual([]);
		await vi.advanceTimersByTimeAsync(10);

		expect(exact.closes).toEqual([{ code: 1013, reason: "host notification refresh required" }]);
		expect(exact.terminated).toBe(false);
		expect(exact.frames).toEqual([]);
	});

	it("cancels pending refresh retries when the socket closes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const exact = socket({ bufferedAmount: 100 });
		bind(exact, "session-a", "project-a");
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
			resolveSessionProject: resolveTestSessionProject,
			maxBufferedBytes: 10,
			refreshRetryDelayMs: 5,
			maxRefreshRetries: 3,
		});
		const dispatcher = new HostNotificationDispatcher({
			adapters: [router],
			resolveSessionProject: () => "project-a",
			now: () => 60,
		});

		dispatcher.publish("statusChanged", sessionPublication());
		await settleRouting();
		expect(vi.getTimerCount()).toBe(1);

		exact.emitClose();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(exact.frames).toEqual([]);
		expect(exact.closes).toEqual([]);
		expect(exact.terminated).toBe(false);
	});
});
