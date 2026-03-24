/**
 * E2E tests for the server-authoritative prompt queue.
 *
 * Tests create sessions, connect via WebSocket, and verify queue behavior.
 * The mock agent stays busy via STAY_BUSY prompts so we can test queueing.
 */
import { test, expect } from "@playwright/test";
import {
	createSession,
	connectWs,
	waitForHealth,
	statusPredicate,
	queueLenPredicate,
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

	test("prompt when idle dispatches directly (queue stays empty)", async () => {
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

	test("prompt when busy gets queued, queue_update broadcast", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy with explicit stay-busy duration
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 first prompt" });
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

			conn.send({ type: "prompt", text: "STAY_BUSY:5000 working" });
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

			conn.send({ type: "prompt", text: "STAY_BUSY:5000 working" });
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

			conn1.send({ type: "prompt", text: "STAY_BUSY:5000 working" });
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
});
