import { afterEach, describe, expect, it } from "vitest";
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
	frames: ServerMessage[];
	send(data: string): void;
}

const socketsToUnbind: WebSocket[] = [];

function socket(overrides: Partial<FakeSocket> = {}): FakeSocket {
	const ws: FakeSocket = {
		readyState: 1,
		bufferedAmount: 0,
		authenticated: true,
		frames: [],
		send(data) { this.frames.push(JSON.parse(data) as ServerMessage); },
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
		bind(foreignProject, "session-a", "project-b");
		bind(viewer, "session-a", "project-a");
		bind(unauthenticated, "session-a", "project-a");
		const all = [exact, siblingSession, foreignProject, unbound, viewer, unauthenticated];
		const router = new HostNotificationSocketRouter(all as unknown as WebSocket[], { epochGenerator: () => "epoch" });
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

	it("uses independent scope epochs, monotonic sequences, and one coalesced refresh frame after dispatcher gaps", async () => {
		const exact = socket();
		bind(exact, "session-a", "project-a");
		let epoch = 0;
		let notificationId = 0;
		const router = new HostNotificationSocketRouter([exact] as unknown as WebSocket[], {
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
});
