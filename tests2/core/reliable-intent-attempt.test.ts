import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePersistedInFlightSteers } from "../../src/server/agent/session-store.js";
import { PromptQueue } from "../../src/server/agent/prompt-queue.js";
import { reconcilePersistedIntentRestore } from "../../src/server/agent/session-manager.js";
import { foldAuthorSidecarRecords, initAuthorSidecarDir, readAuthorSidecar } from "../../src/server/agent/author-sidecar.js";
import { LOCAL_USER_AUTHOR } from "../../src/shared/message-author.js";
import {
	barrier,
	flushMicrotasks,
	makeReliableIntentHarness,
	type ReliableIntentHarness,
} from "./helpers/reliable-intent-fixture.js";

const TEST_MODEL_TEXT_DIGEST = "A".repeat(43);
const harnesses: ReliableIntentHarness[] = [];
const sidecarDirs: string[] = [];
const useHarness = (overrides: Record<string, any> = {}) => {
	const sidecarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reliable-intent-sidecar-"));
	sidecarDirs.push(sidecarRoot);
	initAuthorSidecarDir(sidecarRoot, {
		secretsDir: path.join(sidecarRoot, "secrets"),
		hmacKey: Buffer.alloc(32, 0x52),
	});
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

function userEnd(text: string, entryId: string) {
	return {
		type: "message_end",
		entryId,
		message: { id: entryId, role: "user", content: [{ type: "text", text }] },
	};
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	while (sidecarDirs.length > 0) fs.rmSync(sidecarDirs.pop()!, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("reliable intent dispatch attempt settlement", () => {
	it("keeps a steer reserved after RPC acknowledgement and settles only on correlated user end", async () => {
		const ack = barrier<any>();
		const steer = vi.fn(() => ack.hold());
		const { manager, session, storeUpdates } = useHarness({
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
		expect(ledgerFor(session, "intent-held")).toMatchObject({ state: "received", retryable: false });
		expect(manager.projectDeliveryOutbox(session.id)).toEqual([
			expect.objectContaining({ id: "intent-held", deliveryState: "received" }),
		]);
		const persistedReceived = [...storeUpdates].reverse().find((patch) =>
			Array.isArray(patch.inFlightSteerTexts)
			&& (patch.inFlightSteerTexts as any[]).some((row) => row.intentId === "intent-held" && row.state === "received"));
		const normalizedReceived = normalizePersistedInFlightSteers(persistedReceived?.inFlightSteerTexts as any[]);
		expect(normalizedReceived).toEqual([
			expect.objectContaining({ intentId: "intent-held", state: "received" }),
		]);
		const restartProjection = reconcilePersistedIntentRestore(undefined, normalizedReceived, []);
		expect(restartProjection.messageQueue).toBeUndefined();
		expect(restartProjection.inFlightSteerTexts).toEqual([
			expect.objectContaining({ intentId: "intent-held", state: "received" }),
		]);

		const replay = await manager.deliverLiveSteer(session.id, "held until echo", { intentId: "intent-held" });
		expect(replay).toMatchObject({ duplicate: true, settled: false });
		expect(steer).toHaveBeenCalledTimes(1);

		const terminal = manager.prepareVisibleAgentEvent(session, userEnd("held until echo", "pi-entry-held"));
		manager.handleAgentLifecycle(session, terminal);
		expect(terminal.deliveryIntentId ?? terminal.message?.deliveryIntentId).toBe("intent-held");
		expect(ledgerFor(session, "intent-held")).toBeUndefined();
	});

	it("assigns automatic system steers a stable reliable occurrence before dispatch", async () => {
		const ack = barrier<any>();
		const steer = vi.fn(() => ack.hold());
		const { manager, session } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});

		const dispatch = manager.deliverLiveSteer(session.id, "task T completed", { source: "system" });
		await ack.entered;

		const [pending] = session.inFlightSteerTexts;
		expect(pending, "automatic system steers must have a reliable occurrence identity").toMatchObject({
			intentId: expect.any(String),
			attemptId: expect.stringMatching(/^attempt:/),
			state: "dispatching",
			targetTurn: "continuation",
			source: "system",
		});
		expect(pending.promptId).toBe(pending.intentId);
		expect(manager.projectDeliveryOutbox(session.id)).toEqual([
			expect.objectContaining({ id: pending.intentId, deliveryState: "dispatching" }),
		]);

		ack.release({ success: true });
		await dispatch;
	});

	it("collapses a restored stale queue row and unresolved sidecar tuple into one uncertain owner", () => {
		const intentId = "automatic:restored-ambiguous";
		const attemptId = "attempt:restored-ambiguous";
		const dispatchEpoch = 42;
		const restored = reconcilePersistedIntentRestore([{
			id: intentId,
			text: "automatic work that may have landed",
			isSteered: false,
			createdAt: dispatchEpoch,
			kind: "prompt",
			targetTurn: "next-turn",
			deliveryState: "queued",
			source: "system",
		}], undefined, foldAuthorSidecarRecords([{
			schemaVersion: 2,
			type: "prompt-author",
			promptId: intentId,
			intentId,
			attemptId,
			dispatchEpoch,
			dispatchedAt: dispatchEpoch,
			modelTextDigest: TEST_MODEL_TEXT_DIGEST,
			source: "system",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		}]));

		expect(restored.messageQueue).toBeUndefined();
		expect(restored.inFlightSteerTexts).toEqual([expect.objectContaining({
			intentId,
			attemptId,
			state: "uncertain",
			retryable: false,
		})]);
		expect(new PromptQueue(restored.messageQueue).length).toBe(0);
		expect(restored.changed).toBe(true);
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
		expect(session.inFlightSteerTexts).toEqual([
			expect.objectContaining({ intentId: "intent-A", state: "received" }),
			expect.objectContaining({ intentId: "intent-B", state: "received" }),
		]);
		for (const [text, entryId] of [["same steer", "pi-same-A"], ["same steer", "pi-same-B"]]) {
			const terminal = manager.prepareVisibleAgentEvent(session, userEnd(text, entryId));
			manager.handleAgentLifecycle(session, terminal);
		}
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

	it("keeps a queued task notification uncertain after an ambiguous prompt transport failure", async () => {
		const prompt = vi.fn(async () => { throw new Error("socket closed after write"); });
		const { manager, session, clock, storeUpdates } = useHarness({
			rpcClient: {
				prompt,
				steer: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		const cancel = vi.spyOn(manager, "cancelPromptAuthorDispatch");
		vi.spyOn(console, "error").mockImplementation(() => {});
		const intentId = "task-complete:ambiguous";

		await manager.enqueuePrompt(session.id, "Task T completed.", { source: "system", intentId });
		expect(session.promptQueue.peek()).toMatchObject({ id: intentId, deliveryState: "queued" });
		session.status = "idle";
		manager.drainQueue(session);
		await flushMicrotasks();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(ledgerFor(session, intentId)).toMatchObject({ intentId, state: "uncertain", retryable: false });
		expect(manager.projectDeliveryOutbox(session.id)).toEqual([
			expect.objectContaining({ id: intentId, deliveryState: "uncertain", retryable: false }),
		]);
		expect(cancel).not.toHaveBeenCalled();
		expect(readAuthorSidecar(session.id).at(-1)?.settlement).toBeUndefined();
		expect(storeUpdates.at(-1)).toMatchObject({
			inFlightSteerTexts: [expect.objectContaining({ intentId, state: "uncertain", retryable: false })],
		});

		clock.advance(60_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("releases an ambiguous queued verifier receipt without retiring its prompt carrier", async () => {
		const prompt = vi.fn(async () => { throw new Error("transport lost after write"); });
		const { manager, session } = useHarness({
			status: "idle",
			rpcClient: {
				prompt,
				steer: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		const cancel = vi.spyOn(manager, "cancelPromptAuthorDispatch");
		vi.spyOn(console, "error").mockImplementation(() => {});

		const first = manager.enqueueVerifierPrompt(session.id, "Run verification.");
		await expect(first.dispatched).rejects.toThrow(/transport outcome is uncertain/);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(ledgerFor(session, first.rowId)).toMatchObject({
			intentId: first.rowId,
			state: "uncertain",
			retryable: false,
		});
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(cancel).not.toHaveBeenCalled();
		expect(readAuthorSidecar(session.id).at(-1)?.settlement).toBeUndefined();

		// The receipt is independent from the uncertain carrier: the verifier can
		// start a new lifecycle occurrence while the original remains outbox-owned.
		prompt.mockResolvedValueOnce({ success: true });
		session.status = "idle";
		const second = manager.enqueueVerifierPrompt(session.id, "Run verification again.");
		await expect(second.dispatched).resolves.toBeUndefined();
		expect(second.rowId).not.toBe(first.rowId);
		expect(ledgerFor(session, first.rowId)).toMatchObject({ state: "uncertain", retryable: false });
		expect(prompt).toHaveBeenCalledTimes(2);
	});

	it("cancels and marks a queued task notification failed only on success false", async () => {
		const prompt = vi.fn(async () => ({ success: false, error: "preflight rejected" }));
		const { manager, session } = useHarness({
			rpcClient: {
				prompt,
				steer: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		const intentId = "task-complete:no-start";

		await manager.enqueuePrompt(session.id, "Task T could not start.", { source: "system", intentId });
		session.status = "idle";
		manager.drainQueue(session);
		await flushMicrotasks();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(ledgerFor(session, intentId)).toBeUndefined();
		expect(session.promptQueue.toArray()).toEqual([
			expect.objectContaining({ id: intentId, deliveryState: "failed", retryable: true }),
		]);
		expect(readAuthorSidecar(session.id).at(-1)?.settlement?.outcome).toBe("cancelled");
	});

	it("hard-stops a queued success false response when its author binding is already consumed", async () => {
		const prompt = vi.fn(async () => ({ success: false, error: "preflight rejected" }));
		const { manager, session, clock } = useHarness({
			rpcClient: {
				prompt,
				steer: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		const intentId = "task-complete:consumed";
		vi.spyOn(manager, "cancelPromptAuthorDispatch").mockReturnValue(false);

		await manager.enqueuePrompt(session.id, "Task T may already have started.", { source: "system", intentId });
		session.status = "idle";
		manager.drainQueue(session);
		await flushMicrotasks();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(ledgerFor(session, intentId)).toMatchObject({ state: "dispatching" });
		expect(readAuthorSidecar(session.id).at(-1)?.settlement).toBeUndefined();
		clock.advance(60_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
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
		expect(ledgerFor(session, "intent-stop-admission")?.state).toBe("received");
		const lateEnd = manager.prepareVisibleAgentEvent(session, userEnd("uncertain before abort", "pi-stop-late"));
		manager.handleAgentLifecycle(session, lateEnd);
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
		expect(ledgerFor(session, "intent-late")?.state).toBe("received");
		const lateEnd = manager.prepareVisibleAgentEvent(session, userEnd("late after stop", "pi-late"));
		manager.handleAgentLifecycle(session, lateEnd);
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
		expect(ledgerFor(session, "intent-graceful-late")?.state).toBe("received");
		const lateEnd = manager.prepareVisibleAgentEvent(session, userEnd("late graceful echo", "pi-graceful-late"));
		manager.handleAgentLifecycle(session, lateEnd);
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

	it("restores a proven-no-start attempt after an earlier next-turn prompt across persistence", async () => {
		const steer = vi.fn(async () => ({ success: true }));
		const { manager, session, storeUpdates } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		queueNextTurn(session, "earlier-prompt");
		await manager.deliverLiveSteer(session.id, "same text", {
			intentId: "later-steer",
			source: "agent",
			author: { kind: "agent", id: "session:later", label: "Later" },
		});

		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });
		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });

		const rows = session.promptQueue.toArray() as any[];
		expect(rows.map((row) => row.id)).toEqual(["earlier-prompt", "later-steer"]);
		expect(rows.map((row) => row.sequence)).toEqual([expect.any(Number), expect.any(Number)]);
		expect(new Set(rows.map((row) => row.sequence)).size).toBe(2);
		expect(rows[1]).toMatchObject({
			text: "same text",
			kind: "steer",
			targetTurn: "next-turn",
			deliveryReason: "continuation-aborted",
			author: { kind: "agent", id: "session:later", label: "Later" },
		});
		const persisted = latestPersistedQueue(storeUpdates);
		expect(persisted.inFlightSteerTexts).toBeUndefined();
		expect(nextTurnDrainOrder(persisted.messageQueue)).toEqual(["earlier-prompt", "later-steer"]);
	});

	it("restores an earlier proven-no-start steer before a later prompt across persistence", async () => {
		const steer = vi.fn(async () => ({ success: true }));
		const { manager, session, storeUpdates } = useHarness({
			rpcClient: {
				steer,
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		await manager.deliverLiveSteer(session.id, "same text", {
			intentId: "earlier-steer",
			source: "agent",
			author: { kind: "agent", id: "session:earlier", label: "Earlier" },
		});
		queueNextTurn(session, "later-prompt");

		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });
		manager._reconcileAfterAbort(session, { outcome: "proven-no-start" });

		const rows = session.promptQueue.toArray() as any[];
		expect(rows.map((row) => row.id)).toEqual(["earlier-steer", "later-prompt"]);
		expect(new Set(rows.map((row) => row.sequence)).size).toBe(2);
		expect(rows[0]).toMatchObject({
			text: "same text",
			deliveryReason: "continuation-aborted",
			author: { kind: "agent", id: "session:earlier", label: "Earlier" },
		});
		const persisted = latestPersistedQueue(storeUpdates);
		expect(nextTurnDrainOrder(persisted.messageQueue)).toEqual(["earlier-steer", "later-prompt"]);
	});

	it("retargets queue-only continuations with unique persisted next-turn sequences", () => {
		const { manager, session, storeUpdates } = useHarness();
		(session.promptQueue as any).enqueueExisting({
			id: "prompt-first",
			text: "same text",
			isSteered: false,
			createdAt: 100,
			kind: "prompt",
			targetTurn: "next-turn",
			sequence: 1,
			deliveryState: "queued",
			author: { kind: "user", id: "user:first", label: "First" },
		});
		(session.promptQueue as any).enqueueExisting({
			id: "steer-second",
			text: "same text",
			isSteered: true,
			createdAt: 101,
			kind: "steer",
			targetTurn: "continuation",
			sequence: 1,
			deliveryState: "queued",
			author: { kind: "agent", id: "session:second", label: "Second" },
		});

		manager._reconcileAfterAbort(session, { retargetQueuedContinuation: true });
		manager._reconcileAfterAbort(session, { retargetQueuedContinuation: true });
		manager.broadcastQueueUpdate(session.id);

		const rows = session.promptQueue.toArray() as any[];
		expect(rows.map((row) => row.id)).toEqual(["prompt-first", "steer-second"]);
		expect(new Set(rows.map((row) => row.sequence)).size).toBe(2);
		expect(rows[1]).toMatchObject({
			text: "same text",
			targetTurn: "next-turn",
			deliveryReason: "continuation-aborted",
			author: { kind: "agent", id: "session:second", label: "Second" },
		});
		const persisted = latestPersistedQueue(storeUpdates);
		expect(nextTurnDrainOrder(persisted.messageQueue)).toEqual(["prompt-first", "steer-second"]);
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

function latestPersistedQueue(storeUpdates: Array<Record<string, unknown>>): {
	messageQueue: any[];
	inFlightSteerTexts?: any[];
} {
	const persisted = [...storeUpdates].reverse().find((patch) => Array.isArray(patch.messageQueue));
	expect(persisted).toBeDefined();
	return persisted as { messageQueue: any[]; inFlightSteerTexts?: any[] };
}

function nextTurnDrainOrder(persistedRows: any[]): string[] {
	const restored = new PromptQueue(persistedRows);
	const ids: string[] = [];
	let row;
	while ((row = restored.dequeueForTarget("next-turn"))) ids.push(row.id);
	return ids;
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
