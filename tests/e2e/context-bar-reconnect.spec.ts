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
	createSession,
	connectWs,
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";

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

		// Brief pause to let model persist to disk
		await new Promise(r => setTimeout(r, 500));

		// 3. Disconnect
		ws1.close();
		await new Promise(r => setTimeout(r, 300));

		// 4. Reconnect with a new WebSocket
		const ws2 = await connectWs(sessionId);

		// 5. Also send an explicit get_state (like the client does on reconnect)
		ws2.send({ type: "get_state" });

		// 6. Collect messages for a few seconds
		await new Promise(r => setTimeout(r, 3000));

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
