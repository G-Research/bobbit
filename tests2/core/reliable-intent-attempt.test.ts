import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePersistedInFlightSteers } from "../../src/server/agent/session-store.js";
import { reconcilePersistedIntentRestore } from "../../src/server/agent/session-manager.js";
import { foldAuthorSidecarRecords } from "../../src/server/agent/author-sidecar.js";
import { LOCAL_USER_AUTHOR } from "../../src/shared/message-author.js";
import {
	barrier,
	flushMicrotasks,
	makeReliableIntentHarness,
	type ReliableIntentHarness,
} from "./helpers/reliable-intent-fixture.js";

const TEST_MODEL_TEXT_DIGEST = "A".repeat(43);
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

	it("retains the retired tuple when Retry is held by compaction and survives restart once", async () => {
		const steer = vi.fn(async () => ({ success: false, error: "definite rejection" }));
		const { manager, session, storeUpdates } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(manager.deliverLiveSteer(session.id, "identical retry", { intentId: "intent-retry-held" }))
			.rejects.toThrow(/definite rejection/i);
		const failed = session.promptQueue.peek();
		expect(failed).toMatchObject({
			id: "intent-retry-held",
			deliveryState: "failed",
			attemptId: expect.stringMatching(/^attempt:/),
			dispatchEpoch: expect.any(Number),
		});

		session.isCompacting = true;
		expect(manager.retryIntent(session.id, failed.id)).toBe(true);
		const retried = session.promptQueue.peek();
		expect(retried).toMatchObject({
			id: failed.id,
			deliveryState: "queued",
			attemptId: failed.attemptId,
			dispatchEpoch: failed.dispatchEpoch,
		});
		const persisted = [...storeUpdates].reverse().find((patch) => Array.isArray(patch.messageQueue));
		expect((persisted?.messageQueue as any[])[0]).toMatchObject({
			id: failed.id,
			attemptId: failed.attemptId,
			dispatchEpoch: failed.dispatchEpoch,
		});

		const restored = reconcilePersistedIntentRestore(
			persisted?.messageQueue as any[],
			undefined,
			foldAuthorSidecarRecords([{
				schemaVersion: 2,
				type: "prompt-author",
				promptId: failed.id,
				intentId: failed.id,
				attemptId: failed.attemptId,
				dispatchEpoch: failed.dispatchEpoch,
				dispatchedAt: failed.dispatchEpoch,
				modelTextDigest: TEST_MODEL_TEXT_DIGEST,
				source: "user",
				author: LOCAL_USER_AUTHOR,
			}, {
				schemaVersion: 2,
				type: "prompt-author-settlement",
				promptId: failed.id,
				intentId: failed.id,
				attemptId: failed.attemptId,
				settledAt: failed.dispatchEpoch,
				outcome: "cancelled",
			}]),
		);
		expect(restored.messageQueue).toHaveLength(1);
		expect(restored.messageQueue?.[0]).toMatchObject({ id: failed.id, deliveryState: "queued" });
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
	it("persists and projects uncertainty synchronously at eligible Stop admission", async () => {
		const replacement = barrier<void>();
		const { manager, session, storeUpdates } = useHarness({
			rpcClient: {
				steer: vi.fn(async () => ({ success: true })),
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		await manager.deliverLiveSteer(session.id, "uncertain before abort", { intentId: "intent-stop-admission" });
		session.inFlightSteerTexts.push({ text: "legacy pending", promptId: "legacy-prompt" });
		manager._coordinateSessionReplacement = vi.fn(() => replacement.hold());

		const stopping = manager.forceAbort(session.id);

		expect(ledgerFor(session, "intent-stop-admission")).toMatchObject({
			state: "uncertain",
			retryable: false,
		});
		expect(manager.projectDeliveryOutbox(session.id)).toEqual([
			expect.objectContaining({ id: "intent-stop-admission", deliveryState: "uncertain", retryable: false }),
		]);
		expect(storeUpdates.at(-1)).toMatchObject({
			inFlightSteerTexts: [expect.objectContaining({
				intentId: "intent-stop-admission",
				state: "uncertain",
				retryable: false,
			}), expect.objectContaining({ promptId: "legacy-prompt" })],
		});
		expect(manager.retryIntent(session.id, "intent-stop-admission")).toBe(false);
		expect(session.promptQueue.toArray().some((row: any) => row.text === "legacy pending")).toBe(false);
		expect(session.inFlightSteerTexts).toContainEqual({ text: "legacy pending", promptId: "legacy-prompt" });
		expect(manager._coordinateSessionReplacement).toHaveBeenCalledTimes(1);

		// A repeated Stop joins the same owner without another persistence/broadcast transition.
		const updateCount = storeUpdates.length;
		const repeated = manager.forceAbort(session.id);
		expect(storeUpdates).toHaveLength(updateCount);

		const lateStart = manager.prepareVisibleAgentEvent(session, userStart("uncertain before abort", "pi-stop-late"));
		manager.handleAgentLifecycle(session, lateStart);
		expect(lateStart.deliveryIntentId).toBe("intent-stop-admission");
		expect(ledgerFor(session, "intent-stop-admission")).toBeUndefined();

		replacement.release(undefined);
		await Promise.all([stopping, repeated]);
	});

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

	it("keeps acknowledged no-echo attempts uncertain at a graceful Stop terminal while retargeting only queued work", async () => {
		const steer = vi.fn(async () => ({ success: true }));
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		await manager.deliverLiveSteer(session.id, "late graceful echo", { intentId: "intent-graceful-late" });
		(session.promptQueue as any).enqueueExisting({
			id: "intent-queued-after-stop",
			text: "queued after stop",
			isSteered: true,
			createdAt: 1_700_000_000_050,
			kind: "steer",
			targetTurn: "continuation",
			sequence: 2,
			deliveryState: "queued",
		});
		session.status = "aborting";

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false }, {
			replacementOwnedTerminal: true,
			deferQueueDrain: true,
		});

		expect(steer).toHaveBeenCalledTimes(1);
		expect(ledgerFor(session, "intent-graceful-late")).toMatchObject({
			state: "uncertain",
			retryable: false,
		});
		expect(manager.projectDeliveryOutbox(session.id).filter((row: any) => row.id === "intent-graceful-late"))
			.toEqual([expect.objectContaining({ deliveryState: "uncertain", retryable: false })]);
		expect(session.promptQueue.toArray()).toEqual([
			expect.objectContaining({
				id: "intent-queued-after-stop",
				targetTurn: "next-turn",
				deliveryReason: "continuation-aborted",
			}),
		]);

		const lateStart = manager.prepareVisibleAgentEvent(session, userStart("late graceful echo", "pi-graceful-late"));
		manager.handleAgentLifecycle(session, lateStart);
		expect(lateStart.deliveryIntentId).toBe("intent-graceful-late");
		expect(ledgerFor(session, "intent-graceful-late")).toBeUndefined();
		expect(manager.projectDeliveryOutbox(session.id).some((row: any) => row.id === "intent-graceful-late")).toBe(false);
		expect(steer).toHaveBeenCalledTimes(1);
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

	it("parks hard-abort replacement failure as one durable nonretryable carrier", async () => {
		const { manager, session, storeUpdates } = useHarness({
			rpcClient: {
				steer: vi.fn(async () => ({ success: true })),
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		await manager.deliverLiveSteer(session.id, "same hard abort", { intentId: "intent-hard-abort" });
		const attempt = { ...ledgerFor(session, "intent-hard-abort") };

		manager._cancelAmbiguousInFlightAfterAbort(session);

		expect(ledgerFor(session, attempt.intentId)).toBeUndefined();
		expect(session.promptQueue.toArray()).toEqual([expect.objectContaining({
			id: attempt.intentId,
			text: "same hard abort",
			deliveryState: "cancelled",
			deliveryReason: "abort-recovery-failed",
			retryable: false,
			attemptId: attempt.attemptId,
			dispatchEpoch: attempt.dispatchEpoch,
		})]);
		expect(manager.retryIntent(session.id, attempt.intentId)).toBe(false);
		expect(manager.projectDeliveryOutbox(session.id)).toEqual([
			expect.objectContaining({ id: attempt.intentId, deliveryState: "cancelled" }),
		]);
		const persisted = [...storeUpdates].reverse().find((patch) => Array.isArray(patch.messageQueue));
		expect(persisted).toMatchObject({
			messageQueue: [expect.objectContaining({ id: attempt.intentId, deliveryState: "cancelled" })],
			inFlightSteerTexts: undefined,
		});
		const restarted = reconcilePersistedIntentRestore(
			persisted?.messageQueue as any[],
			persisted?.inFlightSteerTexts as any[] | undefined,
			foldAuthorSidecarRecords([{
				schemaVersion: 2,
				type: "prompt-author",
				promptId: attempt.promptId,
				intentId: attempt.intentId,
				attemptId: attempt.attemptId,
				dispatchEpoch: attempt.dispatchEpoch,
				dispatchedAt: attempt.dispatchEpoch,
				modelTextDigest: TEST_MODEL_TEXT_DIGEST,
				source: "user",
				author: LOCAL_USER_AUTHOR,
			}, {
				schemaVersion: 2,
				type: "prompt-author-settlement",
				promptId: attempt.promptId,
				intentId: attempt.intentId,
				attemptId: attempt.attemptId,
				settledAt: attempt.dispatchEpoch,
				outcome: "cancelled",
			}]),
		);
		expect(restarted.messageQueue).toEqual([
			expect.objectContaining({ id: attempt.intentId, deliveryState: "cancelled", retryable: false }),
		]);

		const late = manager.prepareVisibleAgentEvent(session, userStart("same hard abort", "pi-late-hard-abort"));
		manager.handleAgentLifecycle(session, late);
		expect(late.deliveryIntentId).toBeUndefined();
		expect(session.promptQueue.toArray()).toHaveLength(1);
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

describe("reliable intent restore settlement ordering", () => {
	it("does not resurrect a dismissed recovered row from a stale crash queue, including identical text", () => {
		const digest = TEST_MODEL_TEXT_DIGEST;
		const bindings = foldAuthorSidecarRecords([{
			schemaVersion: 2,
			type: "prompt-author",
			promptId: "intent-dismissed",
			intentId: "intent-dismissed",
			attemptId: "attempt:retired",
			dispatchEpoch: 10,
			dispatchedAt: 9_000,
			modelTextDigest: digest,
			source: "user",
			author: LOCAL_USER_AUTHOR,
		}, {
			schemaVersion: 2,
			type: "prompt-author-settlement",
			promptId: "intent-dismissed",
			intentId: "intent-dismissed",
			attemptId: "attempt:retired",
			settledAt: 11,
			outcome: "cancelled",
		}, {
			schemaVersion: 2,
			type: "prompt-author",
			promptId: "intent-dismissed",
			intentId: "intent-dismissed",
			attemptId: "dismiss:terminal",
			dispatchEpoch: 20,
			dispatchedAt: 20,
			modelTextDigest: digest,
			source: "user",
			author: LOCAL_USER_AUTHOR,
		}, {
			schemaVersion: 2,
			type: "prompt-author-settlement",
			promptId: "intent-dismissed",
			intentId: "intent-dismissed",
			attemptId: "dismiss:terminal",
			settledAt: 20,
			outcome: "cancelled",
		}]);
		const restored = reconcilePersistedIntentRestore([{
			id: "intent-dismissed",
			text: "identical stale text",
			isSteered: true,
			createdAt: 9_000,
			deliveryState: "failed",
			attemptId: "attempt:retired",
			dispatchEpoch: 10,
		}, {
			id: "intent-other",
			text: "identical stale text",
			isSteered: true,
			createdAt: 9_001,
			deliveryState: "queued",
		}] as any, undefined, bindings);

		expect(restored.messageQueue?.map((row) => row.id)).toEqual(["intent-other"]);
	});
});

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
