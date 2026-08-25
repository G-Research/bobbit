/**
 * E2E tests for abort/steer lifecycle via the real WS protocol.
 *
 * PI-21b: Verify "aborting" status is broadcast during abort grace period.
 * PI-25: Verify steered/queued messages survive abort and are processed.
 */
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
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
} from "./_helpers/e2e/e2e-setup.js";
import {
	frameHasIntentIds,
	intentId,
	intentRows,
	latestIntentProjection,
	reliableMockCore,
	userMessageEnds,
} from "./_helpers/reliable-turn-barriers.js";

// Longer than the test timeout: these turns should only end via abort, never
// because the worker was paused long enough for the mock sleep to finish.
const BUSY_TURN_MS = 60_000;

async function startAbortableBusyTurn(conn: WsConnection, label: string): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text: `STAY_BUSY:${BUSY_TURN_MS} ${label}` });
	await conn.waitForFrom(cursor, statusPredicate("streaming"));
	await conn.waitForFrom(cursor, toolStartPredicate("Bash"));
}

function deliveryIntentId(frame: WsMsg): string | undefined {
	return frame.data?.deliveryIntentId
		?? frame.data?.message?.deliveryIntentId
		?? frame.data?.message?.intentId;
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

	test("PI-25: queued messages survive abort and drain", async () => {
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

			// After abort, the queue should drain — all messages processed.
			await conn.waitForFrom(abortCursor, queueLenPredicate(0), 15_000);

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

	test("PI-25c: graceful Stop preserves followup without redriving an acknowledged steer", async ({ gateway }) => {
		const directId = "pi25c-steer-0001";
		const followupId = "pi25c-followup-0002";
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const followupConn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");
			await followupConn.waitFor((m) => m.type === "queue_update");
			core.armBarrier("tool:before-end");
			conn.send({ type: "prompt", text: "RELIABLE_TOOL_HOLD" });
			await core.waitForBarrier("tool:before-end");

			// Accept the steer into Bobbit's ledger but deterministically suppress
			// Pi's original echo. Hold both RPC acknowledgement and abort terminal
			// proof so the one-carrier aborting window is directly observable.
			core.env.MOCK_STEER_QUEUE_DROP = "always";
			core.armBarrier("steer:1:before-ack");
			core.armBarrier("abort:1:before-agent-end");
			core.armBarrier("prompt:2:received");
			const cursor = conn.messageCount();
			conn.send({ type: "steer", text: "S_DIRECT", intentId: directId });
			await core.waitForBarrier("steer:1:before-ack");
			// Admit the follow-up from a second client while the first socket is held
			// at steer acknowledgement, then Stop with both occurrences durable.
			followupConn.send({ type: "prompt", text: "FOLLOWUP", intentId: followupId });
			const acceptedProjection = await conn.waitForFrom(cursor, (frame) =>
				frameHasIntentIds(frame, [directId, followupId]),
			).catch((error) => {
				const projections = conn.messages.slice(cursor)
					.filter((frame) => frame.type === "queue_update" || frame.type === "intent_update")
					.map((frame) => intentRows(frame).map((row) => ({ id: intentId(row), state: row.deliveryState })));
				throw new Error(`PI-25c accepted projection missing: ${JSON.stringify({ commands: core.commandJournal, projections })}`, { cause: error });
			});
			expect(intentRows(acceptedProjection).map(intentId)).toEqual([directId, followupId]);

			conn.send({ type: "abort" });
			await core.waitForBarrier("abort:1:before-agent-end");
			const abortingProjection = latestIntentProjection(conn.messages);
			if (!abortingProjection || !frameHasIntentIds(abortingProjection, [directId, followupId])) {
				const projections = conn.messages.slice(cursor)
					.filter((frame) => frame.type === "queue_update" || frame.type === "intent_update")
					.map((frame) => intentRows(frame).map((row) => ({ id: intentId(row), state: row.deliveryState })));
				throw new Error(`PI-25c aborting projection missing: ${JSON.stringify({ commands: core.commandJournal, projections })}`);
			}
			expect(intentRows(abortingProjection).map(intentId)).toEqual([directId, followupId]);
			for (const id of [directId, followupId]) {
				const pending = intentRows(abortingProjection).filter((row) => intentId(row) === id);
				const surfaced = conn.messages.slice(cursor).filter((frame) =>
					frame.type === "event"
					&& frame.data?.type === "message_end"
					&& deliveryIntentId(frame) === id,
				);
				expect(pending.length + surfaced.length, `PI-25c: ${id} has exactly one visible carrier while abort proof is held`).toBe(1);
			}

			core.releaseBarrier("steer:1:before-ack");
			core.releaseBarrier("tool:before-end");
			await core.waitForBarrier("tool:after-end");
			core.releaseBarrier("abort:1:before-agent-end");
			const followupReceipt = await core.waitForBarrier("prompt:2:received");
			const recoveredProjection = await conn.waitForFrom(cursor, (frame) => {
				const rows = intentRows(frame);
				return rows.map(intentId).join(",") === [directId, followupId].join(",")
					&& rows.find((row) => intentId(row) === directId)?.deliveryState === "uncertain";
			});
			const recoveredRows = intentRows(recoveredProjection);
			expect(recoveredRows.map(intentId)).toEqual([directId, followupId]);
			const followupRow = recoveredRows.find((row) => intentId(row) === followupId);
			expect({
				kind: followupReceipt.kind,
				occurrence: followupReceipt.occurrence,
				text: followupReceipt.text,
				intentId: intentId(followupRow),
			}).toEqual({
				kind: "prompt",
				occurrence: 2,
				text: "FOLLOWUP",
				intentId: followupId,
			});
			expect(recoveredRows.find((row) => intentId(row) === directId)).toMatchObject({
				deliveryState: "uncertain",
				retryable: false,
			});

			core.releaseBarrier("prompt:2:received");
			await conn.waitForFrom(cursor, (frame) =>
				userMessageEnds([frame], "FOLLOWUP")
					.some((messageEnd) => deliveryIntentId(messageEnd) === followupId),
			);

			const followupEnds = userMessageEnds(conn.messages.slice(cursor), "FOLLOWUP")
				.filter((frame) => deliveryIntentId(frame) === followupId);
			expect(followupEnds, "PI-25c: the queued follow-up surfaces exactly once after Stop").toHaveLength(1);
			expect(userMessageEnds(conn.messages.slice(cursor), "S_DIRECT"),
				"PI-25c: the acknowledged/no-echo steer must remain uncertain and never replay").toHaveLength(0);

			const finalOutbox = [...conn.messages].reverse().find((frame) => frame.type === "queue_update");
			expect(intentRows(finalOutbox).map(intentId)).toEqual([directId]);
			expect(intentRows(finalOutbox)[0]).toMatchObject({
				deliveryState: "uncertain",
				retryable: false,
			});
			expect(core.commandJournal.filter((entry) => entry.kind === "steer").map((entry) => entry.text))
				.toEqual(["S_DIRECT"]);
			expect(core.commandJournal.filter((entry) => entry.kind === "prompt").map((entry) => entry.text))
				.toEqual(["RELIABLE_TOOL_HOLD", "FOLLOWUP"]);
		} finally {
			core.releaseAllBarriers();
			followupConn.close();
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
		let processExitSignals = 0;
		oldBridge.onEvent((event: { type?: string }) => {
			if (event.type === "process_exit") processExitSignals += 1;
		});
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
		expect(processExitSignals).toBe(1);
		expect(manager.getPersistedSession(sessionId)).toMatchObject(retiredTuple);

		// The failed replacement leaves an intentionally terminated capsule. Its
		// already-observed process exit must cancel metadata retry authority so real
		// DELETE cleanup can join the admitted store lane rather than wait for another
		// clock advance. Cleanup remains idempotent at the stopped bridge boundary.
		const deleteResponse = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		const deleteBody = await deleteResponse.json();
		expect(deleteResponse.status, JSON.stringify(deleteBody)).toBe(200);
		expect(deleteBody).toMatchObject({ ok: true });
		expect(stopCalls).toBe(2);
		expect(processExitSignals).toBe(1);
		expect(live.pendingMetadataPersist).toBeUndefined();
		expect(manager.getSession(sessionId)).toBeUndefined();
		expect(manager.getArchivedSession(sessionId)).toMatchObject({
			...retiredTuple,
			archived: true,
		});
		sessionId = "";
	});
});
