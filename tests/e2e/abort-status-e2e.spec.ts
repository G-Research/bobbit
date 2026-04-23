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

	test("PI-25b: live-steer (direct) survives abort and is delivered as next user turn", async () => {
		// Bug: `deliverLiveSteer()` in session-manager.ts calls rpcClient.steer()
		// WITHOUT writing to promptQueue. The SDK parks the steer until the next
		// tool boundary; forceAbort tears the turn down and the parked steer is
		// discarded. Because the server never recorded the text, drain-on-abort
		// has nothing to dispatch and the user's message is silently lost.
		//
		// Repro sequence:
		//   1. STAY_BUSY prompt → agent streaming
		//   2. {type:"steer", text:"S_DIRECT"} (live-steer path, NOT steer_queued)
		//   3. {type:"abort"}
		//   4. Wait for session_status idle (post-abort agent_end)
		//   5. Assert a USER message_end with text "S_DIRECT" appears AFTER the
		//      abort-induced agent_end — i.e. the steer survived and was drained
		//      as the next user turn.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:2000 long running task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Snapshot cursor so we look only at events AFTER steer+abort.
			const cursor = conn.messageCount();

			// Live-steer via the { type: "steer" } WS message (NOT steer_queued).
			// This is the exact path that loses data on abort.
			conn.send({ type: "steer", text: "S_DIRECT" });
			conn.send({ type: "abort" });

			// Wait for session to settle after abort. The abort-induced agent_end
			// drops us back to idle; with the fix, drainQueue then delivers the
			// steered text as a fresh user turn (which transitions us back to
			// streaming and then idle again).
			await conn.waitForFrom(cursor, statusPredicate("idle"), 10_000);

			// Give drain a brief window to dispatch the re-armed steer and for
			// the mock agent to emit the resulting user message_end.
			await conn.waitForFrom(
				cursor,
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
				8_000,
			).catch(() => { /* handled below */ });

			// Collect the event stream post-cursor and find the abort-induced
			// agent_end + any subsequent user message_end carrying "S_DIRECT".
			const post = conn.messages.slice(cursor);
			const firstAgentEndIdx = post.findIndex(
				(m) => m.type === "event" && m.data?.type === "agent_end",
			);
			const userDirectIdx = post.findIndex(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
			);

			// Specific, identifiable error message for the harness to key on.
			expect(
				userDirectIdx,
				"PI-25b: live-steer text 'S_DIRECT' was never delivered as a user turn after abort — deliverLiveSteer did not persist the steer and drainQueue had nothing to re-dispatch",
			).toBeGreaterThanOrEqual(0);

			expect(
				firstAgentEndIdx,
				"PI-25b: expected an agent_end event from the abort before the redelivered user turn",
			).toBeGreaterThanOrEqual(0);

			// The redelivered user message_end must come AFTER the abort's agent_end.
			expect(
				userDirectIdx,
				"PI-25b: the redelivered 'S_DIRECT' user message_end must arrive after the abort-induced agent_end",
			).toBeGreaterThan(firstAgentEndIdx);

			// And the mock agent must produce at least one further agent_end in
			// response to the redelivered turn (proving it wasn't just echoed).
			const laterAgentEnds = post
				.slice(userDirectIdx + 1)
				.filter((m) => m.type === "event" && m.data?.type === "agent_end");
			expect(
				laterAgentEnds.length,
				"PI-25b: expected the agent to run a new turn in response to the redelivered steer",
			).toBeGreaterThanOrEqual(1);
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
