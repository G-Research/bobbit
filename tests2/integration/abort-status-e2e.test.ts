/**
 * E2E tests for abort/steer lifecycle via the real WS protocol.
 *
 * PI-21b: Verify "aborting" status is broadcast during abort grace period.
 * PI-25: Verify steered/queued messages survive abort and are processed.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	statusPredicate,
	waitForSessionStatus,
	queueLenPredicate,
	toolStartPredicate,
	waitForCondition,
	type WsConnection,
	type WsMsg,
} from "./_e2e/e2e-setup.js";
import { advanceGatewayClockUntil } from "./helpers/local-mock-agent-clock.js";

// Longer than the test timeout: these turns should only end via abort, never
// because the worker was paused long enough for the mock sleep to finish.
const BUSY_TURN_MS = 60_000;

async function startAbortableBusyTurn(conn: WsConnection, label: string): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text: `STAY_BUSY:${BUSY_TURN_MS} ${label}` });
	await conn.waitForFrom(cursor, statusPredicate("streaming"));
	await conn.waitForFrom(cursor, toolStartPredicate("Bash"));
}

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

			// Wait for the mock's abortable tool body, not just the early
			// streaming status, so the abort window cannot close under load.
			await startAbortableBusyTurn(conn, "long running task");

			const abortCursor = conn.messageCount();
			conn.send({ type: "abort" });

			await conn.waitForFrom(abortCursor, statusPredicate("aborting"), 5_000);
			await conn.waitForFrom(abortCursor, statusPredicate("idle"), 10_000);

			// Collect abort-related session_status messages in order.
			const statuses = conn.messages
				.slice(abortCursor)
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

	test("PI-25: queued messages survive abort and drain", async ({ gateway }) => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy inside the abortable tool body.
			await startAbortableBusyTurn(conn, "working on first task");

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

			// Promote M1 and M2 to steered. Streaming promotion dispatches each
			// immediately through the live-steer path, leaving only M3 queued.
			conn.send({ type: "steer_queued", messageId: m1Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.length === 2 &&
					m.queue.every((q: any) => q.id !== m1Id),
			);
			conn.send({ type: "steer_queued", messageId: m2Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.length === 1 &&
					m.queue.every((q: any) => q.id !== m2Id),
			);

			const abortCursor = conn.messageCount();
			conn.send({ type: "abort" });

			// Production's positive-delay drain uses a real timer. The v2 gateway
			// clock is manual, so drive that lifecycle boundary until every durable
			// row has settled rather than waiting on wall time for a timer that cannot fire.
			await advanceGatewayClockUntil(
				gateway,
				() => {
					const live = gateway.sessionManager.getSession(sessionId);
					return live?.status === "idle" && live.promptQueue.isEmpty &&
						conn.messages.slice(abortCursor).some(
							(m: WsMsg) => m.type === "event" && m.data?.type === "agent_end",
						);
				},
				"the aborted session to settle with an empty durable queue",
				15_000,
			);

			const postAbortMessages = conn.messages.slice(abortCursor);

			// Verify the queue is truly empty
			const finalQueue = postAbortMessages
				.filter((m: WsMsg) => m.type === "queue_update")
				.pop();
			expect(finalQueue).toBeDefined();
			expect(finalQueue!.queue!.length).toBe(0);

			// Verify agent processed the queued messages by checking for agent_end
			// events (the mock agent emits these after completing each turn)
			const agentEnds = postAbortMessages.filter(
				(m: WsMsg) => m.type === "event" && m.data?.type === "agent_end",
			);
			expect(agentEnds.length).toBeGreaterThanOrEqual(1);
		} finally {
			conn.close();
		}
	});

	test("PI-25b: an unechoed direct live-steer survives abort and is delivered as next user turn", async ({ gateway }) => {
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

			await startAbortableBusyTurn(conn, "long running task");

			// Pin the actual recovery seam: accept the steer RPC but suppress its
			// user-role echo. An echoed steer is settled work and must not replay;
			// only this explicitly unechoed state is recovered after Stop.
			const live = gateway.sessionManager.getSession(sessionId);
			const mockAgent = live?.rpcClient?._agent;
			expect(mockAgent, "PI-25b requires the in-process mock bridge").toBeTruthy();
			mockAgent.env.MOCK_STEER_QUEUE_DROP = "always";

			// Snapshot cursor so we look only at events AFTER steer+abort.
			const cursor = conn.messageCount();

			// Live-steer via the { type: "steer" } WS message (NOT steer_queued).
			// This is the exact path that loses data on abort.
			conn.send({ type: "steer", text: "S_DIRECT" });
			conn.send({ type: "abort" });

			// Establish the abort terminal boundary before looking for delivery.
			// This fixture suppresses the original echo, so the subsequent user
			// event proves one recovered delivery after the cancelled turn.
			await conn.waitForFrom(
				cursor,
				(m) => m.type === "event" && m.data?.type === "agent_end",
				10_000,
			);
			const postAbortEnd = conn.messages.slice(cursor);
			const firstAgentEndIdx = postAbortEnd.findIndex(
				(m) => m.type === "event" && m.data?.type === "agent_end",
			);
			expect(firstAgentEndIdx, "PI-25b: expected an agent_end event from the abort before the redelivered user turn").toBeGreaterThanOrEqual(0);

			await conn.waitForFrom(
				cursor + firstAgentEndIdx + 1,
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
				8_000,
			).catch(() => { /* handled by the assertion below */ });

			// Find the redelivered user turn, then wait from that exact event
			// boundary for the turn it starts to finish.
			let post = conn.messages.slice(cursor);
			let userDirectIdx = post.findIndex(
				(m, index) =>
					index > firstAgentEndIdx &&
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
			);
			if (userDirectIdx >= 0) {
				await conn.waitForFrom(
					cursor + userDirectIdx + 1,
					(m) => m.type === "event" && m.data?.type === "agent_end",
					8_000,
				).catch(() => { /* handled by the assertion below */ });
				post = conn.messages.slice(cursor);
				userDirectIdx = post.findIndex(
					(m, index) =>
						index > firstAgentEndIdx &&
						m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user" &&
						m.data?.message?.content?.[0]?.text === "S_DIRECT",
				);
			}

			const recoveredSteers = post.filter(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
			);
			expect(recoveredSteers, "PI-25b must recover an unechoed steer exactly once").toHaveLength(1);

			// Specific, identifiable error message for the harness to key on.
			expect(
				userDirectIdx,
				"PI-25b: live-steer text 'S_DIRECT' was never delivered as a user turn after abort — deliverLiveSteer did not persist the steer and drainQueue had nothing to re-dispatch",
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

	test("PI-25c: live-steer + followup during aborting window preserves order", async ({ gateway }) => {
		// Acceptance criterion #2: if the user sends a follow-up prompt after
		// Stop but before the steer drains, both messages appear in chronological
		// order — the steered one first (it was in-flight when abort arrived) —
		// and the agent processes both.
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			await startAbortableBusyTurn(conn, "long running task");

			const cursor = conn.messageCount();

			// Live-steer, then abort, then follow-up while aborting.
			conn.send({ type: "steer", text: "S_DIRECT" });
			conn.send({ type: "abort" });
			// Follow-up during the aborting window. `enqueuePrompt` will see
			// status=="aborting" (not idle) and enqueue behind the steered row.
			conn.send({ type: "prompt", text: "FOLLOWUP" });

			// Wait for both user turns and their lifecycle to settle. The harness
			// clock is manual, so explicitly drive the positive agent_end drain delay.
			await advanceGatewayClockUntil(
				gateway,
				() => {
					const texts = conn.messages.slice(cursor)
						.filter((m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "user")
						.map((m) => m.data?.message?.content?.[0]?.text);
					const live = gateway.sessionManager.getSession(sessionId);
					return texts.includes("S_DIRECT") && texts.includes("FOLLOWUP") &&
						live?.status === "idle" && live.promptQueue.isEmpty;
				},
				"the recovered steer and follow-up to settle in FIFO order",
				15_000,
			);

			// Inspect the ordering: we expect, after `cursor`:
			//   agent_end (abort)
			//   -> user message_end "S_DIRECT"
			//   -> agent_end (steer turn)
			//   -> user message_end "FOLLOWUP"
			//   -> agent_end (followup turn)
			const post = conn.messages.slice(cursor);
			const directIdx = post.findIndex(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "S_DIRECT",
			);
			const followupIdx = post.findIndex(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					m.data?.message?.content?.[0]?.text === "FOLLOWUP",
			);

			expect(directIdx).toBeGreaterThanOrEqual(0);
			expect(followupIdx).toBeGreaterThanOrEqual(0);
			expect(
				directIdx,
				"PI-25c: S_DIRECT must be processed before FOLLOWUP (steered messages drain first)",
			).toBeLessThan(followupIdx);

			// At least one agent_end between the two user turns (the steer's turn).
			const agentEndsBetween = post
				.slice(directIdx + 1, followupIdx)
				.filter((m) => m.type === "event" && m.data?.type === "agent_end");
			expect(
				agentEndsBetween.length,
				"PI-25c: agent must complete a turn on S_DIRECT before FOLLOWUP is dispatched",
			).toBeGreaterThanOrEqual(1);

			// And an agent_end after FOLLOWUP so both turns complete.
			await conn.waitForFrom(
				cursor + followupIdx,
				(m) => m.type === "event" && m.data?.type === "agent_end",
				10_000,
			);
		} finally {
			conn.close();
		}
	});

	test("PI-25: steered messages reorder to front of queue before abort", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Make agent busy inside the abortable tool body.
			await startAbortableBusyTurn(conn, "initial task");

			// Queue messages: S1 (will be steered), N1 (normal), S2 (will be steered)
			conn.send({ type: "prompt", text: "S1" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "N1" });
			await conn.waitFor(queueLenPredicate(2));
			conn.send({ type: "prompt", text: "S2" });
			const q3 = await conn.waitFor(queueLenPredicate(3));

			// Promote S1 and S2 to steered. Streaming promotion dispatches
			// immediately, so only non-steered N1 should remain queued.
			const s1Id = q3.queue![0].id;
			const s2Id = q3.queue![2].id;
			conn.send({ type: "steer_queued", messageId: s1Id });
			await conn.waitFor(
				(m) => m.type === "queue_update" && m.queue?.length === 2 &&
					m.queue.every((q: any) => q.id !== s1Id),
			);
			conn.send({ type: "steer_queued", messageId: s2Id });

			const remaining = await conn.waitFor(
				(m) =>
					m.type === "queue_update" &&
					m.queue?.length === 1 &&
					m.queue[0].text === "N1" &&
					m.queue[0].isSteered === false,
			);
			expect(remaining.queue![0].text).toBe("N1");

			const abortCursor = conn.messageCount();
			conn.send({ type: "abort" });

			// Wait for queue to fully drain
			await conn.waitForFrom(abortCursor, queueLenPredicate(0), 15_000);

			// Queue fully drained — verify at least one agent_end happened
			// (messages were not lost, they were processed)
			const agentEnds = conn.messages
				.slice(abortCursor)
				.filter((m: WsMsg) => m.type === "event" && m.data?.type === "agent_end");
			expect(agentEnds.length).toBeGreaterThanOrEqual(1);
		} finally {
			conn.close();
		}
	});

	test("REST abort reports an unavailable durable-model recovery failure", async ({ gateway }) => {
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		const manager = gateway.sessionManager;
		const live = manager.getSession(sessionId);
		expect(live).toBeTruthy();
		if (live.pendingMetadataPersist) await live.pendingMetadataPersist;
		const persisted = manager.getPersistedSession(sessionId);
		expect(persisted?.projectId).toBeTruthy();

		const retiredTuple = {
			modelProvider: "retired-custom",
			modelId: "retired-force-abort-model",
			effectiveThinkingLevel: "high",
		};
		const durableStore = manager.getSessionStore(persisted.projectId);
		durableStore.update(sessionId, retiredTuple);

		const oldBridge = live.rpcClient;
		const originalStop = oldBridge.stop.bind(oldBridge);
		let stopCalls = 0;
		oldBridge.abort = () => new Promise<void>(() => {});
		oldBridge.stop = async () => {
			stopCalls += 1;
			await originalStop();
		};
		live.status = "streaming";

		const responsePending = apiFetch(`/api/sessions/${sessionId}/abort`, { method: "POST" });
		// Deadline-bounded, not turn-bounded: the abort route awaits real work before it
		// flips the status, so a fixed number of macrotask turns is not a reliable wait —
		// under CPU contention it expired, and the retries it triggered pushed this file
		// past the tier-1 wall budget.
		await waitForCondition(() => live.status === "aborting", {
			timeoutMs: 10_000,
			message: "session status to become aborting",
		}).catch(() => {});
		expect(live.status).toBe("aborting");
		gateway.clock.advance(3_000);

		const response = await responsePending;
		const body = await response.json();
		const exactModel = `${retiredTuple.modelProvider}/${retiredTuple.modelId}`;
		expect(response.status, JSON.stringify(body)).toBe(500);
		expect(body).toMatchObject({ ok: false, status: "terminated" });
		expect(body.error).toContain(exactModel);
		expect(body.error).toMatch(/not currently available for session selection/i);
		expect(manager.getSession(sessionId)?.status).toBe("terminated");
		expect(oldBridge.running).toBe(false);
		expect(stopCalls).toBe(1);
		expect(manager.getPersistedSession(sessionId)).toMatchObject(retiredTuple);
	});
});
