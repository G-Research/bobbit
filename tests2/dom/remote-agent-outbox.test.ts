import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-outbox.spec.ts (v2-dom tier).
// Drives the REAL RemoteAgent.send()/getQueue()/_flushOutbox() (was an esbuild
// file:// bundle) with a fake WebSocket whose readyState the test controls.
// session-manager is imported FIRST so it owns the session-manager⇄pack-panels
// import cycle before remote-agent pulls it in (TDZ guard); safe-markdown-block
// is pre-imported so any fire-and-forget lazy define resolves during the test
// rather than racing env teardown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConfirmedSessionModelPersistence } from "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { storage } from "../../src/app/storage.js";
import { DeliveryIntentStore, type PersistedDeliveryIntent } from "../../src/ui/storage/app-storage.js";
import type { StorageBackend } from "../../src/ui/storage/types.js";
import "../../src/ui/components/MessageEditor.js";
import "../../src/ui/lazy/safe-markdown-block.js";
import { setRenderApp, state } from "../../src/app/state.js";

const OPEN = 1;
const CLOSED = 3;

let renderCount = 0;
setRenderApp(() => { renderCount++; });

function makeAgent(readyState: number) {
	const ra: any = new RemoteAgent();
	const sentFrames: string[] = [];
	ra.ws = { readyState, send: (s: string) => sentFrames.push(s) };
	ra.__sentFrames = sentFrames;
	ra.__queueUpdates = [];
	ra.onQueueUpdate = (q: any) => ra.__queueUpdates.push(q);
	return ra;
}

const snapshot = (ra: any) => ({
	outboxLen: ra._pendingOutbox.length,
	sent: ra.__sentFrames.map((s: string) => JSON.parse(s)),
	queue: ra.getQueue().map((row: any) => ({ ...row })),
	messages: ra._state.messages.length,
	providerAuthRequired: ra._state.providerAuthRequired,
	autoRetryPending: ra._state.autoRetryPending,
	queueUpdateCount: ra.__queueUpdates.length,
});

const nextRenderFrame = () => new Promise<void>((resolve) => {
	requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

afterEach(() => {
	vi.restoreAllMocks();
	state.showHeadquartersInProjectLists = false;
	localStorage.clear();
});

describe("RemoteAgent live preference sync", () => {
	it("preferences_changed keeps Headquarters visibility state in sync", async () => {
		const ra = makeAgent(OPEN);

		state.showHeadquartersInProjectLists = true;
		renderCount = 0;
		await ra.handleServerMessage({
			type: "preferences_changed",
			preferences: { showHeadquartersInProjectLists: false },
		});
		await nextRenderFrame();
		const hidden = {
			visible: state.showHeadquartersInProjectLists,
			renders: renderCount,
		};

		renderCount = 0;
		await ra.handleServerMessage({
			type: "preferences_changed",
			preferences: {},
		});
		await nextRenderFrame();
		const defaultVisible = {
			visible: state.showHeadquartersInProjectLists,
			renders: renderCount,
		};

		expect(hidden.visible).toBe(false);
		expect(hidden.renders).toBeGreaterThan(0);
		expect(defaultVisible.visible).toBe(true);
		expect(defaultVisible.renders).toBeGreaterThan(0);
	});
});

describe("RemoteAgent model switch reconciliation", () => {
	const modelA = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 128000 };
	const modelB = { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200000 };

	it("reconciles optimistic display from authoritative state and refreshes after SET_MODEL_FAILED", async () => {
		const ra = makeAgent(OPEN);
		const events: any[] = [];
		ra.subscribe((event: any) => events.push(event));

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		ra.setModel(modelB);
		expect(ra.state.model).toMatchObject(modelB);

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		await ra.handleServerMessage({ type: "error", code: "SET_MODEL_FAILED", message: "read-back mismatch" });

		expect(ra.state.model).toMatchObject(modelA);
		expect(snapshot(ra).sent).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "set_model", provider: modelB.provider, modelId: modelB.id }),
			expect.objectContaining({ type: "get_state" }),
		]));
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "state_update", data: expect.objectContaining({ model: modelA }) }),
		]));
	});

	it("persists only server-confirmed model states, not optimistic selections", async () => {
		const ra = makeAgent(OPEN);
		installConfirmedSessionModelPersistence(ra, "session-model-test");
		const saved = () => JSON.parse(localStorage.getItem("session.session-model-test.model") || "null");

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		ra.setModel(modelB);
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		await ra.handleServerMessage({ type: "error", code: "SET_MODEL_FAILED", message: "rejected" });
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		await ra.handleServerMessage({ type: "state", data: { model: modelB } });
		expect(saved()).toMatchObject({ provider: modelB.provider, modelId: modelB.id });
	});
});

describe("RemoteAgent provider auth recovery", () => {
	it("stores a redacted provider_auth_required event and clears it on retry, new prompt, model switch, and agent_start", async () => {
		const makeEvent = () => ({
			type: "provider_auth_required",
			provider: "openrouter",
			source: "direct prompt",
			reason: "missing-api-key",
			message: "OpenRouter API key is missing. Add or fix the API key in Settings, switch provider, then retry.",
			error: "No API key found for openrouter: sk-or-secret-never-render",
			actions: [
				{ type: "open_settings", label: "Fix API key in Settings" },
				{ type: "retry", label: "Retry after fixing credentials" },
				{ type: "switch_provider", label: "Switch provider" },
				{ type: "abort_respawn", label: "Abort/respawn agent" },
			],
		});

		const retryAgent = makeAgent(OPEN);
		retryAgent.handleAgentEvent(makeEvent());
		const stored = snapshot(retryAgent).providerAuthRequired;
		retryAgent.retry();
		const afterRetry = snapshot(retryAgent);

		const promptAgent = makeAgent(OPEN);
		promptAgent.handleAgentEvent(makeEvent());
		await promptAgent.prompt("after key fix");
		const afterPrompt = snapshot(promptAgent);

		const modelAgent = makeAgent(OPEN);
		modelAgent.handleAgentEvent(makeEvent());
		modelAgent.setModel({ provider: "anthropic", id: "claude-test", contextWindow: 1 });
		const afterModel = snapshot(modelAgent);

		const startAgent = makeAgent(OPEN);
		startAgent.handleAgentEvent(makeEvent());
		startAgent.handleAgentEvent({ type: "agent_start" });
		const afterStart = snapshot(startAgent);

		expect(stored).toMatchObject({
			provider: "openrouter",
			source: "direct prompt",
			reason: "missing-api-key",
		});
		expect(JSON.stringify(stored)).not.toContain("sk-or-secret-never-render");
		expect(afterRetry.providerAuthRequired).toBeNull();
		expect(afterRetry.sent.at(-1)).toMatchObject({ type: "retry" });
		expect(afterPrompt.providerAuthRequired).toBeNull();
		expect(afterPrompt.sent.at(-1)).toMatchObject({ type: "prompt", text: "after key fix" });
		expect(afterModel.providerAuthRequired).toBeNull();
		expect(afterModel.sent.at(-1)).toMatchObject({ type: "set_model", provider: "anthropic", modelId: "claude-test" });
		expect(afterStart.providerAuthRequired).toBeNull();
	});
});

describe("RemoteAgent recovery snapshot delivery", () => {
	const acceptedSteer = (id: string, sequence: number) => ({
		id,
		text: "same steer",
		isSteered: true,
		createdAt: sequence,
		kind: "steer",
		targetTurn: "continuation",
		sequence,
		deliveryState: "dispatching",
	});
	const recoveryRow = (id: string, attemptId: string, sequence: number) => ({
		id: `inflight-steer:${id}`,
		role: "user",
		content: [{ type: "text", text: "same steer" }],
		deliveryIntentId: id,
		deliveryAttemptId: attemptId,
		deliveryState: "dispatching",
		targetTurn: "continuation",
		sequence,
		kind: "steer",
		isSteered: true,
		_inFlightSteer: true,
		_deliveryRecoveryProjection: true,
	});

	it("keeps identical structured recovery rows in the outbox until each real correlated Pi start", async () => {
		const ra = makeAgent(OPEN);
		await ra.handleServerMessage({
			type: "delivery_outbox",
			outbox: [acceptedSteer("intent-a", 1), acceptedSteer("intent-b", 2)],
		});

		await ra.handleServerMessage({
			type: "messages",
			data: [
				recoveryRow("intent-a", "attempt-a", 1),
				recoveryRow("intent-b", "attempt-b", 2),
			],
		});

		expect(ra.getQueue().map((row: any) => row.id)).toEqual(["intent-a", "intent-b"]);
		expect(ra.getQueue().map((row: any) => row.text)).toEqual(["same steer", "same steer"]);
		expect(ra._state.messages).toHaveLength(0);

		ra.handleAgentEvent({
			type: "message_start",
			message: {
				id: "pi-user-a",
				role: "user",
				content: [{ type: "text", text: "same steer" }],
				deliveryIntentId: "intent-a",
				deliveryAttemptId: "attempt-a",
			},
		});

		expect(ra.getQueue().map((row: any) => row.id)).toEqual(["intent-b"]);
		expect(ra._state.messages).toHaveLength(1);
		expect(ra._state.messages[0]).toMatchObject({ id: "pi-user-a", deliveryIntentId: "intent-a" });

		ra.handleAgentEvent({
			type: "message_start",
			message: {
				id: "pi-user-b",
				role: "user",
				content: [{ type: "text", text: "same steer" }],
				deliveryIntentId: "intent-b",
				deliveryAttemptId: "attempt-b",
			},
		});

		expect(ra.getQueue()).toHaveLength(0);
		expect(ra._state.messages.map((message: any) => message.deliveryIntentId)).toEqual(["intent-a", "intent-b"]);
	});

	it("keeps hard-abort cancellation visible in both tabs and refuses stale-tab Retry", async () => {
		const tabs = [makeAgent(OPEN), makeAgent(OPEN)];
		for (const ra of tabs) {
			await ra.handleServerMessage({
				type: "delivery_outbox",
				outbox: [{
					...acceptedSteer("intent-cancelled", 1),
					deliveryState: "cancelled",
					deliveryReason: "abort-recovery-failed",
					retryable: false,
				}],
			});
			await ra.handleServerMessage({
				type: "intent_update",
				intent: {
					id: "intent-cancelled",
					deliveryState: "cancelled",
					deliveryReason: "abort-recovery-failed",
					retryable: false,
				},
			});
		}

		for (const ra of tabs) {
			expect(ra.getQueue()).toEqual([
				expect.objectContaining({ id: "intent-cancelled", deliveryState: "cancelled", retryable: false }),
			]);
			ra.retryIntent("intent-cancelled");
			expect(snapshot(ra).sent).not.toContainEqual(expect.objectContaining({ type: "retry_intent" }));
			expect(ra.getQueue()).toHaveLength(1);
		}
	});

	it("settles on a real correlated transcript snapshot row without a duplicate carrier", async () => {
		const ra = makeAgent(OPEN);
		await ra.handleServerMessage({
			type: "delivery_outbox",
			outbox: [acceptedSteer("intent-real-snapshot", 1)],
		});
		await ra.handleServerMessage({
			type: "messages",
			data: [{
				id: "pi-real-snapshot",
				role: "user",
				content: [{ type: "text", text: "same steer" }],
				deliveryIntentId: "intent-real-snapshot",
				deliveryAttemptId: "attempt-real-snapshot",
			}],
		});

		expect(ra.getQueue()).toHaveLength(0);
		expect(ra._state.messages).toHaveLength(1);
		expect(ra._state.messages[0]).toMatchObject({
			id: "pi-real-snapshot",
			deliveryIntentId: "intent-real-snapshot",
		});
	});

	it("keeps no-intent recovery projections out of the transcript while retaining outbox carriers", async () => {
		const ra = makeAgent(OPEN);
		await ra.handleServerMessage({
			type: "messages",
			data: [
				{
					id: "inflight-steer:pre-intent-prompt",
					role: "user",
					content: [{ type: "text", text: "pre-intent structured recovery" }],
					promptId: "pre-intent-prompt",
					_deliveryRecoveryProjection: true,
					_inFlightSteer: true,
				},
				{
					id: "inflight-steer:0:bare-legacy",
					role: "user",
					content: [{ type: "text", text: "bare legacy recovery" }],
					_inFlightSteer: true,
				},
			],
		});

		expect(
			ra._state.messages.filter((message: any) => message._inFlightSteer),
			"RECOVERY_PROJECTIONS_MUST_NEVER_ENTER_TRANSCRIPT",
		).toEqual([]);
		expect(
			ra.getQueue().map((row: any) => row.text).sort(),
			"RECOVERY_PROJECTIONS_MUST_RETAIN_OUTBOX_CARRIERS",
		).toEqual(["bare legacy recovery", "pre-intent structured recovery"]);
	});
});

describe("RemoteAgent send outbox (S2)", () => {
	it("offline prompt stays visible through reconnect send until server acceptance", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("lost-xyz");
		const offline = snapshot(ra);
		// Reconnect: socket opens, auth_ok would call _flushOutbox.
		ra.ws.readyState = OPEN;
		ra._flushOutbox();
		const afterFlush = snapshot(ra);

		// While offline: queued, not sent; surfaced as an unsent pill; no transcript bubble.
		expect(offline.sent).toHaveLength(0);
		expect(offline.outboxLen).toBe(1);
		expect(offline.messages).toBe(0);
		expect(offline.queue).toHaveLength(1);
		expect(offline.queue[0].text).toBe("lost-xyz");
		expect(offline.queue[0].unsent).toBe(true);
		expect(offline.queueUpdateCount).toBeGreaterThan(0);
		// A socket write is not delivery or server acceptance. The same occurrence
		// remains visible and durable until a matching server projection arrives.
		expect(afterFlush.outboxLen).toBe(1);
		expect(afterFlush.queue).toHaveLength(1);
		expect(afterFlush.queue[0].unsent).toBe(false);
		expect(afterFlush.sent).toHaveLength(1);
		expect(afterFlush.sent[0]).toMatchObject({ type: "prompt", text: "lost-xyz" });
	});

	it("keeps the unsent suffix queued when the socket closes during a reconnect flush", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("first");
		await ra.prompt("second");
		await ra.prompt("third");

		ra.ws.readyState = OPEN;
		let attempts = 0;
		ra.ws.send = (data: string) => {
			attempts++;
			if (attempts === 2) {
				ra.ws.readyState = CLOSED;
				throw new Error("racing close");
			}
			ra.__sentFrames.push(data);
		};
		ra._flushOutbox();

		let afterFailure = snapshot(ra);
		expect(afterFailure.sent.map((frame: any) => frame.text)).toEqual(["first"]);
		expect(afterFailure.outboxLen).toBe(3);
		expect(afterFailure.queue.map((row: any) => row.text)).toEqual(["first", "second", "third"]);
		expect(afterFailure.queue.map((row: any) => row.unsent)).toEqual([false, true, true]);

		ra.ws.readyState = OPEN;
		ra.ws.send = (data: string) => ra.__sentFrames.push(data);
		ra._flushOutbox();
		afterFailure = snapshot(ra);
		expect(afterFailure.outboxLen).toBe(3);
		expect(afterFailure.sent.map((frame: any) => frame.text)).toEqual(["first", "second", "third"]);
		expect(afterFailure.queue.map((row: any) => row.unsent)).toEqual([false, false, false]);
	});

	it("only prompt/steer/retry are buffered; control frames are dropped", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("p1");
		ra.steer("s1");
		ra.retry();
		(ra as any).send({ type: "get_state" }); // control frame — must NOT queue
		(ra as any).send({ type: "ping" });
		const r = snapshot(ra);

		// prompt + steer + retry queued (3); get_state/ping dropped.
		expect(r.outboxLen).toBe(3);
		// Only prompt + steer have pill rows (retry has no text).
		expect(r.queue).toHaveLength(2);
		expect(r.queue.map((q: any) => q.text).sort()).toEqual(["p1", "s1"]);
		expect(r.queue.find((q: any) => q.text === "s1").isSteered).toBe(true);
	});

	it("rejects rows beyond durable OUTBOX_MAX visibly instead of dropping older intent", async () => {
		const ra = makeAgent(CLOSED);
		for (let i = 0; i < 60; i++) await ra.prompt(`m${i}`);
		const snap = snapshot(ra);
		expect(snap.outboxLen).toBe(60);
		expect(snap.queue).toHaveLength(60);
		expect(snap.queue[0]).toMatchObject({ text: "m0", deliveryState: "local" });
		expect(snap.queue[49]).toMatchObject({ text: "m49", deliveryState: "local" });
		expect(snap.queue[50]).toMatchObject({
			text: "m50",
			deliveryState: "failed",
			retryable: false,
		});
		expect(snap.queue[50].deliveryError).toMatch(/storage is full/i);
		expect(snap.queue.at(-1)?.text).toBe("m59");
	});

	it("removeQueued drops a pending-unsent row locally", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("droppable");
		const id = snapshot(ra).queue[0].id;
		ra.removeQueued(id);
		const r = snapshot(ra);
		expect(r.outboxLen).toBe(0);
		expect(r.queue).toHaveLength(0);
		expect(r.sent).toHaveLength(0); // no remove_queued sent to server for a never-sent row
	});

	it("has a connected stale tab take over a newer retry when its writer closes before send", async () => {
		const sessionId = `pre-admission-${Date.now()}-${Math.random()}`;
		const records = new Map<string, PersistedDeliveryIntent>();
		let releaseRetry!: () => void;
		let signalRetryPersisted!: () => void;
		const retryPersisted = new Promise<void>((resolve) => { signalRetryPersisted = resolve; });
		const retryRelease = new Promise<void>((resolve) => { releaseRetry = resolve; });
		vi.spyOn(storage.deliveryIntents, "put").mockImplementation(async (sid, intentId, frame, row) => {
			const key = `${sid}:${intentId}`;
			const existing = records.get(key);
			if (existing) return { ok: true, revision: existing.revision };
			records.set(key, { key, sessionId: sid, intentId, frame, row, revision: 0, createdAt: Date.now(), updatedAt: Date.now() });
			return { ok: true, revision: 0 };
		});
		vi.spyOn(storage.deliveryIntents, "list").mockImplementation(async (sid) =>
			[...records.values()].filter((record) => record.sessionId === sid));
		vi.spyOn(storage.deliveryIntents, "replaceIfRevision").mockImplementation(async (sid, intentId, revision, frame, row) => {
			const key = `${sid}:${intentId}`;
			const current = records.get(key);
			if (!current || current.revision !== revision) return { ok: true, applied: false, ...(current ? { current } : {}) };
			const next = { ...current, frame, row, revision: revision + 1, updatedAt: Date.now() };
			records.set(key, next);
			if ((row as any).deliveryState === "local") {
				signalRetryPersisted();
				await retryRelease;
			}
			return { ok: true, applied: true, current: next };
		});
		vi.spyOn(storage.deliveryIntents, "deleteIfRevision").mockImplementation(async (sid, intentId, revision) => {
			const key = `${sid}:${intentId}`;
			const current = records.get(key);
			if (!current || current.revision !== revision) return { ok: true, applied: false, ...(current ? { current } : {}) };
			records.delete(key);
			return { ok: true, applied: true };
		});
		vi.spyOn(storage.deliveryIntents, "delete").mockImplementation(async (sid, intentId) => {
			records.delete(`${sid}:${intentId}`);
		});

		const staleTab = makeAgent(OPEN);
		staleTab._sessionId = sessionId;
		staleTab._connectionStatus = "connected";
		await staleTab.prompt("choose a model then retry");
		const originalFrame = snapshot(staleTab).sent[0];
		const intentId = originalFrame.intentId;
		await staleTab.handleServerMessage({
			type: "error",
			code: "MODEL_SELECTION_REQUIRED",
			message: "Choose a replacement model before sending.",
			intentId,
			retryable: true,
		});

		const retryingTab = makeAgent(OPEN);
		retryingTab._sessionId = sessionId;
		retryingTab._connectionStatus = "connected";
		await retryingTab._restoreDeliveryOutbox();
		expect(snapshot(retryingTab).queue[0]).toMatchObject({ id: intentId, deliveryState: "failed" });

		retryingTab.retryIntent(intentId);
		await retryPersisted;
		expect(records.get(`${sessionId}:${intentId}`)).toMatchObject({ revision: 2, row: { deliveryState: "local" } });

		// Tab B closes after persistence but before its retry callback can send.
		// Tab A is still connected and rendered failed revision 1.
		retryingTab.ws.readyState = CLOSED;
		retryingTab._connectionStatus = "disconnected";
		retryingTab._pendingOutbox = [];
		staleTab.removeQueued(intentId);
		await vi.waitFor(() => expect(snapshot(staleTab).queue[0]).toMatchObject({ id: intentId, deliveryState: "local" }));
		expect(records.has(`${sessionId}:${intentId}`)).toBe(true);

		// Losing the dismissal CAS adopts revision 2 and immediately takes over its
		// send. The initial rejected send plus exactly one retry use the same ID.
		expect(snapshot(staleTab).sent).toEqual([originalFrame, originalFrame]);
		staleTab._flushOutbox();
		expect(snapshot(staleTab).sent).toHaveLength(2);

		releaseRetry();
		await Promise.resolve();
		expect(snapshot(retryingTab).sent).toHaveLength(0);

		await staleTab.handleServerMessage({
			type: "delivery_outbox",
			outbox: [{ id: intentId, text: "choose a model then retry", isSteered: false, deliveryState: "dispatching", createdAt: 1 }],
		});
		expect(snapshot(staleTab).queue).toHaveLength(1);
		expect(records.has(`${sessionId}:${intentId}`)).toBe(false);
		staleTab.handleAgentEvent({
			type: "message_start",
			message: { id: "pi-retry", role: "user", content: [{ type: "text", text: "choose a model then retry" }], deliveryIntentId: intentId },
		});
		expect(snapshot(staleTab).queue).toHaveLength(0);
		expect(staleTab._state.messages.filter((message: any) => message.deliveryIntentId === intentId))
			.toEqual([expect.objectContaining({ deliveryIntentId: intentId })]);
	});

	it("atomically refuses deletion after the persisted revision advances", async () => {
		const rows = new Map<string, PersistedDeliveryIntent>();
		const backend = {
			async get(_store: string, key: string) { return rows.get(key) ?? null; },
			async set(_store: string, key: string, value: PersistedDeliveryIntent) { rows.set(key, value); },
			async delete(_store: string, key: string) { rows.delete(key); },
			async getAllFromIndex() { return [...rows.values()]; },
			async transaction(_stores: string[], _mode: string, operation: any) {
				return operation({
					get: async (_store: string, key: string) => rows.get(key) ?? null,
					set: async (_store: string, key: string, value: PersistedDeliveryIntent) => { rows.set(key, value); },
					delete: async (_store: string, key: string) => { rows.delete(key); },
				});
			},
		} as unknown as StorageBackend;
		const store = new DeliveryIntentStore(backend);
		await store.put("session", "intent", { type: "prompt", intentId: "intent", text: "x" }, {
			id: "intent", text: "x", deliveryState: "failed", createdAt: 1,
		});
		const retry = await store.replaceIfRevision("session", "intent", 0,
			{ type: "prompt", intentId: "intent", text: "x" },
			{ id: "intent", text: "x", deliveryState: "local", createdAt: 1 });
		expect(retry).toMatchObject({ ok: true, applied: true, current: { revision: 1 } });
		const staleDismiss = await store.deleteIfRevision("session", "intent", 0);
		expect(staleDismiss).toMatchObject({ ok: true, applied: false, current: { revision: 1 } });
		expect((await store.list("session"))[0]).toMatchObject({ revision: 1, row: { deliveryState: "local" } });
	});
});
