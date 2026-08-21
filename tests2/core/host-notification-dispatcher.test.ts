import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HostNotificationDispatcher,
	HostNotificationModuleAdapter,
	type HostNotificationDeliveryAdapter,
	type HostNotificationModuleHandler,
} from "../../src/server/extension-host/host-notification-dispatcher.js";
import { buildHostNotification, type HostNotification } from "../../src/shared/extension-host/host-hooks.js";

async function settleFanout(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

function goalPublication() {
	return {
		projectId: "project-a",
		aggregateId: "goal-1",
		aggregateRevision: 7,
		correlationId: "correlation-1",
		payload: { goalId: "goal-1", state: "in-progress" as const, changedFields: ["title" as const] },
	};
}

function goalEvent(): HostNotification<"goalUpdated"> {
	return buildHostNotification("goalUpdated", {
		id: "notification-1",
		occurredAt: 100,
		projectId: "project-a",
		aggregateId: "goal-1",
		aggregateRevision: 7,
		correlationId: "correlation-1",
		payload: { goalId: "goal-1", state: "in-progress", changedFields: ["title"] },
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("HostNotificationDispatcher", () => {
	it("fans the exact frozen canonical envelope to every eligible consumer without retaining mutable input", async () => {
		const received = new Map<string, HostNotification>();
		const adapters: HostNotificationDeliveryAdapter[] = (["browser", "module", "staff"] as const).map(consumer => ({
			consumer,
			deliver(notification) { received.set(consumer, notification); },
		}));
		const dispatcher = new HostNotificationDispatcher({
			adapters,
			idGenerator: () => "notification-1",
			now: () => 100,
		});
		const publication = goalPublication();

		const published = dispatcher.publish("goalUpdated", publication);
		publication.payload.goalId = "mutated-after-publication";
		await settleFanout();

		expect(published).toBeDefined();
		expect(Object.isFrozen(published)).toBe(true);
		expect(Object.isFrozen(published!.aggregate)).toBe(true);
		expect(Object.isFrozen(published!.payload)).toBe(true);
		expect(published!.payload.goalId).toBe("goal-1");
		expect([...received.values()]).toHaveLength(3);
		for (const notification of received.values()) expect(notification).toBe(published);
	});

	it("fails closed on non-catalogue payload fields and keeps privacy sentinels out of bounded diagnostics", async () => {
		const delivered = vi.fn();
		const diagnostic = vi.fn();
		const dispatcher = new HostNotificationDispatcher({
			adapters: [{ consumer: "browser", deliver: delivered }],
			now: () => 101,
			onDiagnostic: diagnostic,
		});
		const tainted = {
			...goalPublication(),
			payload: { ...goalPublication().payload, rawPrompt: "FORBIDDEN_SENTINEL" },
		};

		expect(dispatcher.publish("goalUpdated", tainted as never)).toBeUndefined();
		await settleFanout();

		expect(delivered).not.toHaveBeenCalled();
		expect(dispatcher.getDiagnostics()).toEqual([
			expect.objectContaining({ code: "invalid_payload", projectId: "project-a", name: "goalUpdated" }),
		]);
		expect(JSON.stringify(dispatcher.getDiagnostics())).not.toContain("FORBIDDEN_SENTINEL");
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("FORBIDDEN_SENTINEL");
	});

	it("bounds each consumer queue, requests refresh after overflow, and isolates adapter failures", async () => {
		const browserDelivered: string[] = [];
		const refreshes: string[] = [];
		const moduleDelivered: string[] = [];
		let nextId = 0;
		const dispatcher = new HostNotificationDispatcher({
			queueCapacity: 1,
			idGenerator: () => `notification-${++nextId}`,
			now: () => 102,
			adapters: [
				{
					consumer: "browser",
					deliver(notification) {
						browserDelivered.push(notification.id);
						throw new Error("browser transport failed");
					},
					refreshRequired(notification) { refreshes.push(notification.id); },
				},
				{ consumer: "module", deliver(notification) { moduleDelivered.push(notification.id); } },
			],
		});

		expect(dispatcher.publish("goalUpdated", goalPublication())?.id).toBe("notification-1");
		expect(dispatcher.publish("goalUpdated", goalPublication())?.id).toBe("notification-2");
		await settleFanout();

		expect(browserDelivered).toEqual(["notification-1"]);
		expect(refreshes).toEqual(["notification-2"]);
		expect(moduleDelivered).toEqual(["notification-1"]);
		expect(dispatcher.getDiagnostics()).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: "queue_overflow", consumer: "browser" }),
			expect.objectContaining({ code: "queue_overflow", consumer: "module" }),
			expect.objectContaining({ code: "consumer_failure", consumer: "browser" }),
		]));
	});
});

describe("HostNotificationModuleAdapter", () => {
	const handler = (contributionId: string, overrides: Partial<HostNotificationModuleHandler> = {}): HostNotificationModuleHandler => ({
		projectId: "project-a",
		packId: "pack-a",
		contributionId,
		scope: "project",
		name: "goalUpdated",
		...overrides,
	});

	it("preserves resolver order and performs live authority checks before invocation and after settlement", async () => {
		const notification = goalEvent();
		const invoked: string[] = [];
		const authorityChecks: string[] = [];
		const diagnostics: Array<{ code: string; contributionId: string }> = [];
		const authorization = new Map([[
			"revoked-before", false,
		], ["revoked-after", true], ["second", true]]);
		const adapter = new HostNotificationModuleAdapter({
			resolve: () => [
				handler("revoked-before"),
				handler("foreign", { projectId: "project-b" }),
				handler("revoked-after"),
				handler("second"),
			],
			isAuthorized(current) {
				authorityChecks.push(current.contributionId);
				return authorization.get(current.contributionId) ?? false;
			},
			invoke(current, received) {
				expect(received).toBe(notification);
				invoked.push(current.contributionId);
				if (current.contributionId === "revoked-after") authorization.set("revoked-after", false);
			},
			onDiagnostic(row) { diagnostics.push(row); },
		});

		await adapter.deliver(notification);

		expect(invoked).toEqual(["revoked-after", "second"]);
		expect(authorityChecks).toEqual(["revoked-before", "revoked-after", "revoked-after", "second", "second"]);
		expect(diagnostics).toEqual([
			expect.objectContaining({ code: "handler_revoked", contributionId: "revoked-before" }),
			expect.objectContaining({ code: "handler_revoked", contributionId: "revoked-after" }),
		]);
	});

	it("enforces host deadlines and continues deterministically after timeout and handler failure", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const notification = goalEvent();
		const invoked: string[] = [];
		const aborted: string[] = [];
		const diagnostics: Array<{ code: string; contributionId: string }> = [];
		const adapter = new HostNotificationModuleAdapter({
			resolve: () => [handler("slow", { timeoutMs: 10 }), handler("throws"), handler("last")],
			isAuthorized: () => true,
			invoke(current, _received, signal) {
				invoked.push(current.contributionId);
				signal.addEventListener("abort", () => aborted.push(current.contributionId), { once: true });
				if (current.contributionId === "slow") return new Promise(() => {});
				if (current.contributionId === "throws") throw new Error("isolated failure");
			},
			onDiagnostic(row) { diagnostics.push(row); },
		});

		const delivery = adapter.deliver(notification);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
		await delivery;

		expect(invoked).toEqual(["slow", "throws", "last"]);
		expect(aborted).toEqual(["slow", "throws", "last"]);
		expect(diagnostics).toEqual([
			expect.objectContaining({ code: "handler_timeout", contributionId: "slow" }),
			expect.objectContaining({ code: "handler_failure", contributionId: "throws" }),
		]);
	});
});
