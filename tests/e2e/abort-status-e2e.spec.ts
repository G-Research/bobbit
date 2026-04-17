/**
 * E2E tests for abort/steer lifecycle via the real WS protocol.
 *
 * PI-21b: Verify "aborting" status is broadcast during abort grace period.
 * PI-25: Verify steered/queued messages survive abort and are processed.
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

test.describe("Abort status E2E", () => {
	let sessionId: string;

	test.afterEach(async () => {
		if (sessionId) {
			await deleteSession(sessionId).catch(() => {});
			sessionId = "";
		}
	});

	test("PI-21b: aborting status is broadcast via WS before idle", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make the agent busy with a long-running turn so abort has time
			// to trigger the aborting → idle transition
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 long running task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Clear message buffer to track only abort-related status changes
			conn.messages.length = 0;

			// Send abort
			conn.send({ type: "abort" });

			// Wait for idle — the abort must complete
			await conn.waitFor(statusPredicate("idle"), 10_000);

			// Collect all session_status messages in order
			const statuses = conn.messages
				.filter((m: WsMsg) => m.type === "session_status")
				.map((m: WsMsg) => m.status);

			// The "aborting" status must appear before "idle"
			expect(statuses).toContain("aborting");

			const abortingIdx = statuses.indexOf("aborting");
			const idleIdx = statuses.lastIndexOf("idle");
			expect(abortingIdx).toBeLessThan(idleIdx);
		} finally {
			conn.close();
		}
	});

	test("PI-25: queued messages survive abort and drain", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 working on first task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue 3 messages while agent is busy
			conn.send({ type: "prompt", text: "M1" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "M2" });
			await conn.waitFor(queueLenPredicate(2));
			conn.send({ type: "prompt", text: "M3" });
			await conn.waitFor(queueLenPredicate(3));

			// Get current queue to find message IDs
			const q3 = conn.messages
				.filter((m: WsMsg) => m.type === "queue_update" && m.queue?.length === 3)
				.pop()!;
			const m1Id = q3.queue![0].id;
			const m2Id = q3.queue![1].id;

			// Promote M1 and M2 to steered
			conn.send({ type: "steer_queued", messageId: m1Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.some((q: any) => q.id === m1Id && q.isSteered),
			);
			conn.send({ type: "steer_queued", messageId: m2Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.some((q: any) => q.id === m2Id && q.isSteered),
			);

			// Clear messages BEFORE abort so we don't match the initial empty queue
			conn.messages.length = 0;

			// Abort the current turn
			conn.send({ type: "abort" });

			// After abort, the queue should drain — all messages processed.
			// Wait for queue to reach 0 (only matches new messages since we cleared).
			await conn.waitFor(queueLenPredicate(0), 15_000);

			// Verify the queue is truly empty
			const finalQueue = conn.messages
				.filter((m: WsMsg) => m.type === "queue_update")
				.pop();
			expect(finalQueue).toBeDefined();
			expect(finalQueue!.queue!.length).toBe(0);

			// Verify agent processed the queued messages by checking for agent_end
			// events (the mock agent emits these after completing each turn)
			const agentEnds = conn.messages.filter(
				(m: WsMsg) => m.type === "event" && m.data?.type === "agent_end",
			);
			expect(agentEnds.length).toBeGreaterThanOrEqual(1);
		} finally {
			conn.close();
		}
	});

	test("PI-25: steered messages reorder to front of queue before abort", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:1500 initial task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue messages: S1 (will be steered), N1 (normal), S2 (will be steered)
			conn.send({ type: "prompt", text: "S1" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "N1" });
			await conn.waitFor(queueLenPredicate(2));
			conn.send({ type: "prompt", text: "S2" });
			const q3 = await conn.waitFor(queueLenPredicate(3));

			// Promote S1 and S2 to steered
			const s1Id = q3.queue![0].id;
			const s2Id = q3.queue![2].id;
			conn.send({ type: "steer_queued", messageId: s1Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.[0]?.isSteered === true,
			);
			conn.send({ type: "steer_queued", messageId: s2Id });

			// After promoting S2, steered messages should be at the front of the queue
			// with non-steered N1 at the back. This verifies the reordering fix.
			const reordered = await conn.waitFor(
				(m) =>
					m.type === "queue_update" &&
					m.queue?.length === 3 &&
					m.queue[0].isSteered === true &&
					m.queue[1].isSteered === true &&
					m.queue[2].isSteered === false,
			);

			// Verify the reorder: S1 and S2 (steered) at front, N1 (normal) at back
			expect(reordered.queue![2].text).toBe("N1");
			const steeredTexts = reordered.queue!
				.filter((q: any) => q.isSteered)
				.map((q: any) => q.text);
			expect(steeredTexts).toContain("S1");
			expect(steeredTexts).toContain("S2");

			// Clear messages before abort
			conn.messages.length = 0;

			// Abort — queue should drain: steered first, then N1
			conn.send({ type: "abort" });

			// Wait for queue to fully drain
			await conn.waitFor(queueLenPredicate(0), 15_000);

			// Queue fully drained — verify at least one agent_end happened
			// (messages were not lost, they were processed)
			const agentEnds = conn.messages.filter(
				(m: WsMsg) => m.type === "event" && m.data?.type === "agent_end",
			);
			expect(agentEnds.length).toBeGreaterThanOrEqual(1);
		} finally {
			conn.close();
		}
	});
});
