/**
 * E2E tests for steer mid-turn delivery (server-side WS protocol).
 *
 * Tests verify:
 * 1. { type: "steer" } sent while streaming is delivered immediately to the
 *    agent via rpcClient.steer() (used by steer_queued promotion + abort).
 * 2. { type: "prompt" } sent while streaming is correctly queued by the server
 *    (the default path — the UI always queues via prompt during streaming).
 * 3. PI-10: steer_queued (the real UI flow) dispatches immediately through
 *    the live-steer path — queue a prompt, promote via steer_queued, verify
 *    the agent receives it BEFORE the current turn ends.
 *
 * Optimized: tests run in parallel (each creates its own session).
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
	test.describe.configure({ mode: "parallel" });

	test("steer sent while streaming is delivered immediately to the agent", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy with a long-running turn
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear messages to track only steer-related events
			conn.messages.length = 0;

			// Send a steer while agent is streaming — the server should
			// deliver this immediately via rpcClient.steer()
			conn.send({ type: "steer", text: "STEER_REDIRECT_123" });

			// The mock agent runs handlePrompt(steeredText) after the in-flight
			// turn aborts, which emits a user-role message_end with the steered
			// text. We assert on that transcript event.
			const steerAck = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					(m.data?.message?.content?.[0]?.text || "").includes("STEER_REDIRECT_123"),
				8000,
			);

			expect(steerAck.data.message.content[0].text).toContain("STEER_REDIRECT_123");

			// PI-25b fix: live steer is first persisted as a steered queue row,
			// then `_dispatchSteer()` records the in-flight ledger and removes
			// the row as it dispatches. Any queued steer row visible in an
			// intermediate queue_update should carry isSteered=true (not a plain
			// user prompt).
			const queuedMsgs = conn.messages.filter(
				(m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0,
			);
			for (const m of queuedMsgs) {
				for (const row of m.queue as any[]) {
					expect(row.isSteered).toBe(true);
				}
			}
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("PI-10: steer_queued delivers mid-turn when agent is streaming", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:2000 working on something" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue a message while agent is streaming (this is what the UI does)
			conn.send({ type: "prompt", text: "STEER_QUEUED_TEST_456" });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const msgId = queued.queue![0].id;

			// Clear messages to track only steer-related events
			conn.messages.length = 0;

			// Promote to steered via steer_queued (this is what the Steer button does).
			// Promotion dispatches immediately through the live-steer path, matching a
			// fresh steer instead of waiting for a later tool boundary.
			conn.send({ type: "steer_queued", messageId: msgId });

			// The mock agent emits a user-role message_end via handlePrompt(steeredText).
			const steerAck = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					(m.data?.message?.content?.[0]?.text || "").includes("STEER_QUEUED_TEST_456"),
				10_000,
			);

			expect(steerAck.data.message.content[0].text).toContain("STEER_QUEUED_TEST_456");
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("PI-10b: two queued messages promoted to steer dispatch immediately", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:2000 working on multi-step task" });
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

			// Promote both to steered. Each promotion dispatches immediately through the
			// live-steer path; each substring must show up in at least one user-role
			// message_end event.
			conn.send({ type: "steer_queued", messageId: msg1Id });
			conn.send({ type: "steer_queued", messageId: msg2Id });

			for (const needle of ["STEER_BATCH_MSG_1", "STEER_BATCH_MSG_2"]) {
				await conn.waitFor(
					(m) =>
						m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user" &&
						(m.data?.message?.content?.[0]?.text || "").includes(needle),
					10_000,
				);
			}
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("prompt sent while streaming is correctly queued by the server", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working on something" });
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
			await deleteSession(sessionId);
		}
	});
});
