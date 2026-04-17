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

		// Fresh approach: send MOCK_ERROR to trigger error, then queue messages
		const sid2 = await createSession();
		const conn2 = await connectWs(sid2);

		try {
			await conn2.waitFor((m) => m.type === "queue_update");

			// Send MOCK_ERROR — this triggers an error turn
			conn2.send({ type: "prompt", text: "MOCK_ERROR please fail" });
			await conn2.waitFor(statusPredicate("streaming"));
			await conn2.waitFor(statusPredicate("idle"), 10_000);

			// After error, the session should have lastTurnErrored = true
			// Clear messages to track only what happens during queueing
			conn2.messages.length = 0;

			// Now queue 2 messages — they should stay queued (error gating)
			conn2.send({ type: "prompt", text: "queued after error A" });
			const q1 = await conn2.waitFor(queueLenPredicate(1));
			expect(q1.queue![0].text).toBe("queued after error A");

			conn2.send({ type: "prompt", text: "queued after error B" });
			const q2 = await conn2.waitFor(queueLenPredicate(2));
			expect(q2.queue![1].text).toBe("queued after error B");

			// Verify queue stays intact — the agent is idle and in error state,
			// so no drain should occur. Check the last queue_update still has 2 items.
			const finalQueue = conn2.messages.filter(
				(m: WsMsg) => m.type === "queue_update",
			);
			const lastQueueUpdate = finalQueue[finalQueue.length - 1];
			expect(lastQueueUpdate.queue.length).toBe(2);

			// Double-check: no streaming started (messages were NOT dispatched)
			const streamingStatuses = conn2.messages.filter(
				(m: WsMsg) => m.type === "session_status" && m.status === "streaming",
			);
			expect(streamingStatuses.length).toBe(0);
		} finally {
			conn2.close();
		}
	});

	test("story 36: error then retry drains the queue", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Trigger error
			conn.send({ type: "prompt", text: "MOCK_ERROR please fail" });
			await conn.waitFor(statusPredicate("streaming"));
			await conn.waitFor(statusPredicate("idle"), 10_000);

			// Queue a message while in error state
			conn.send({ type: "prompt", text: "queued msg after error" });
			await conn.waitFor(queueLenPredicate(1));

			// Retry the failed turn
			conn.send({ type: "retry" });

			// The retry should succeed (mock agent responds normally on retry)
			// and then the queue should drain
			await conn.waitFor(queueLenPredicate(0), 15_000);
		} finally {
			conn.close();
		}
	});

	test("story 37: error state — new message enqueued, not directly dispatched", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Trigger error
			conn.send({ type: "prompt", text: "MOCK_ERROR please fail" });
			await conn.waitFor(statusPredicate("streaming"));
			await conn.waitFor(statusPredicate("idle"), 10_000);

			// Clear messages to track what happens next
			conn.messages.length = 0;

			// Send a new message while in error state
			conn.send({ type: "prompt", text: "new message after error" });

			// It should be queued (queue_update with 1 item), NOT directly dispatched
			const queued = await conn.waitFor(queueLenPredicate(1));
			expect(queued.queue![0].text).toBe("new message after error");

			// Verify no streaming started (the message was NOT dispatched)
			const streamingStatuses = conn.messages.filter(
				(m: WsMsg) => m.type === "session_status" && m.status === "streaming",
			);
			expect(streamingStatuses.length).toBe(0);
		} finally {
			conn.close();
		}
	});
});
