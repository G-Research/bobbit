/**
 * Regression coverage for model state hydration after WebSocket reconnect.
 *
 * A persisted model must be pushed back to the client immediately on reconnect
 * so the footer/context bar never renders the hardcoded remote-agent placeholder
 * (or an older Claude Opus default) as authoritative state.
 */
import { vi } from "vitest";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	agentEndPredicate,
	type WsConnection,
	type WsMsg,
} from "./_helpers/e2e/e2e-setup.js";
import { pollUntil } from "../../support/helpers/e2e/cleanup.js";
import {
	getAvailableModels,
	invalidateModelCache,
	resolveModelStateMeta,
	type ApiModel,
} from "../../../src/server/agent/model-registry.js";

const OPUS_5 = { provider: "anthropic", id: "claude-opus-5", thinkingLevel: "xhigh" } as const;
const STALE_MODEL_IDS = new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4"]);
const SNAPSHOT_PROVIDER = "tuple-snapshot-custom";
const LIVE_DYNAMIC_TUPLE = { provider: "custom", id: "cache-empty-dynamic-a", thinkingLevel: "high" } as const;
const LIVE_DYNAMIC_MODEL = {
	provider: LIVE_DYNAMIC_TUPLE.provider,
	id: LIVE_DYNAMIC_TUPLE.id,
	contextWindow: 654_319,
	maxTokens: 23_417,
	reasoning: true,
	thinkingLevelMap: { off: null, high: "high", max: "max" },
} as const;
const FOREIGN_DYNAMIC_MODEL = {
	provider: LIVE_DYNAMIC_TUPLE.provider,
	id: "cache-empty-dynamic-foreign",
	contextWindow: 777_731,
	maxTokens: 31_337,
	reasoning: true,
	thinkingLevelMap: { off: "foreign-off", max: "foreign-max" },
} as const;
const DURABLE_SNAPSHOT_TUPLE = { provider: SNAPSHOT_PROVIDER, id: "durable-a", thinkingLevel: "high" } as const;
const TARGET_SNAPSHOT_TUPLE = { provider: SNAPSHOT_PROVIDER, id: "target-b", thinkingLevel: "xhigh" } as const;
const DURABLE_SNAPSHOT_MODEL = {
	provider: SNAPSHOT_PROVIDER,
	id: DURABLE_SNAPSHOT_TUPLE.id,
	contextWindow: 131_071,
	maxTokens: 8_191,
	reasoning: true,
	input: ["text"],
	thinkingLevelMap: { off: "off", high: "high" },
} as const;
const TARGET_SNAPSHOT_MODEL = {
	provider: SNAPSHOT_PROVIDER,
	id: TARGET_SNAPSHOT_TUPLE.id,
	contextWindow: 262_139,
	maxTokens: 32_749,
	reasoning: true,
	input: ["text"],
	thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
} as const;

function snapshotCatalogRow(model: typeof DURABLE_SNAPSHOT_MODEL | typeof TARGET_SNAPSHOT_MODEL): ApiModel {
	return {
		...model,
		name: model.id,
		api: "openai-completions",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		authenticated: true,
	};
}

async function installSnapshotCatalog(gateway: any): Promise<void> {
	invalidateModelCache();
	const preferencesStore = gateway.sessionManager.preferencesStore;
	expect(preferencesStore, "gateway fixture must expose the current model preferences").toBeTruthy();
	const models = await getAvailableModels(preferencesStore);
	expect(models.some((model) => model.provider === SNAPSHOT_PROVIDER)).toBe(false);
	models.push(snapshotCatalogRow(DURABLE_SNAPSHOT_MODEL), snapshotCatalogRow(TARGET_SNAPSHOT_MODEL));
}

function stateModelId(message: WsMsg): string | undefined {
	return message.type === "state" ? (message.data as any)?.model?.id : undefined;
}

function isOpus5XhighState(message: WsMsg): boolean {
	if (message.type !== "state") return false;
	const state = message.data as any;
	return state?.model?.provider === OPUS_5.provider
		&& state?.model?.id === OPUS_5.id
		&& state?.thinkingLevel === OPUS_5.thinkingLevel;
}

function expectNoStaleModelBeforeOpus5(messages: WsMsg[], context: string) {
	const staleBeforeTarget: string[] = [];
	let sawTarget = false;
	for (const message of messages) {
		const id = stateModelId(message);
		if (!id) continue;
		if (isOpus5XhighState(message)) {
			sawTarget = true;
			break;
		}
		if (STALE_MODEL_IDS.has(id)) staleBeforeTarget.push(id);
	}
	expect(sawTarget, `${context}: expected Opus 5/xhigh state; got ${JSON.stringify(messages.filter(m => m.type === "state").map(m => m.data))}`).toBe(true);
	expect(staleBeforeTarget, `${context}: stale/placeholder Opus state must not appear before ${OPUS_5.id}`).toEqual([]);
}

function expectOnlyCompleteOpus5Tuples(messages: WsMsg[], context: string) {
	const modelFrames = messages.filter((message) => stateModelId(message) !== undefined);
	expect(modelFrames.length, `${context}: expected at least one model state frame`).toBeGreaterThan(0);
	expect(
		modelFrames.map((message) => {
			const state = message.data as any;
			return {
				provider: state.model.provider,
				id: state.model.id,
				thinkingLevel: state.thinkingLevel,
			};
		}),
		`${context}: every model state frame must contain one complete authoritative tuple`,
	).toEqual(modelFrames.map(() => OPUS_5));
}

async function waitForPersistedOpus5Xhigh(gateway: any, sessionId: string) {
	await pollUntil(async () => {
		const persisted = gateway.sessionManager.getPersistedSession(sessionId);
		return persisted?.modelProvider === OPUS_5.provider
			&& persisted.modelId === OPUS_5.id
			&& persisted.effectiveThinkingLevel === OPUS_5.thinkingLevel;
	}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 5/xhigh tuple persisted" });
}

async function closeWs(ws: WsConnection) {
	const closed = new Promise<void>(r => ws.ws.once("close", () => r()));
	ws.close();
	await closed;
}

async function waitForPersistedTuple(gateway: any, sessionId: string, tuple: typeof DURABLE_SNAPSHOT_TUPLE | typeof TARGET_SNAPSHOT_TUPLE) {
	await pollUntil(async () => {
		const persisted = gateway.sessionManager.getPersistedSession(sessionId);
		return persisted?.modelProvider === tuple.provider
			&& persisted.modelId === tuple.id
			&& persisted.effectiveThinkingLevel === tuple.thinkingLevel;
	}, { timeoutMs: 5_000, intervalMs: 25, label: `${tuple.id}/${tuple.thinkingLevel} tuple persisted` });
}

function expectDurablePartialMutationSnapshot(
	message: WsMsg,
	expectedStatus: string,
	expectedStatusVersion: number,
	expectedCost: Record<string, unknown>,
): void {
	expect(message.type).toBe("state");
	const state = message.data as any;
	expect(state.model, "an in-flight model must not lend identity or metadata to the durable snapshot").toEqual(DURABLE_SNAPSHOT_MODEL);
	expect(state.thinkingLevel).toBe(DURABLE_SNAPSHOT_TUPLE.thinkingLevel);
	expect(state.status).toBe(expectedStatus);
	expect(state.statusVersion).toBe(expectedStatusVersion);
	expect(state.preparing).toBe(false);
	expect(state.serverCost).toEqual(expectedCost);
}

async function exercisePartialMutationSnapshot(
	gateway: any,
	sessionId: string,
	path: "explicit-get-state" | "second-connection",
): Promise<void> {
	await installSnapshotCatalog(gateway);
	const session = gateway.sessionManager.getSession(sessionId);
	expect(session?.status).toBe("idle");

	let ws1: WsConnection | undefined;
	let ws2: WsConnection | undefined;
	let getStateSpy: ReturnType<typeof vi.spyOn> | undefined;
	let setThinkingSpy: ReturnType<typeof vi.spyOn> | undefined;
	let released = false;
	let releaseThinking!: () => void;
	const thinkingRelease = new Promise<void>((resolve) => {
		releaseThinking = () => {
			if (released) return;
			released = true;
			resolve();
		};
	});

	try {
		ws1 = await connectWs(sessionId);
		const durableCursor = ws1.messageCount();
		ws1.send({
			type: "set_model",
			provider: DURABLE_SNAPSHOT_TUPLE.provider,
			modelId: DURABLE_SNAPSHOT_TUPLE.id,
			thinkingLevel: DURABLE_SNAPSHOT_TUPLE.thinkingLevel,
		});
		const durableState = await ws1.waitForFrom(
			durableCursor,
			(message) => message.type === "state"
				&& (message.data as any)?.model?.id === DURABLE_SNAPSHOT_TUPLE.id
				&& (message.data as any)?.thinkingLevel === DURABLE_SNAPSHOT_TUPLE.thinkingLevel,
			5_000,
		);
		expect((durableState.data as any).model).toEqual(DURABLE_SNAPSHOT_MODEL);
		await waitForPersistedTuple(gateway, sessionId, DURABLE_SNAPSHOT_TUPLE);

		// Proactive hydration is intentionally reserved for sessions with history.
		// A synthetic buffered event exercises that real attach branch without an
		// unrelated prompt turn or timing dependency.
		session.eventBuffer.push({ type: "tuple_snapshot_test_seed" });
		const expectedCost = gateway.sessionManager.getCostTracker(session.projectId).recordUsage(sessionId, {
			inputTokens: 321,
			outputTokens: 45,
			cacheReadTokens: 67,
			cacheWriteTokens: 8,
			cost: 7.25,
		});
		const expectedStatus = session.status;
		const expectedStatusVersion = session.statusVersion;

		const realGetState = session.rpcClient.getState.bind(session.rpcClient);
		const realSetThinkingLevel = session.rpcClient.setThinkingLevel.bind(session.rpcClient);
		getStateSpy = vi.spyOn(session.rpcClient, "getState").mockImplementation(async () => {
			const response = await realGetState();
			if (!response.success) return response;
			return {
				...response,
				data: {
					...(response.data as Record<string, unknown> | undefined ?? {}),
					preparing: false,
				},
			};
		});
		setThinkingSpy = vi.spyOn(session.rpcClient, "setThinkingLevel").mockImplementation(async (...args: unknown[]) => {
			await thinkingRelease;
			return realSetThinkingLevel(args[0] as string);
		});

		const selectionCursor = ws1.messageCount();
		ws1.send({
			type: "set_model",
			provider: TARGET_SNAPSHOT_TUPLE.provider,
			modelId: TARGET_SNAPSHOT_TUPLE.id,
			thinkingLevel: TARGET_SNAPSHOT_TUPLE.thinkingLevel,
		});
		await pollUntil(
			async () => (setThinkingSpy?.mock.calls.length ?? 0) === 1,
			{ timeoutMs: 5_000, intervalMs: 10, label: "target model bound while thinking mutation is held" },
		);
		const partialLiveState = await realGetState();
		expect(partialLiveState).toMatchObject({
			success: true,
			data: {
				model: { provider: TARGET_SNAPSHOT_TUPLE.provider, id: TARGET_SNAPSHOT_TUPLE.id },
				thinkingLevel: DURABLE_SNAPSHOT_TUPLE.thinkingLevel,
			},
		});
		await waitForPersistedTuple(gateway, sessionId, DURABLE_SNAPSHOT_TUPLE);

		let snapshot: WsMsg;
		if (path === "explicit-get-state") {
			const stateCursor = ws1.messageCount();
			ws1.send({ type: "get_state" });
			snapshot = await ws1.waitForFrom(
				stateCursor,
				(message) => message.type === "state"
					&& (message.data as any)?.preparing === false
					&& (message.data as any)?.model?.id !== undefined,
				5_000,
			);
		} else {
			ws2 = await connectWs(sessionId);
			snapshot = await ws2.waitFor(
				(message) => message.type === "state"
					&& (message.data as any)?.preparing === false
					&& (message.data as any)?.model?.id !== undefined,
				5_000,
			);
		}
		expectDurablePartialMutationSnapshot(snapshot, expectedStatus, expectedStatusVersion, expectedCost);

		releaseThinking();
		const committed = await ws1.waitForFrom(
			selectionCursor,
			(message) => message.type === "state"
				&& (message.data as any)?.model?.id === TARGET_SNAPSHOT_TUPLE.id
				&& (message.data as any)?.thinkingLevel === TARGET_SNAPSHOT_TUPLE.thinkingLevel,
			5_000,
		);
		expect((committed.data as any).model).toEqual(TARGET_SNAPSHOT_MODEL);
		await waitForPersistedTuple(gateway, sessionId, TARGET_SNAPSHOT_TUPLE);
	} finally {
		releaseThinking();
		if ((setThinkingSpy?.mock.calls.length ?? 0) > 0) {
			await waitForPersistedTuple(gateway, sessionId, TARGET_SNAPSHOT_TUPLE).catch(() => {});
		}
		setThinkingSpy?.mockRestore();
		getStateSpy?.mockRestore();
		if (ws2) await closeWs(ws2);
		if (ws1) await closeWs(ws1);
		invalidateModelCache();
	}
}

async function prepareDurableOpus5Xhigh(gateway: any, sessionId: string): Promise<void> {
	const ws = await connectWs(sessionId);
	try {
		const selectionCursor = ws.messageCount();
		ws.send({
			type: "set_model",
			provider: OPUS_5.provider,
			modelId: OPUS_5.id,
			thinkingLevel: OPUS_5.thinkingLevel,
		});
		await ws.waitForFrom(selectionCursor, isOpus5XhighState, 10_000);
		await waitForPersistedOpus5Xhigh(gateway, sessionId);

		// Guarantee attach takes the proactive live getState path.
		ws.send({ type: "prompt", text: "seed reconnect state hydration" });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		await closeWs(ws);
	}
}

test.describe("model state after reconnect", () => {
	let sessionId: string;

	test.beforeEach(async () => {
		sessionId = await createSession();
	});

	test("reconnect sends state with correct contextWindow for persisted model", async () => {
		const ws1 = await connectWs(sessionId);
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });

		// Send a prompt so eventBuffer has content and reconnect exercises the
		// proactive getState path, not only the persisted fallback path.
		ws1.send({ type: "prompt", text: "hello" });
		await ws1.waitFor(agentEndPredicate(), 10_000);

		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-sonnet-5";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "model persisted" });

		await closeWs(ws1);

		const ws2 = await connectWs(sessionId);
		ws2.send({ type: "get_state" });
		await ws2.waitFor(
			(m: WsMsg) =>
				m.type === "state" &&
				(m.data as any)?.model?.contextWindow === 1_000_000,
			5_000,
		).catch(() => {});

		const stateMessages = ws2.messages.filter((m: WsMsg) => m.type === "state");
		const hasCorrectContextWindow = stateMessages.some((m: WsMsg) => {
			const model = (m.data as any)?.model;
			return model && model.contextWindow === 1_000_000;
		});
		const contextWindows = stateMessages
			.map((m: WsMsg) => (m.data as any)?.model?.contextWindow)
			.filter((v: unknown) => v !== undefined);

		expect(hasCorrectContextWindow,
			`Expected at least one state message with contextWindow === 1000000 after reconnect, ` +
			`but got contextWindow values: [${contextWindows.join(", ")}] ` +
			`from ${stateMessages.length} state message(s). ` +
			`State data: ${JSON.stringify(stateMessages.map(m => m.data))}`
		).toBe(true);

		ws2.close();
	});

	test("explicit get_state retains the durable custom tuple while thinking mutation is pending", async ({ gateway }) => {
		await exercisePartialMutationSnapshot(gateway, sessionId, "explicit-get-state");
	});

	test("a second connection retains the durable custom tuple while thinking mutation is pending", async ({ gateway }) => {
		await exercisePartialMutationSnapshot(gateway, sessionId, "second-connection");
	});

	test("cache-empty unavailable metadata preserves only matching live identity while durable thinking repairs the tuple", async ({ gateway }) => {
		const session = gateway.sessionManager.getSession(sessionId);
		expect(session?.status).toBe("idle");
		gateway.sessionManager.persistSessionModel(
			sessionId,
			LIVE_DYNAMIC_TUPLE.provider,
			LIVE_DYNAMIC_TUPLE.id,
			LIVE_DYNAMIC_TUPLE.thinkingLevel,
		);
		expect(gateway.sessionManager.getPersistedSession(sessionId)).toMatchObject({
			modelProvider: LIVE_DYNAMIC_TUPLE.provider,
			modelId: LIVE_DYNAMIC_TUPLE.id,
			effectiveThinkingLevel: LIVE_DYNAMIC_TUPLE.thinkingLevel,
		});

		// Exact composed metadata is temporarily unavailable: only the identity-matched
		// live bridge may preserve its trustworthy limits and thinking map.
		invalidateModelCache();
		expect(resolveModelStateMeta(LIVE_DYNAMIC_TUPLE.provider, LIVE_DYNAMIC_TUPLE.id).source).toBe("unavailable");
		session.eventBuffer.push({ type: "live_dynamic_snapshot_test_seed" });

		const getState = vi.spyOn(session.rpcClient, "getState")
			.mockResolvedValueOnce({
				success: true,
				data: { model: { ...LIVE_DYNAMIC_MODEL } },
			})
			.mockResolvedValueOnce({
				success: true,
				data: { model: { ...LIVE_DYNAMIC_MODEL }, thinkingLevel: "low" },
			})
			.mockResolvedValueOnce({
				success: true,
				data: { model: { ...FOREIGN_DYNAMIC_MODEL }, thinkingLevel: "low" },
			});
		let ws: WsConnection | undefined;
		try {
			ws = await connectWs(sessionId);
			const missingThinking = await ws.waitFor(
				(message) => stateModelId(message) === LIVE_DYNAMIC_TUPLE.id,
				5_000,
			);
			expect((missingThinking.data as any).model).toEqual(LIVE_DYNAMIC_MODEL);
			expect((missingThinking.data as any).thinkingLevel).toBe(LIVE_DYNAMIC_TUPLE.thinkingLevel);

			let cursor = ws.messageCount();
			ws.send({ type: "get_state" });
			const mismatchedThinking = await ws.waitForFrom(
				cursor,
				(message) => stateModelId(message) === LIVE_DYNAMIC_TUPLE.id,
				5_000,
			);
			expect((mismatchedThinking.data as any).model).toEqual(LIVE_DYNAMIC_MODEL);
			expect((mismatchedThinking.data as any).thinkingLevel).toBe(LIVE_DYNAMIC_TUPLE.thinkingLevel);

			cursor = ws.messageCount();
			ws.send({ type: "get_state" });
			const differentIdentity = await ws.waitForFrom(
				cursor,
				(message) => stateModelId(message) === LIVE_DYNAMIC_TUPLE.id,
				5_000,
			);
			const differentIdentityState = differentIdentity.data as any;
			expect(differentIdentityState.thinkingLevel).toBe(LIVE_DYNAMIC_TUPLE.thinkingLevel);
			expect(differentIdentityState.model).toEqual({
				provider: LIVE_DYNAMIC_TUPLE.provider,
				id: LIVE_DYNAMIC_TUPLE.id,
			});
			expect(getState).toHaveBeenCalledTimes(3);
		} finally {
			getState.mockRestore();
			if (ws) await closeWs(ws);
			invalidateModelCache();
		}
	});

	test("matching live model without thinking hydrates one complete durable tuple on reconnect and get_state", async ({ gateway }) => {
		await prepareDurableOpus5Xhigh(gateway, sessionId);
		const session = gateway.sessionManager.getSession(sessionId);
		expect(session?.eventBuffer.size).toBeGreaterThan(0);
		const getState = vi.spyOn(session!.rpcClient, "getState").mockResolvedValue({
			success: true,
			data: { model: { provider: OPUS_5.provider, id: OPUS_5.id } },
		});
		let ws: WsConnection | undefined;
		try {
			ws = await connectWs(sessionId);
			await ws.waitFor((message) => stateModelId(message) !== undefined, 5_000);
			expectOnlyCompleteOpus5Tuples(ws.messages, "proactive attach with matching model");

			const cursor = ws.messageCount();
			ws.send({ type: "get_state" });
			await ws.waitForFrom(cursor, (message) => stateModelId(message) !== undefined, 5_000);
			expectOnlyCompleteOpus5Tuples(ws.messages.slice(cursor), "explicit get_state with matching model");
			expect(getState).toHaveBeenCalledTimes(2);
		} finally {
			getState.mockRestore();
			ws?.close();
		}
	});

	test("mismatched live model without thinking falls back before emitting any model tuple", async ({ gateway }) => {
		await prepareDurableOpus5Xhigh(gateway, sessionId);
		const session = gateway.sessionManager.getSession(sessionId);
		expect(session?.eventBuffer.size).toBeGreaterThan(0);
		const getState = vi.spyOn(session!.rpcClient, "getState").mockResolvedValue({
			success: true,
			data: { model: { provider: "anthropic", id: "claude-sonnet-5" } },
		});
		let ws: WsConnection | undefined;
		try {
			ws = await connectWs(sessionId);
			await ws.waitFor((message) => stateModelId(message) !== undefined, 5_000);
			expectOnlyCompleteOpus5Tuples(ws.messages, "proactive attach with mismatched model");

			const cursor = ws.messageCount();
			ws.send({ type: "get_state" });
			await ws.waitForFrom(cursor, (message) => stateModelId(message) !== undefined, 5_000);
			expectOnlyCompleteOpus5Tuples(ws.messages.slice(cursor), "explicit get_state with mismatched model");
			expect(getState).toHaveBeenCalledTimes(2);
		} finally {
			getState.mockRestore();
			ws?.close();
		}
	});

	test("combined Opus 5/xhigh selection persists and reconnects without a stale model flash", async ({ gateway }) => {
		const ws1 = await connectWs(sessionId);

		// One combined request crosses the real gateway/mock-agent path. The exact
		// verified tuple must be returned and durably committed together.
		const selectionCursor = ws1.messageCount();
		ws1.send({
			type: "set_model",
			provider: OPUS_5.provider,
			modelId: OPUS_5.id,
			thinkingLevel: OPUS_5.thinkingLevel,
		});
		const selected = await ws1.waitForFrom(selectionCursor, isOpus5XhighState, 10_000);
		expect((selected.data as any).model).toMatchObject({
			provider: OPUS_5.provider,
			id: OPUS_5.id,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expectNoStaleModelBeforeOpus5(ws1.messages.slice(selectionCursor), "after combined selection");
		await waitForPersistedOpus5Xhigh(gateway, sessionId);

		// Populate the event buffer so reconnect exercises authoritative live-state
		// hydration rather than only the persisted fallback response.
		ws1.send({ type: "prompt", text: "Opus 5 reconnect tuple" });
		await ws1.waitFor(agentEndPredicate(), 10_000);
		await closeWs(ws1);

		const ws2 = await connectWs(sessionId);
		await ws2.waitFor(isOpus5XhighState, 10_000);
		expectNoStaleModelBeforeOpus5(ws2.messages, "reconnect initial state");
		await waitForPersistedOpus5Xhigh(gateway, sessionId);
		ws2.close();
	});
});
