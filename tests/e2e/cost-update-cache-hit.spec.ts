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
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	WsConnection,
} from "./e2e-setup.js";

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
