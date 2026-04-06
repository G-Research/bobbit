/**
 * E2E tests for steer mid-turn delivery (server-side WS protocol).
 *
 * Tests verify:
 * 1. { type: "steer" } sent while streaming is delivered immediately to the
 *    agent via rpcClient.steer() (used by steer_queued promotion + abort).
 * 2. { type: "prompt" } sent while streaming is correctly queued by the server
 *    (the default path — the UI always queues via prompt during streaming).
 */
import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	deleteSession,
	connectWs,
	statusPredicate,
	queueLenPredicate,
	type WsMsg,
} from "./e2e-setup.js";

test.setTimeout(30_000);

test.describe("Steer mid-turn delivery", () => {
	let sessionId: string;
	test.afterEach(async () => {
		if (sessionId) {
			await deleteSession(sessionId);
			sessionId = "";
		}
	});

	test("steer sent while streaming is delivered immediately to the agent", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy with a long-running turn
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear messages to track only steer-related events
			conn.messages.length = 0;

			// Send a steer while agent is streaming — the server should
			// deliver this immediately via rpcClient.steer()
			conn.send({ type: "steer", text: "STEER_REDIRECT_123" });

			// The mock agent emits a message_end with [STEER_RECEIVED] when
			// it receives a steer. This should arrive BEFORE the agent_end
			// from the original turn.
			const steerAck = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_RECEIVED"),
				5000,
			);

			expect(steerAck.data.message.content[0].text).toContain("STEER_REDIRECT_123");

			// The steer should NOT have been queued — verify no queue_update
			// with items was emitted
			const queuedMsgs = conn.messages.filter(
				(m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0,
			);
			expect(queuedMsgs.length).toBe(0);
		} finally {
			conn.close();
		}
	});

	test("prompt sent while streaming is correctly queued by the server", async () => {
		// Verify the server correctly queues { type: "prompt" } during streaming.
		// The UI fix sends { type: "steer" } instead (tested above), but the
		// server's queue behavior for prompts should remain unchanged.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear messages
			conn.messages.length = 0;

			// Send a prompt while streaming — the server should queue it
			conn.send({ type: "prompt", text: "this should be queued" });

			// Verify the message is queued (queue_update with 1 item)
			const queueMsg = await conn.waitFor(
				(m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0,
				3000,
			);

			expect(queueMsg.queue.length).toBe(1);
			expect(queueMsg.queue[0].text).toContain("this should be queued");
		} finally {
			conn.close();
		}
	});
});
