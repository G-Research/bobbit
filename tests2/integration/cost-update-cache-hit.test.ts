/**
 * API E2E: cost_update WebSocket payload carries derived `cacheHitRate`.
 *
 * Drives the in-process gateway + mock agent through a normal prompt turn
 * so the server's `trackCostFromEvent` path emits a `cost_update`. We assert
 * the broadcast message includes a `cacheHitRate` field on `cost`, and that
 * its value matches the formula `cacheReadTokens / (cacheReadTokens + inputTokens)`
 * (returning `null` when the denominator is 0). A deterministic synthetic
 * assistant usage event also pins non-zero `cacheRead` → `cacheReadTokens`
 * mapping for both WS and REST snapshots.
 *
 * See design: "Cache-Hit Metric".
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	WsConnection,
} from "./_e2e/e2e-setup.js";

// Both tests share a single session + WS connection created in beforeAll:
// the first test drives a prompt that populates the cost tracker, the second
// reads the resulting REST snapshot. Under fullyParallel mode Playwright will
// dispatch the two tests to separate workers — each worker re-runs beforeAll
// against a fresh session, leaving the REST snapshot test with no cost data
// (404 from /api/sessions/:id/cost). Force serial so the prompt populates the
// same session the REST test queries.
test.describe.configure({ mode: "serial" });

let sessionId: string;
let wsConn: WsConnection;

function emitAssistantUsage(gateway: any, targetSessionId: string, usage: Record<string, unknown>): void {
	const session = gateway.sessionManager.getSession(targetSessionId);
	expect(session, `session ${targetSessionId} should be live`).toBeTruthy();
	const listeners = [...((session!.rpcClient as any).eventListeners || [])] as Array<(event: any) => void>;
	expect(listeners.length).toBeGreaterThan(0);
	for (const listener of listeners) {
		listener({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "synthetic cache usage" }],
				usage,
			},
		});
	}
}

test.beforeAll(async () => {
	sessionId = await createSession();
	wsConn = await connectWs(sessionId);
});

test.afterAll(async () => {
	wsConn?.close();
	await deleteSession(sessionId).catch(() => {});
});

test("cost_update broadcast includes derived cacheHitRate", async () => {
	test.setTimeout(20_000);

	// Capture cursor before triggering the prompt so we only match the next
	// cost_update broadcast.
	const cursor = wsConn.messageCount();

	// Drive a normal prompt through the mock agent. It emits a message_end
	// event with a `usage` block which the server feeds to CostTracker.
	wsConn.send({ type: "prompt", text: "hello" });

	const msg = await wsConn.waitForFrom(
		cursor,
		(m) => m.type === "cost_update" && m.sessionId === sessionId,
		15_000,
	);

	expect(msg.cost).toBeDefined();
	// Backwards-compatible: existing fields untouched.
	expect(typeof msg.cost.inputTokens).toBe("number");
	expect(typeof msg.cost.outputTokens).toBe("number");
	expect(typeof msg.cost.cacheReadTokens).toBe("number");
	expect(typeof msg.cost.cacheWriteTokens).toBe("number");
	expect(typeof msg.cost.totalCost).toBe("number");

	// New derived field must be present, either a number in [0,1] or null.
	expect(Object.prototype.hasOwnProperty.call(msg.cost, "cacheHitRate")).toBe(true);

	const denom = msg.cost.cacheReadTokens + msg.cost.inputTokens;
	if (denom === 0) {
		expect(msg.cost.cacheHitRate).toBeNull();
	} else {
		const expected = msg.cost.cacheReadTokens / denom;
		expect(typeof msg.cost.cacheHitRate).toBe("number");
		expect(msg.cost.cacheHitRate).toBeGreaterThanOrEqual(0);
		expect(msg.cost.cacheHitRate).toBeLessThanOrEqual(1);
		expect(msg.cost.cacheHitRate).toBeCloseTo(expected, 10);
	}
});

test("/api/sessions/:id/cost REST snapshot includes cacheHitRate", async () => {
	const resp = await apiFetch(`/api/sessions/${sessionId}/cost`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(Object.prototype.hasOwnProperty.call(body, "cacheHitRate")).toBe(true);
	// Either null (cold) or a finite number in [0,1].
	if (body.cacheHitRate !== null) {
		expect(typeof body.cacheHitRate).toBe("number");
		expect(body.cacheHitRate).toBeGreaterThanOrEqual(0);
		expect(body.cacheHitRate).toBeLessThanOrEqual(1);
	}
});

test("successful direct Anthropic Messages usage at the cache-stall threshold emits a diagnostic posture notice", async ({ gateway }) => {
	const targetSessionId = await createSession();
	const ws = await connectWs(targetSessionId);
	try {
		const models = await (await import("../../src/server/agent/model-registry.js"))
			.getAvailableModels(gateway.sessionManager.preferencesStore);
		const model = models.find((candidate: any) => (
			candidate.provider === "anthropic"
			&& candidate.api === "anthropic-messages"
			&& candidate.sessionSelectable !== false
			&& candidate.input?.includes("text")
		));
		expect(model, "integration fixture must provide a direct Anthropic Messages text model").toBeTruthy();
		if (!model) throw new Error("integration fixture is missing a direct Anthropic Messages text model");

		const selectionCursor = ws.messageCount();
		ws.send({ type: "set_model", provider: model.provider, modelId: model.id });
		await ws.waitForFrom(
			selectionCursor,
			(message) => message.type === "state"
				&& message.data?.model?.provider === model.provider
				&& message.data?.model?.id === model.id,
			5_000,
		);

		const cursor = ws.messageCount();
		emitAssistantUsage(gateway, targetSessionId, {
			input: 50_000,
			output: 1,
			cacheRead: 0,
			cacheWrite: 500,
			totalTokens: 50_501,
			cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0.005, total: 0.505 },
		});

		const costUpdate = await ws.waitForFrom(
			cursor,
			(message) => message.type === "cost_update" && message.sessionId === targetSessionId,
			5_000,
		);
		expect(costUpdate.cost.inputTokens).toBe(50_000);
		expect(costUpdate.cost.cacheReadTokens).toBe(0);
		expect(costUpdate.cost.cacheWriteTokens).toBe(500);

		const cacheStallNotice = ws.messages.slice(cursor).find((message) => (
			message.type === "event"
			&& typeof message.data?.type === "string"
			&& /cache.*stall/i.test(message.data.type)
		));
		expect(
			cacheStallNotice,
			"CACHE_STALL_REPRO: a successful direct Anthropic Messages session with 50,000 cumulative fresh input, zero cache reads, and cache writes must emit a cache-stall diagnostic/posture notice",
		).toBeTruthy();
	} finally {
		ws.close();
		await deleteSession(targetSessionId).catch(() => {});
	}
});

test("cache stall is thresholded, written once, retained through recovery, and replayed on reattach", async ({ gateway }) => {
	const targetSessionId = await createSession();
	let ws = await connectWs(targetSessionId);
	try {
		const models = await (await import("../../src/server/agent/model-registry.js"))
			.getAvailableModels(gateway.sessionManager.preferencesStore);
		const model = models.find((candidate: any) => (
			candidate.provider === "anthropic"
			&& candidate.api === "anthropic-messages"
			&& candidate.sessionSelectable !== false
			&& candidate.input?.includes("text")
		));
		expect(model).toBeTruthy();
		if (!model) throw new Error("integration fixture is missing a direct Anthropic Messages text model");
		ws.send({ type: "set_model", provider: model.provider, modelId: model.id });
		await ws.waitFor((message) => message.type === "state" && message.data?.model?.id === model.id, 5_000);

		const cursor = ws.messageCount();
		emitAssistantUsage(gateway, targetSessionId, {
			input: 49_999, output: 1, cacheRead: 0, cacheWrite: 500, cost: { total: 0.5 },
		});
		await ws.waitForFrom(cursor, (message) => message.type === "cost_update", 5_000);
		expect(ws.messages.slice(cursor).filter((message) => message.data?.type === "cache_stall")).toHaveLength(0);

		emitAssistantUsage(gateway, targetSessionId, {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 1, cost: { total: 0.01 },
		});
		await ws.waitForFrom(cursor, (message) => message.data?.type === "cache_stall", 5_000);
		emitAssistantUsage(gateway, targetSessionId, {
			input: 10, output: 1, cacheRead: 0, cacheWrite: 1, cost: { total: 0.01 },
		});
		expect(ws.messages.slice(cursor).filter((message) => message.data?.type === "cache_stall")).toHaveLength(1);

		emitAssistantUsage(gateway, targetSessionId, {
			input: 0, output: 1, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 },
		});
		const persisted = gateway.sessionManager.getPersistedSession(targetSessionId)!;
		expect(persisted.cachePosture?.stallWarning?.inputTokens).toBe(50_000);
		expect(persisted.cachePosture?.healthyAt).toEqual(expect.any(Number));

		ws.close();
		ws = await connectWs(targetSessionId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ws.messages.filter((message) => message.data?.type === "cache_posture")).toHaveLength(1);
		expect(ws.messages.filter((message) => message.data?.type === "cache_stall")).toHaveLength(1);
	} finally {
		ws.close();
		await deleteSession(targetSessionId).catch(() => {});
	}
});

test("capable-posture baselines exclude prior unproven usage from health and stall detection", async ({ gateway }) => {
	const targetSessionId = await createSession();
	const ws = await connectWs(targetSessionId);
	try {
		const model = (await (await import("../../src/server/agent/model-registry.js"))
			.getAvailableModels(gateway.sessionManager.preferencesStore))
			.find((candidate: any) => candidate.provider === "anthropic"
				&& candidate.api === "anthropic-messages"
				&& candidate.sessionSelectable !== false
				&& candidate.input?.includes("text"));
		expect(model).toBeTruthy();
		if (!model) throw new Error("integration fixture is missing a direct Anthropic Messages text model");

		// Direct persistence isolates the canonical usage boundary from the mock
		// agent's current model: prior unproven totals must not count for Claude.
		gateway.sessionManager.persistSessionModel(targetSessionId, "unproven", "prior-model", "medium");
		gateway.sessionManager.persistCachePostureForResolvedModel(targetSessionId, "unproven", "prior-model");
		emitAssistantUsage(gateway, targetSessionId, {
			input: 50_000, output: 1, cacheRead: 500, cacheWrite: 0, cost: { total: 0.5 },
		});
		gateway.sessionManager.persistSessionModel(targetSessionId, model.provider, model.id, "medium");
		gateway.sessionManager.persistCachePostureForResolvedModel(targetSessionId, model.provider, model.id, model);

		const cursor = ws.messageCount();
		emitAssistantUsage(gateway, targetSessionId, {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 },
		});
		await ws.waitForFrom(cursor, (message) => message.type === "cost_update", 5_000);
		const afterColdTurn = gateway.sessionManager.getPersistedSession(targetSessionId)!;
		expect(afterColdTurn.cachePosture?.healthyAt).toBeUndefined();
		expect(afterColdTurn.cacheStallHistory).toBeUndefined();
		expect(afterColdTurn.cachePostureUsageBaseline).toMatchObject({
			inputTokens: 50_000,
			cacheReadTokens: 500,
		});

		emitAssistantUsage(gateway, targetSessionId, {
			input: 49_999, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 },
		});
		await ws.waitForFrom(cursor, (message) => message.data?.type === "cache_stall", 5_000);
		const stalled = gateway.sessionManager.getPersistedSession(targetSessionId)!;
		expect(stalled.cacheStallHistory?.warning).toMatchObject({
			inputTokens: 50_000,
			cacheReadTokens: 0,
		});
	} finally {
		ws.close();
		await deleteSession(targetSessionId).catch(() => {});
	}
});

test("cache-stall history survives capable model switches and replays its original evidence", async ({ gateway }) => {
	const targetSessionId = await createSession();
	let ws = await connectWs(targetSessionId);
	try {
		const model = (await (await import("../../src/server/agent/model-registry.js"))
			.getAvailableModels(gateway.sessionManager.preferencesStore))
			.find((candidate: any) => candidate.provider === "anthropic"
				&& candidate.api === "anthropic-messages"
				&& candidate.sessionSelectable !== false
				&& candidate.input?.includes("text"));
		expect(model).toBeTruthy();
		if (!model) throw new Error("integration fixture is missing a direct Anthropic Messages text model");

		gateway.sessionManager.persistSessionModel(targetSessionId, model.provider, model.id, "medium");
		gateway.sessionManager.persistCachePostureForResolvedModel(targetSessionId, model.provider, model.id, model);
		const cursor = ws.messageCount();
		emitAssistantUsage(gateway, targetSessionId, {
			input: 50_000, output: 1, cacheRead: 0, cacheWrite: 7, cost: { total: 0.5 },
		});
		await ws.waitForFrom(cursor, (message) => message.data?.type === "cache_stall", 5_000);
		const original = gateway.sessionManager.getPersistedSession(targetSessionId)!.cacheStallHistory;
		expect(original?.warning.cacheWriteTokens).toBe(7);
		expect(original?.posture.model).toBe(model.id);

		gateway.sessionManager.persistSessionModel(targetSessionId, "unproven", "other-model", "medium");
		gateway.sessionManager.persistCachePostureForResolvedModel(targetSessionId, "unproven", "other-model");
		expect(gateway.sessionManager.getPersistedSession(targetSessionId)?.cachePosture).toBeUndefined();
		gateway.sessionManager.persistSessionModel(targetSessionId, model.provider, model.id, "medium");
		gateway.sessionManager.persistCachePostureForResolvedModel(targetSessionId, model.provider, model.id, model);
		emitAssistantUsage(gateway, targetSessionId, {
			input: 50_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 },
		});
		await ws.waitForFrom(cursor, (message) => message.type === "cost_update", 5_000);
		expect(ws.messages.slice(cursor).filter((message) => message.data?.type === "cache_stall")).toHaveLength(1);

		ws.close();
		ws = await connectWs(targetSessionId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const replay = ws.messages.find((message) => message.data?.type === "cache_stall");
		expect(replay?.data?.posture.model).toBe(model.id);
		expect(replay?.data?.cumulative).toMatchObject({ inputTokens: 50_000, cacheWriteTokens: 7 });
	} finally {
		ws.close();
		await deleteSession(targetSessionId).catch(() => {});
	}
});

test("cost_update and REST map non-zero cacheRead usage into cacheHitRate", async ({ gateway }) => {
	const targetSessionId = await createSession();
	const ws = await connectWs(targetSessionId);
	try {
		const cursor = ws.messageCount();
		emitAssistantUsage(gateway, targetSessionId, {
			input: 50,
			output: 10,
			cacheRead: 150,
			cacheWrite: 25,
			totalTokens: 235,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.0037 },
		});

		const msg = await ws.waitForFrom(
			cursor,
			(m) => m.type === "cost_update" && m.sessionId === targetSessionId,
			5_000,
		);

		expect(msg.cost.inputTokens).toBe(50);
		expect(msg.cost.outputTokens).toBe(10);
		expect(msg.cost.cacheReadTokens).toBe(150);
		expect(msg.cost.cacheWriteTokens).toBe(25);
		expect(msg.cost.totalCost).toBeCloseTo(0.0037, 10);
		expect(msg.cost.cacheHitRate).toBeCloseTo(0.75, 10);

		const resp = await apiFetch(`/api/sessions/${targetSessionId}/cost`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.inputTokens).toBe(50);
		expect(body.cacheReadTokens).toBe(150);
		expect(body.cacheHitRate).toBeCloseTo(0.75, 10);
	} finally {
		ws.close();
		await deleteSession(targetSessionId).catch(() => {});
	}
});
