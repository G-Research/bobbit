import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HOST_NOTIFICATION_CATALOGUE, type HostNotification } from "../../../src/shared/extension-host/host-hooks.js";
import { InboxManager } from "../../../src/server/agent/inbox-manager.js";
import { InboxStore } from "../../../src/server/agent/inbox-store.js";
import { NotificationDeliveryStore } from "../../../src/server/agent/notification-delivery-store.js";
import {
	NotificationStaffDispatcher,
	notificationDeliveryId,
} from "../../../src/server/agent/notification-staff-dispatcher.js";
import { StaffManager } from "../../../src/server/agent/staff-manager.js";
import { StaffStore, type PersistedStaff } from "../../../src/server/agent/staff-store.js";
import { createMemFs } from "../../../tests2/harness/mem-fs.js";

const cleanupDirs: string[] = [];
afterAll(() => {
	for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function clockHarness(start = 10_000) {
	let now = start;
	return {
		clock: {
			now: () => now,
			setTimeout: globalThis.setTimeout,
			setInterval: globalThis.setInterval,
			clearTimeout: globalThis.clearTimeout,
			clearInterval: globalThis.clearInterval,
		},
		advance(ms: number) { now += ms; },
	};
}

function notification(name: "toolCallCompleted" = "toolCallCompleted", projectId = "project-a"): HostNotification<"toolCallCompleted"> {
	const definition = HOST_NOTIFICATION_CATALOGUE[name];
	return {
		id: "notification-1",
		scope: "session",
		name,
		payloadVersion: definition.payloadVersion,
		occurredAt: 9_000,
		projectId,
		sessionId: "session-1",
		aggregate: { kind: definition.aggregateKind, id: "tool-call-1", revision: 7 },
		correlationId: "correlation-1",
		causationId: "causation-1",
		payload: {
			toolCallId: "tool-call-1",
			toolName: "example_tool",
			status: "succeeded",
			durationMs: 12,
		},
	} as HostNotification<"toolCallCompleted">;
}

function projectNotification(projectId = "project-a"): HostNotification<"goalUpdated"> {
	const definition = HOST_NOTIFICATION_CATALOGUE.goalUpdated;
	return {
		id: "notification-goal-1",
		scope: "project",
		name: "goalUpdated",
		payloadVersion: definition.payloadVersion,
		occurredAt: 9_100,
		projectId,
		aggregate: { kind: definition.aggregateKind, id: "goal-1", revision: 8 },
		correlationId: "correlation-goal-1",
		payload: { goalId: "goal-1", state: "in-progress", changedFields: ["state"] },
	} as HostNotification<"goalUpdated">;
}

function staffRecord(projectId = "project-a"): PersistedStaff {
	return {
		id: "staff-1",
		name: "Observer",
		description: "",
		systemPrompt: "Observe committed facts",
		cwd: "/repo",
		state: "active",
		triggers: [
			{ id: "legacy-goal", type: "goal_created", config: {}, enabled: true, prompt: "legacy" },
			{
				id: "notify-tool",
				type: "notification",
				notification: { scope: "session", name: "toolCallCompleted" },
				filter: { toolName: "example_tool", status: "succeeded" },
				enabled: true,
			},
		],
		memory: "",
		accessory: "none",
		createdAt: 1,
		updatedAt: 1,
		projectId,
		sandboxed: false,
	};
}

function harness() {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/notification-staff/project-a");
	memfs.mkdirSync(stateDir, { recursive: true });
	const staff = staffRecord();
	const inboxStore = new InboxStore(stateDir, memfs);
	const ctx = {
		project: { id: "project-a" },
		stateDir,
		staffStore: { get: (id: string) => id === staff.id ? staff : undefined },
		inboxStore,
	};
	const pcm = {
		getOrCreate: (id: string) => id === "project-a" ? ctx : null,
		all: () => [ctx][Symbol.iterator](),
	};
	const updates: unknown[] = [];
	let reconciler: ((projectId: string, staffId: string) => void) | null = null;
	const staffManager = {
		listStaff: (projectId?: string) => !projectId || projectId === staff.projectId ? [staff] : [],
		getStaff: (id: string) => id === staff.id ? staff : undefined,
		updateTriggerState: (staffId: string, triggerId: string, update: unknown) => { updates.push({ staffId, triggerId, update }); return true; },
		setNotificationDeliveryReconciler: (next: typeof reconciler) => { reconciler = next; },
	};
	const inbox = new InboxManager(pcm as never, staffManager as never, () => undefined);
	const timer = clockHarness();
	let deliveryStore = new NotificationDeliveryStore(stateDir, "project-a", memfs, timer.clock);
	const dispatcher = new NotificationStaffDispatcher(pcm as never, staffManager as never, inbox, {
		clock: timer.clock,
		storeFactory: () => deliveryStore,
	});
	return { memfs, stateDir, staff, pcm, inbox, inboxStore, timer, dispatcher, staffManager, updates, get reconciler() { return reconciler; }, get store() { return deliveryStore; }, replaceStore(store: NotificationDeliveryStore) { deliveryStore = store; } };
}

async function flushMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("notification staff delivery", () => {
	it("persists and delivers the exact canonical envelope under a deterministic inbox id", async () => {
		const h = harness();
		const event = notification();
		expect(h.dispatcher.enqueueNow(event)).toBe(1);
		await flushMicrotasks();

		const deliveryId = notificationDeliveryId("staff-1", "notify-tool", event.id);
		const row = h.store.get(deliveryId)!;
		expect(row.state).toBe("accepted");
		expect(row.notification).toEqual(event);
		const entries = h.inboxStore.list("staff-1");
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(deliveryId);
		expect(entries[0].source).toEqual({ type: "notification", triggerId: "notify-tool" });
		expect(entries[0].notificationInput?.notification).toEqual(event);
		expect(entries[0].prompt).not.toContain(event.payload.toolName);

		// Duplicate fanout, a new event in the same host-owned root, and the
		// unrelated legacy trigger cannot double wake this subscriber.
		expect(h.dispatcher.enqueueNow(event)).toBe(0);
		expect(h.dispatcher.enqueueNow({ ...event, id: "notification-2" })).toBe(0);
		await flushMicrotasks();
		expect(h.inboxStore.list("staff-1")).toHaveLength(1);
	});

	it("delivers project facts through the same byte-equivalent canonical contract", async () => {
		const h = harness();
		h.staff.triggers.push({
			id: "notify-goal",
			type: "notification",
			notification: { scope: "project", name: "goalUpdated" },
			filter: { state: "in-progress" },
			enabled: true,
		});
		const event = projectNotification();
		expect(h.dispatcher.enqueueNow(event)).toBe(1);
		await flushMicrotasks();
		const entry = h.inboxStore.list("staff-1")[0];
		expect(entry.notificationInput?.notification).toEqual(event);
		expect(entry.notificationInput?.notification.aggregate.revision).toBe(8);
	});

	it("fails closed for wrong projects, unsupported selectors, and forbidden payload fields", async () => {
		const h = harness();
		expect(h.dispatcher.enqueueNow(notification("toolCallCompleted", "project-b"))).toBe(0);
		const tainted = {
			...notification(),
			payload: { ...notification().payload, rawPrompt: "FORBIDDEN_SENTINEL" },
		} as HostNotification;
		expect(h.dispatcher.enqueueNow(tainted)).toBe(0);
		await flushMicrotasks();
		expect(h.inboxStore.list("staff-1")).toHaveLength(0);
		expect(Array.from(h.memfs.files.values()).join("\n")).not.toContain("FORBIDDEN_SENTINEL");
	});

	it("reconciles a crash after inbox commit without inserting a duplicate", async () => {
		const h = harness();
		const finishSpy = vi.spyOn(h.store, "finishLease").mockImplementation(() => { throw Object.assign(new Error("crash"), { code: "UNAVAILABLE" }); });
		h.dispatcher.enqueueNow(notification());
		await flushMicrotasks();
		expect(h.inboxStore.list("staff-1")).toHaveLength(1);
		finishSpy.mockRestore();

		h.timer.advance(31_000);
		const restartedStore = new NotificationDeliveryStore(h.stateDir, "project-a", h.memfs, h.timer.clock);
		h.replaceStore(restartedStore);
		const restarted = new NotificationStaffDispatcher(h.pcm as never, h.staffManager as never, h.inbox, {
			clock: h.timer.clock,
			storeFactory: () => restartedStore,
		});
		restarted.reconcileProject("project-a");
		expect(restartedStore.list()[0].state).toBe("accepted");
		expect(h.inboxStore.list("staff-1")).toHaveLength(1);
	});

	it("cancels pending delivery when its notification trigger is disabled", async () => {
		const h = harness();
		vi.spyOn(h.inbox, "enqueueWithId").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EAGAIN" }); });
		h.dispatcher.enqueueNow(notification());
		await flushMicrotasks();
		expect(h.store.list()[0].state).toBe("pending");
		(h.staff.triggers.find((trigger) => trigger.id === "notify-tool")!).enabled = false;
		h.reconciler?.("project-a", "staff-1");
		expect(h.store.list()[0].state).toBe("cancelled");
	});
});

describe("notification trigger validation and staff facts", () => {
	it("validates catalogue-owned selectors and exact scalar filters", () => {
		const pcm = { all: () => [][Symbol.iterator]() };
		const manager = new StaffManager(pcm as never);
		expect(() => manager.validateTriggers(staffRecord().triggers)).not.toThrow();
		expect(() => manager.validateTriggers([{
			id: "bad", type: "notification", notification: { scope: "project", name: "toolCallCompleted" }, filter: {}, enabled: true,
		} as never])).toThrow(/Invalid notification trigger/);
		expect(() => manager.validateTriggers([{
			id: "bad-filter", type: "notification", notification: { scope: "session", name: "toolCallCompleted" }, filter: { rawPrompt: "x" }, enabled: true,
		} as never])).toThrow(/Invalid notification trigger/);
	});

	it("publishes bounded config, retirement, and session facts only after strict store updates", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "notification-staff-facts-"));
		cleanupDirs.push(root);
		const store = new StaffStore(root);
		const staff = staffRecord();
		store.putStrict(staff);
		const ctx = { project: { id: "project-a" }, staffStore: store, searchIndex: { indexStaff: vi.fn() } };
		const pcm = {
			all: () => [ctx][Symbol.iterator](),
			getOrCreate: (id: string) => id === "project-a" ? ctx : null,
		};
		const manager = new StaffManager(pcm as never);
		const publish = vi.fn();
		manager.setStaffNotificationPublisher({ publish });
		expect(manager.updateStaff("staff-1", { description: "changed", state: "retired" })).toBe(true);
		expect(manager.commitCurrentSession("staff-1", "session-new")).toBe(true);
		expect(publish.mock.calls.map((call) => call[0])).toEqual([
			"staffConfigChanged", "staffRetired", "staffSessionChanged",
		]);
		expect(publish.mock.calls[0][1].payload).toEqual({ staffId: "staff-1", changedFields: ["description", "state"] });
	});
});
