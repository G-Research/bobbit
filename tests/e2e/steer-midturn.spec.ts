/**
 * E2E tests for steer mid-turn delivery.
 *
 * BUG: When the user sends a message while the agent is streaming,
 * AgentInterface.sendMessage() always sends { type: "prompt" } which
 * gets queued. It should send { type: "steer" } so the message is
 * injected between tool calls immediately.
 *
 * The server-side steer handler (ws/handler.ts case "steer") works
 * correctly — it calls rpcClient.steer() when the agent is streaming.
 * The bug is purely in the UI dispatch path.
 *
 * These tests verify the server-side steer mechanism and demonstrate
 * the bug by showing that prompt-during-streaming gets queued.
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

	test("prompt sent while streaming gets queued instead of being delivered as steer", async () => {
		// This test demonstrates the BUG: the UI always sends { type: "prompt" }
		// even when the agent is streaming. The server correctly queues prompts
		// sent during streaming. After the fix, the UI will send { type: "steer" }
		// instead, which bypasses the queue entirely.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear messages
			conn.messages.length = 0;

			// Send a prompt while streaming — this is what the UI currently does.
			// BUG: This gets queued instead of being delivered as a steer.
			conn.send({ type: "prompt", text: "redirect the agent please" });

			// The message gets QUEUED (queue_update with 1 item).
			// After the fix, the UI sends { type: "steer" } instead, which
			// bypasses the queue and delivers immediately.
			const queueMsg = await conn.waitFor(
				(m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0,
				3000,
			);

			// BUG ASSERTION: The message should NOT be in the queue — it should
			// have been delivered immediately as a steer. This fails because the
			// current UI sends "prompt" which always queues during streaming.
			expect(
				queueMsg.queue.length,
				"Expected message to be delivered as steer (queue empty), but it was queued instead — " +
				"UI sends prompt instead of steer while streaming",
			).toBe(0);
		} finally {
			conn.close();
		}
	});
});
