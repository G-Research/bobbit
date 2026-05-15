/**
 * API E2E: cost_update WebSocket payload carries derived `cacheHitRate`.
 *
 * Drives the in-process gateway + mock agent through a normal prompt turn
 * so the server's `trackCostFromEvent` path emits a `cost_update`. We assert
 * the broadcast message includes a `cacheHitRate` field on `cost`, and that
 * its value matches the formula `cacheReadTokens / (cacheReadTokens + inputTokens)`
 * (returning `null` when the denominator is 0).
 *
 * See design: "Cache-Hit Metric".
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	WsConnection,
} from "./e2e-setup.js";

let sessionId: string;
let wsConn: WsConnection;

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
