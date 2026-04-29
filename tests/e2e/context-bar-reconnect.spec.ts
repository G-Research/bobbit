/**
 * Reproducing test: context bar shows wrong info after reconnect.
 *
 * After a WebSocket disconnect/reconnect (simulating server restart),
 * the server should send a `state` message with the correct model info
 * including contextWindow. Currently it does not — the proactive getState()
 * returns agent state without model metadata, and no fallback using
 * persisted session data is sent.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.describe("context bar after reconnect", () => {
	let sessionId: string;

	test.beforeEach(async () => {
		sessionId = await createSession();
	});

	test("reconnect sends state with correct contextWindow for persisted model", async () => {
		// 1. Connect and set model to claude-sonnet (1M context window)
		const ws1 = await connectWs(sessionId);
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-20250514" });

		// 2. Send a prompt so eventBuffer has content (ensures proactive getState fires on reconnect)
		ws1.send({ type: "prompt", text: "hello" });
		await ws1.waitFor(agentEndPredicate(), 10_000);

		// Wait for the model selection to be persisted to disk (visible via REST).
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-sonnet-4-20250514";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "model persisted" });

		// 3. Disconnect — wait for the underlying socket to actually close so the
		// server has fully torn down the prior subscription before we reconnect.
		const closed = new Promise<void>(r => ws1.ws.once("close", () => r()));
		ws1.close();
		await closed;

		// 4. Reconnect with a new WebSocket
		const ws2 = await connectWs(sessionId);

		// 5. Also send an explicit get_state (like the client does on reconnect)
		ws2.send({ type: "get_state" });

		// 6. Wait for a state message with the correct contextWindow. As soon
		// as we see one, the assertion passes — no need to pad 3s. If none
		// arrives within the timeout we fall through to the diagnostic
		// assertion below which reports what we DID see.
		await ws2.waitFor(
			(m: WsMsg) =>
				m.type === "state" &&
				(m.data as any)?.model?.contextWindow === 1_000_000,
			5_000,
		).catch(() => {});

		// 7. Find all state messages received after auth
		const stateMessages = ws2.messages.filter((m: WsMsg) => m.type === "state");

		// 8. Assert: at least one state message should have the correct contextWindow
		const hasCorrectContextWindow = stateMessages.some((m: WsMsg) => {
			const model = (m.data as any)?.model;
			return model && model.contextWindow === 1_000_000;
		});

		// Collect what we actually got for diagnostic output
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
});
