import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePersistedInFlightSteers } from "../../src/server/agent/session-store.js";
import {
	barrier,
	flushMicrotasks,
	makeReliableIntentHarness,
	type ReliableIntentHarness,
} from "./helpers/reliable-intent-fixture.js";

const harnesses: ReliableIntentHarness[] = [];
const useHarness = (overrides: Record<string, any> = {}) => {
	const harness = makeReliableIntentHarness(overrides);
	harnesses.push(harness);
	return harness;
};

function ledgerFor(session: any, intentId: string): any {
	return session.inFlightSteerTexts?.find((record: any) => record.intentId === intentId);
}

function userStart(text: string, entryId: string) {
	return {
		type: "message_start",
		entryId,
		message: { id: entryId, role: "user", content: [{ type: "text", text }] },
	};
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	vi.restoreAllMocks();
});

describe("reliable intent dispatch attempt settlement", () => {
	it("keeps a steer dispatching after RPC acknowledgement and settles only on correlated user start", async () => {
		const ack = barrier<any>();
		const steer = vi.fn(() => ack.hold());
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		const dispatch = manager.deliverLiveSteer(session.id, "held until echo", { intentId: "intent-held" });
		await ack.entered;
		const beforeAck = ledgerFor(session, "intent-held");
		expect(beforeAck).toMatchObject({
			intentId: "intent-held",
			state: "dispatching",
			targetTurn: "continuation",
		});
		expect(beforeAck.attemptId).toMatch(/^attempt:/);
		expect(beforeAck.dispatchEpoch).toEqual(expect.any(Number));

		ack.release({ success: true });
		await dispatch;
		expect(ledgerFor(session, "intent-held")?.state).toBe("dispatching");

		const visible = manager.prepareVisibleAgentEvent(session, userStart("held until echo", "pi-entry-held"));
		manager.handleAgentLifecycle(session, visible);

		expect(visible.deliveryIntentId).toBe("intent-held");
		expect(ledgerFor(session, "intent-held")).toBeUndefined();
	});

	it("serializes rapid identical steers and correlates each occurrence exactly once", async () => {
		const firstAck = barrier<any>();
		const secondAck = barrier<any>();
		const gates = [firstAck, secondAck];
		const steer = vi.fn(() => gates[steer.mock.calls.length - 1].hold());
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		const first = manager.deliverLiveSteer(session.id, "same steer", { intentId: "intent-A" });
		await firstAck.entered;
		const second = manager.deliverLiveSteer(session.id, "same steer", { intentId: "intent-B" });
		await flushMicrotasks();
		expect(steer).toHaveBeenCalledTimes(1);

		firstAck.release({ success: true });
		await first;
		await secondAck.entered;
		secondAck.release({ success: true });
		await second;

		const firstVisible = manager.prepareVisibleAgentEvent(session, userStart("same steer", "pi-same-A"));
		manager.handleAgentLifecycle(session, firstVisible);
		const secondVisible = manager.prepareVisibleAgentEvent(session, userStart("same steer", "pi-same-B"));
		manager.handleAgentLifecycle(session, secondVisible);

		expect([firstVisible.deliveryIntentId, secondVisible.deliveryIntentId]).toEqual([
			"intent-A", "intent-B",
		]);
		expect(session.inFlightSteerTexts).toEqual([]);
	});

	it("deduplicates replayed admission for one intent while its attempt is active", async () => {
		const ack = barrier<any>();
		const steer = vi.fn(() => ack.hold());
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		const original = manager.deliverLiveSteer(session.id, "send once", { intentId: "intent-once" });
		await ack.entered;
		const replay = manager.deliverLiveSteer(session.id, "send once", { intentId: "intent-once" });
		await flushMicrotasks();

		expect(steer).toHaveBeenCalledTimes(1);
		expect(session.inFlightSteerTexts.filter((row: any) => row.intentId === "intent-once")).toHaveLength(1);
		ack.release({ success: true });
		await Promise.all([original, replay]);
	});

	it("marks a definite bridge rejection failed and preserves the original retry identity", async () => {
		const steer = vi.fn(async () => ({ success: false, error: "steer rejected before admission" }));
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(manager.deliverLiveSteer(session.id, "retry me", { intentId: "intent-failed" }))
			.rejects.toThrow(/steer rejected/i);

		expect(session.inFlightSteerTexts).toEqual([]);
		expect(session.promptQueue.toArray()).toMatchObject([{
			id: "intent-failed",
			kind: "steer",
			targetTurn: "continuation",
			deliveryState: "failed",
		}]);
	});

	it("treats a post-dispatch transport failure as uncertain instead of retrying", async () => {
		const steer = vi.fn(async () => { throw new Error("socket closed after write"); });
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(manager.deliverLiveSteer(session.id, "may have landed", { intentId: "intent-uncertain" }))
			.rejects.toThrow(/socket closed/i);

		expect(session.promptQueue.toArray().some((row: any) => row.id === "intent-uncertain")).toBe(false);
		expect(ledgerFor(session, "intent-uncertain")).toMatchObject({
			state: "uncertain",
			retryable: false,
		});
	});
});

describe("reliable intent abort and stale-attempt fences", () => {
	it("does not restore or rebind an acknowledged steer stopped before its user start", async () => {
		const steer = vi.fn(async () => ({ success: true }));
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		await manager.deliverLiveSteer(session.id, "late after stop", { intentId: "intent-late" });
		const attemptId = ledgerFor(session, "intent-late")?.attemptId;
		manager._reconcileAfterAbort(session);

		expect(session.promptQueue.toArray().some((row: any) => row.id === "intent-late")).toBe(false);
		expect(ledgerFor(session, "intent-late")).toMatchObject({
			attemptId,
			state: "uncertain",
			retryable: false,
		});

		const lateStart = manager.prepareVisibleAgentEvent(session, userStart("late after stop", "pi-late"));
		manager.handleAgentLifecycle(session, lateStart);
		expect(lateStart.deliveryIntentId).toBe("intent-late");
		expect(ledgerFor(session, "intent-late")).toBeUndefined();
		expect(session.promptQueue.toArray().some((row: any) => row.id === "intent-late")).toBe(false);
	});

	it("leaves an attempt uncertain when Stop wins before its RPC acknowledgement", async () => {
		const ack = barrier<any>();
		const steer = vi.fn(() => ack.hold());
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		const pending = manager.deliverLiveSteer(session.id, "stop before ack", { intentId: "intent-pre-ack" });
		await ack.entered;
		manager._reconcileAfterAbort(session);
		expect(ledgerFor(session, "intent-pre-ack")?.state).toBe("uncertain");
		expect(session.promptQueue.toArray().some((row: any) => row.id === "intent-pre-ack")).toBe(false);

		ack.release({ success: true });
		await pending;
		expect(ledgerFor(session, "intent-pre-ack")?.state).toBe("uncertain");
	});

	it("restores a proven-no-start attempt once, retargeted ahead of later next-turn work", async () => {
		const steer = vi.fn(async () => ({ success: true }));
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		await manager.deliverLiveSteer(session.id, "restore after proof", { intentId: "intent-proven-no-start" });
		queueNextTurn(session, "later-prompt");

		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });
		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });

		expect(session.promptQueue.toArray().map((row: any) => row.id)).toEqual([
			"intent-proven-no-start", "later-prompt",
		]);
		expect(session.promptQueue.toArray()[0]).toMatchObject({
			kind: "steer",
			targetTurn: "next-turn",
			deliveryReason: "continuation-aborted",
		});
	});
});

function queueNextTurn(session: any, id: string): void {
	(session.promptQueue as any).enqueueExisting({
		id,
		text: id,
		isSteered: false,
		createdAt: 1_700_000_000_100,
		kind: "prompt",
		targetTurn: "next-turn",
		sequence: 99,
		deliveryState: "queued",
	});
}

describe("reliable intent attempt persistence", () => {
	it("restores complete attempt evidence and rejects a second active attempt for the same intent", () => {
		const restored = normalizePersistedInFlightSteers([{
			text: "persist me",
			promptId: "legacy-compatible-prompt-id",
			intentId: "intent-persisted",
			attemptId: "attempt:persisted",
			dispatchEpoch: 17,
			state: "uncertain",
			targetTurn: "continuation",
			sequence: 4,
			retryable: false,
		}, {
			text: "malformed duplicate active attempt",
			promptId: "duplicate-prompt-id",
			intentId: "intent-persisted",
			attemptId: "attempt:duplicate",
			dispatchEpoch: 18,
			state: "dispatching",
			targetTurn: "continuation",
			sequence: 4,
			retryable: false,
		}] as any);

		expect(restored).toEqual([expect.objectContaining({
			intentId: "intent-persisted",
			attemptId: "attempt:persisted",
			dispatchEpoch: 17,
			state: "uncertain",
			targetTurn: "continuation",
			sequence: 4,
			retryable: false,
		})]);
	});
});
