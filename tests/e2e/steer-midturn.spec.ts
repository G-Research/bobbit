/**
 * E2E tests for steer mid-turn delivery (server-side WS protocol).
 *
 * Tests verify:
 * 1. { type: "steer" } sent while streaming is delivered immediately to the
 *    agent via rpcClient.steer() (used by steer_queued promotion + abort).
 * 2. { type: "prompt" } sent while streaming is correctly queued by the server
 *    (the default path — the UI always queues via prompt during streaming).
 * 3. PI-10: steer_queued (the real UI flow) delivers mid-turn at the next
 *    tool boundary — queue a prompt, promote via steer_queued, verify the
 *    agent receives it BEFORE the current turn ends.
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

	test("PI-10: steer_queued delivers mid-turn when agent is streaming", async () => {
		// This replicates the REAL UI flow:
		// 1. User sends a prompt → agent starts streaming
		// 2. User types another message → queued as non-steered (type: "prompt")
		// 3. User clicks Steer button on the pill → sends steer_queued
		// 4. The steered message should be delivered mid-turn at the next
		//    tool boundary via rpcClient.steer(), NOT wait for agent_end.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy with a long-running turn
			conn.send({ type: "prompt", text: "STAY_BUSY:10000 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue a message while agent is streaming (this is what the UI does)
			conn.send({ type: "prompt", text: "STEER_QUEUED_TEST_456" });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const msgId = queued.queue![0].id;

			// Clear messages to track only steer-related events
			conn.messages.length = 0;

			// Promote to steered via steer_queued (this is what the Steer button does)
			conn.send({ type: "steer_queued", messageId: msgId });

			// Wait for the queue_update confirming the message is steered
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.some((q: any) => q.isSteered),
			);

			// The steered message should be delivered to the agent mid-turn.
			// The mock agent emits [STEER_RECEIVED] when it gets a steer RPC.
			// This MUST arrive BEFORE the original STAY_BUSY turn completes.
			const steerAck = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_RECEIVED"),
				5000,
			);

			expect(steerAck.data.message.content[0].text).toContain("STEER_QUEUED_TEST_456");
		} finally {
			conn.close();
		}
	});

	test("PI-10b: batch steer_queued — two queued messages promoted to steer are delivered as a batch", async () => {
		// Replicates the PI-10b user story:
		// 1. Agent is streaming
		// 2. User queues two messages (type: "prompt")
		// 3. User clicks Steer on each pill (steer_queued)
		// 4. Both steers are dispatched immediately
		// 5. Agent receives both at the next tool boundary
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:10000 working on multi-step task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue two messages while streaming
			conn.send({ type: "prompt", text: "STEER_BATCH_MSG_1" });
			const q1 = await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "STEER_BATCH_MSG_2" });
			const q2 = await conn.waitFor(queueLenPredicate(2));

			const msg1Id = q1.queue![0].id;
			const msg2Id = q2.queue![1].id;

			// Clear messages to track only steer-related events
			conn.messages.length = 0;

			// Promote both to steered (this is what clicking Steer on each pill does)
			conn.send({ type: "steer_queued", messageId: msg1Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.some((q: any) => q.id === msg1Id && q.isSteered),
			);
			conn.send({ type: "steer_queued", messageId: msg2Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.some((q: any) => q.id === msg2Id && q.isSteered),
			);

			// Each steer_queued dispatches immediately. The mock agent emits
			// [STEER_RECEIVED] for each steer RPC. Wait for both to arrive
			// BEFORE the original STAY_BUSY turn completes.
			const steerAck1 = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_RECEIVED") &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_BATCH_MSG_1"),
				5000,
			);
			expect(steerAck1.data.message.content[0].text).toContain("STEER_BATCH_MSG_1");

			const steerAck2 = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_RECEIVED") &&
					m.data?.message?.content?.[0]?.text?.includes("STEER_BATCH_MSG_2"),
				5000,
			);
			expect(steerAck2.data.message.content[0].text).toContain("STEER_BATCH_MSG_2");
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
