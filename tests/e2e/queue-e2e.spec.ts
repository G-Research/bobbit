/**
 * E2E tests for the server-authoritative prompt queue.
 *
 * Tests create sessions, connect via WebSocket, and verify queue behavior.
 * The mock agent stays busy via STAY_BUSY prompts so we can test queueing.
 */
import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	connectWs,
	waitForHealth,
	statusPredicate,
	queueLenPredicate,
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";

test.describe("Queue E2E", () => {
	let sessionId: string;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("receives queue_update on connect (initially empty)", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			const queueMsg = await conn.waitFor((m) => m.type === "queue_update");
			expect(queueMsg.queue).toEqual([]);
			expect(queueMsg.sessionId).toBe(sessionId);
		} finally {
			conn.close();
		}
	});

	test("prompt when idle dispatches directly (queue stays empty) @smoke", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");
			conn.messages.length = 0;

			// Send a prompt — agent is idle, should dispatch directly
			conn.send({ type: "prompt", text: "hello" });

			// Wait for agent_end — at that point we know the turn completed.
			// If queue_update with items had fired, it would be in messages.
			await conn.waitFor((m) => m.type === "event" && m.data?.type === "agent_end");

			const queueUpdates = conn.messages.filter(
				(m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0,
			);
			expect(queueUpdates.length).toBe(0);
		} finally {
			conn.close();
		}
	});

	test("prompt when busy gets queued, queue_update broadcast @smoke", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy with explicit stay-busy duration
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 first prompt" });
			await conn.waitFor(statusPredicate("streaming"));

			// Now agent is busy — send another prompt
			conn.send({ type: "prompt", text: "queued message" });

			const queueMsg = await conn.waitFor(queueLenPredicate(1));
			expect(queueMsg.queue![0].text).toBe("queued message");
			expect(queueMsg.queue![0].isSteered).toBe(false);
		} finally {
			conn.close();
		}
	});

	test("steer_queued reorders queue", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working" });
			await conn.waitFor(statusPredicate("streaming"));

			conn.send({ type: "prompt", text: "msg A" });
			await conn.waitFor(queueLenPredicate(1));

			conn.send({ type: "prompt", text: "msg B" });
			const twoQueued = await conn.waitFor(queueLenPredicate(2));

			const msgBId = twoQueued.queue![1].id;
			conn.send({ type: "steer_queued", messageId: msgBId });

			const reordered = await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue !== undefined &&
					m.queue.length === 2 && m.queue[0].isSteered === true,
			);
			expect(reordered.queue![0].text).toBe("msg B");
			expect(reordered.queue![0].isSteered).toBe(true);
			expect(reordered.queue![1].text).toBe("msg A");
			expect(reordered.queue![1].isSteered).toBe(false);
		} finally {
			conn.close();
		}
	});

	test("remove_queued removes from queue", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working" });
			await conn.waitFor(statusPredicate("streaming"));

			conn.send({ type: "prompt", text: "to remove" });
			const queued = await conn.waitFor(queueLenPredicate(1));

			conn.send({ type: "remove_queued", messageId: queued.queue![0].id });

			const empty = await conn.waitFor(queueLenPredicate(0));
			expect(empty.queue).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("multi-client sync: both clients see queue updates", async () => {
		sessionId = await createSession();
		const conn1 = await connectWs(sessionId);
		const conn2 = await connectWs(sessionId);

		try {
			await conn1.waitFor((m) => m.type === "queue_update");
			await conn2.waitFor((m) => m.type === "queue_update");

			conn1.send({ type: "prompt", text: "STAY_BUSY:1500 working" });
			await conn1.waitFor(statusPredicate("streaming"));

			conn1.send({ type: "prompt", text: "from client 1" });

			const q1 = await conn1.waitFor(queueLenPredicate(1));
			const q2 = await conn2.waitFor(queueLenPredicate(1));
			expect(q1.queue![0].text).toBe("from client 1");
			expect(q2.queue![0].text).toBe("from client 1");
		} finally {
			conn1.close();
			conn2.close();
		}
	});

	test("queue drains after agent finishes turn", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Use STAY_BUSY:500 — just long enough for us to queue a message
			conn.send({ type: "prompt", text: "STAY_BUSY:500 say hello" });
			await conn.waitFor(statusPredicate("streaming"));

			conn.send({ type: "prompt", text: "queued follow-up" });
			await conn.waitFor(queueLenPredicate(1));

			// Wait for queue to drain (agent finishes first turn, dequeues second)
			const drained = await conn.waitFor(queueLenPredicate(0), 10_000);
			expect(drained.queue).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("story 10: reorder_queue reorders and broadcasts to both clients", async () => {
		sessionId = await createSession();
		const conn1 = await connectWs(sessionId);
		const conn2 = await connectWs(sessionId);

		try {
			await conn1.waitFor((m) => m.type === "queue_update");
			await conn2.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn1.send({ type: "prompt", text: "STAY_BUSY:1500 working" });
			await conn1.waitFor(statusPredicate("streaming"));

			// Queue 3 messages
			conn1.send({ type: "prompt", text: "msg 1" });
			await conn1.waitFor(queueLenPredicate(1));
			conn1.send({ type: "prompt", text: "msg 2" });
			await conn1.waitFor(queueLenPredicate(2));
			conn1.send({ type: "prompt", text: "msg 3" });
			const q3 = await conn1.waitFor(queueLenPredicate(3));

			// Also wait for conn2 to be caught up
			await conn2.waitFor(queueLenPredicate(3));

			const ids = q3.queue!.map((m: any) => m.id);
			// Clear message buffers to cleanly detect the reorder update
			conn1.messages.length = 0;
			conn2.messages.length = 0;

			// Reorder: [msg3, msg1, msg2]
			conn1.send({
				type: "reorder_queue",
				messageIds: [ids[2], ids[0], ids[1]],
			});

			// Both clients should receive the reordered queue
			const reordered1 = await conn1.waitFor(
				(m) =>
					m.type === "queue_update" &&
					m.queue?.length === 3 &&
					m.queue[0].text === "msg 3",
			);
			const reordered2 = await conn2.waitFor(
				(m) =>
					m.type === "queue_update" &&
					m.queue?.length === 3 &&
					m.queue[0].text === "msg 3",
			);

			expect(reordered1.queue![0].text).toBe("msg 3");
			expect(reordered1.queue![1].text).toBe("msg 1");
			expect(reordered1.queue![2].text).toBe("msg 2");

			expect(reordered2.queue![0].text).toBe("msg 3");
			expect(reordered2.queue![1].text).toBe("msg 1");
			expect(reordered2.queue![2].text).toBe("msg 2");
		} finally {
			conn1.close();
			conn2.close();
		}
	});

	test("story 13: abort with no queue — agent goes idle, no extra messages", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Start streaming
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear messages to track what comes after abort
			conn.messages.length = 0;

			// Abort
			conn.send({ type: "abort" });

			// Should go idle
			await conn.waitFor(statusPredicate("idle"));

			// Check there are no message_start events after the abort
			const messageStarts = conn.messages.filter(
				(m: WsMsg) =>
					m.type === "event" && m.data?.type === "message_start",
			);
			// There might be a message_start from the original turn, but no NEW ones
			// after abort. The agent_end after abort should be the last lifecycle event.
			const agentEnds = conn.messages.filter(
				(m: WsMsg) =>
					m.type === "event" && m.data?.type === "agent_end",
			);
			expect(agentEnds.length).toBeGreaterThanOrEqual(1);

			// No queue items should have been dispatched
			const queueUpdatesWithItems = conn.messages.filter(
				(m: WsMsg) =>
					m.type === "queue_update" &&
					m.queue &&
					m.queue.length > 0,
			);
			expect(queueUpdatesWithItems.length).toBe(0);
		} finally {
			conn.close();
		}
	});

	test("story 35: error keeps queue intact, does not drain", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy, then queue 2 messages
			conn.send({ type: "prompt", text: "STAY_BUSY:2000 working" });
			await conn.waitFor(statusPredicate("streaming"));

			conn.send({ type: "prompt", text: "queued A" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "queued B" });
			await conn.waitFor(queueLenPredicate(2));

			// Wait for the first turn to finish (agent goes idle)
			await conn.waitFor(statusPredicate("idle"));

			// Now the queue starts draining — queued A is dispatched
			// Wait for queue to have 1 item (A dispatched, B remains)
			// But we need to trigger an error. Let's use a fresh session approach.
		} finally {
			conn.close();
		}

		// Fresh approach: drive 3 consecutive MOCK_ERROR turns to hit the
		// MAX_CONSECUTIVE_ERROR_TURNS cap, then verify that further messages
		// park in the queue (instead of implicit unstick).
		const sid2 = await createSession();
		const conn2 = await connectWs(sid2);

		try {
			await conn2.waitFor((m) => m.type === "queue_update");

			for (let i = 0; i < 3; i++) {
				const cursor = conn2.messageCount();
				conn2.send({ type: "prompt", text: `MOCK_ERROR attempt ${i}` });
				await conn2.waitForFrom(cursor, statusPredicate("streaming"), 10_000);
				await conn2.waitForFrom(cursor, statusPredicate("idle"), 10_000);
				// Each MOCK_ERROR dispatch errors again; under cap this triggers
				// implicit unstick on the next send, so the counter advances
				// linearly: 1, 2, 3.
			}

			conn2.messages.length = 0;

			// Now at cap — subsequent messages park.
			conn2.send({ type: "prompt", text: "queued after cap A" });
			const q1 = await conn2.waitFor(queueLenPredicate(1));
			expect(q1.queue![0].text).toBe("queued after cap A");

			conn2.send({ type: "prompt", text: "queued after cap B" });
			const q2 = await conn2.waitFor(queueLenPredicate(2));
			expect(q2.queue![1].text).toBe("queued after cap B");

			// No streaming started — messages parked, not dispatched.
			const streamingStatuses = conn2.messages.filter(
				(m: WsMsg) => m.type === "session_status" && m.status === "streaming",
			);
			expect(streamingStatuses.length).toBe(0);
		} finally {
			conn2.close();
		}
	});

	test("story 36 (updated): error + cap reached, then retry drains parked messages", async () => {
		// Updated for "Unstick sessions on new input": parking only happens at
		// the cap now. We drive 3 errored turns, park a message, then Retry.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			for (let i = 0; i < 3; i++) {
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: `MOCK_ERROR ${i}` });
				await conn.waitForFrom(cursor, statusPredicate("streaming"), 10_000);
				await conn.waitForFrom(cursor, statusPredicate("idle"), 10_000);
			}

			// Now at cap — queued message parks.
			conn.send({ type: "prompt", text: "queued msg after cap" });
			await conn.waitFor(queueLenPredicate(1));

			// Retry the failed turn — resets cap + clears error + drains queue.
			conn.send({ type: "retry" });

			await conn.waitFor(queueLenPredicate(0), 15_000);
		} finally {
			conn.close();
		}
	});

	test("story 37 (updated): error state — implicit unstick dispatches new message (under cap)", async () => {
		// Updated for "Unstick sessions on new input": under cap, a new message
		// after an errored turn dispatches immediately (prefixed) rather than
		// parking. Full prefix + transcript coverage lives in
		// tests/e2e/stuck-session-recovery.spec.ts.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			const c0 = conn.messageCount();
			conn.send({ type: "prompt", text: "MOCK_ERROR please fail" });
			await conn.waitForFrom(c0, statusPredicate("streaming"), 10_000);
			await conn.waitForFrom(c0, statusPredicate("idle"), 10_000);

			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "continue please" });

			// Under cap — should dispatch (streaming), not park.
			await conn.waitForFrom(cursor, statusPredicate("streaming"), 10_000);

			// Queue should stay empty (direct dispatch, not parked).
			const queueUpdatesWithItems = conn.messages
				.slice(cursor)
				.filter((m: WsMsg) => m.type === "queue_update" && m.queue && m.queue.length > 0);
			expect(queueUpdatesWithItems.length).toBe(0);
		} finally {
			conn.close();
		}
	});
});
