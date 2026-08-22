import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it, vi } from "vitest";
// Preserve the host-api module-cycle initialization order used by existing DOM tests.
import "../../src/app/session-manager.js";
import { getHostApi } from "../../src/app/host-api.js";
import {
	__resetHostNotificationBusForTests,
	publishHostNotificationFrame,
	publishHostNotificationRefreshRequired,
	resetHostNotificationStreams,
	subscribeHostNotification,
	subscribeHostNotificationRefresh,
} from "../../src/app/host-notification-bus.js";
import { publishClientStatus } from "../../src/app/session-event-bus.js";
import type { HostNotification } from "../../src/shared/extension-host/host-hooks.js";

const tick = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

function sessionEvent(id: string, statusVersion = 1): HostNotification<"statusChanged"> {
	return {
		id,
		scope: "session",
		name: "statusChanged",
		payloadVersion: 1,
		occurredAt: 100,
		projectId: "project-1",
		sessionId: "session-1",
		aggregate: { kind: "session", id: "session-1", revision: statusVersion },
		payload: { previousStatus: "starting", status: "idle", statusVersion },
	};
}

function projectEvent(id: string): HostNotification<"goalUpdated"> {
	return {
		id,
		scope: "project",
		name: "goalUpdated",
		payloadVersion: 1,
		occurredAt: 100,
		projectId: "project-1",
		aggregate: { kind: "goal", id: "goal-1", revision: 1 },
		payload: { goalId: "goal-1", state: "in-progress", changedFields: ["state"] },
	};
}

afterEach(() => {
	__resetHostNotificationBusForTests();
	vi.restoreAllMocks();
});

describe("canonical Extension Host notification bus", () => {
	it("routes typed session/project names only within the RemoteAgent-owned binding", async () => {
		const ownSession: string[] = [];
		const foreignSession: string[] = [];
		const project: string[] = [];
		subscribeHostNotification("session-1", "session", "statusChanged", (event) => ownSession.push(event.id));
		subscribeHostNotification("session-2", "session", "statusChanged", (event) => foreignSession.push(event.id));
		subscribeHostNotification("session-1", "project", "goalUpdated", (event) => project.push(event.id));

		publishHostNotificationFrame("session-1", { notification: sessionEvent("session-event"), stream: { epoch: "epoch-1", sequence: 1 } });
		publishHostNotificationFrame("session-1", { notification: projectEvent("project-event"), stream: { epoch: "epoch-1", sequence: 1 } });
		await tick();

		expect(ownSession).toEqual(["session-event"]);
		expect(project).toEqual(["project-event"]);
		expect(foreignSession).toEqual([]);
	});

	it("returns inert subscriptions when the host has no bound session", async () => {
		const handler = vi.fn();
		const refresh = vi.fn();
		const unsubscribe = subscribeHostNotification(undefined, "session", "statusChanged", handler);
		const unsubscribeRefresh = subscribeHostNotificationRefresh(undefined, "session", refresh);
		unsubscribe();
		unsubscribe();
		unsubscribeRefresh();
		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-1"), stream: { epoch: "epoch-1", sequence: 1 } });
		await tick();
		expect(handler).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("makes unsubscribe idempotent and fences callbacks already queued for delivery or refresh", async () => {
		const handler = vi.fn();
		const refresh = vi.fn();
		const unsubscribe = subscribeHostNotification("session-1", "session", "statusChanged", handler);
		const unsubscribeRefresh = subscribeHostNotificationRefresh("session-1", "session", refresh);
		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-1"), stream: { epoch: "epoch-1", sequence: 1 } });
		unsubscribe();
		unsubscribe();
		unsubscribeRefresh();
		unsubscribeRefresh();
		await tick();
		expect(handler).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("preserves ordered delivery and deduplicates recent semantic IDs", async () => {
		const ids: string[] = [];
		subscribeHostNotification("session-1", "session", "statusChanged", (event) => ids.push(event.id));
		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-1", 1), stream: { epoch: "epoch-1", sequence: 1 } });
		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-1", 2), stream: { epoch: "epoch-1", sequence: 2 } });
		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-2", 3), stream: { epoch: "epoch-1", sequence: 3 } });
		await tick();
		expect(ids).toEqual(["event-1", "event-2"]);
	});

	it("drops gap/epoch deltas and coalesces initial, gap, explicit, and reconnect refreshes", async () => {
		const ids: string[] = [];
		const refresh = vi.fn();
		subscribeHostNotification("session-1", "session", "statusChanged", (event) => ids.push(event.id));
		subscribeHostNotificationRefresh("session-1", "session", refresh);
		await tick();
		expect(refresh).toHaveBeenCalledTimes(1); // snapshot-first mount

		publishHostNotificationFrame("session-1", { notification: sessionEvent("event-1", 1), stream: { epoch: "epoch-1", sequence: 1 } });
		publishHostNotificationFrame("session-1", { notification: sessionEvent("gap-event", 3), stream: { epoch: "epoch-1", sequence: 3 } });
		publishHostNotificationRefreshRequired("session-1", { scope: "session", epoch: "epoch-1", sequence: 4 });
		await tick();
		expect(ids).toEqual(["event-1"]);
		expect(refresh).toHaveBeenCalledTimes(2);

		publishHostNotificationFrame("session-1", { notification: sessionEvent("new-epoch", 1), stream: { epoch: "epoch-2", sequence: 1 } });
		resetHostNotificationStreams("session-1");
		await tick();
		expect(ids).toEqual(["event-1"]);
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it("keeps recent-ID dedupe across reconnect while resetting sequence state", async () => {
		const ids: string[] = [];
		subscribeHostNotification("session-1", "session", "statusChanged", (event) => ids.push(event.id));
		publishHostNotificationFrame("session-1", { notification: sessionEvent("stable-id"), stream: { epoch: "epoch-1", sequence: 1 } });
		await tick();
		resetHostNotificationStreams("session-1");
		publishHostNotificationFrame("session-1", { notification: sessionEvent("stable-id"), stream: { epoch: "epoch-2", sequence: 1 } });
		await tick();
		expect(ids).toEqual(["stable-id"]);
	});
});

describe("additive scoped Host API", () => {
	it("exposes contract v5 flags and server-bound session/project namespaces", async () => {
		const host = getHostApi("session-1", undefined, {
			kind: "pack",
			packId: "fixture",
			contributionKind: "panel",
			contributionId: "fixture-panel",
		});
		expect(host.version).toBe(1);
		expect(host.contractVersion).toBe(6);
		expect(host.capabilities.sessionNotifications).toBe(true);
		expect(host.capabilities.projectNotifications).toBe(true);
		expect(host.capabilities.has("sessionNotifications")).toBe(true);
		expect(host.capabilities.has("projectNotifications")).toBe(true);

		const session = vi.fn();
		const project = vi.fn();
		const stopSession = host.session.notifications.subscribe("statusChanged", session);
		const stopProject = host.project.notifications.subscribe("goalUpdated", project);
		publishHostNotificationFrame("session-1", { notification: sessionEvent("session-event"), stream: { epoch: "epoch-1", sequence: 1 } });
		publishHostNotificationFrame("session-1", { notification: projectEvent("project-event"), stream: { epoch: "epoch-1", sequence: 1 } });
		await tick();
		expect(session).toHaveBeenCalledWith(expect.objectContaining({ id: "session-event", scope: "session" }));
		expect(project).toHaveBeenCalledWith(expect.objectContaining({ id: "project-event", scope: "project" }));
		stopSession();
		stopProject();
	});

	it("keeps legacy host.session.subscribe payloads unchanged", () => {
		const host = getHostApi("session-1", undefined);
		const payloads: unknown[] = [];
		const unsubscribe = host.session.subscribe("status", (payload) => payloads.push(payload));
		publishClientStatus("session-1", "streaming", "legacy detail");
		expect(payloads).toEqual([{ status: "running", detail: "legacy detail" }]);
		unsubscribe();
	});
});
