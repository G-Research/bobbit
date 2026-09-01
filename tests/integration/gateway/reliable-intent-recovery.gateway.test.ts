import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import {
	connectWs,
	createSession,
	deleteSession,
	statusPredicate,
	type WsConnection,
	type WsMsg,
} from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import { restoreWithLocalMockAgentClock } from "../../../tests/support/helpers/integration/gateway/local-mock-agent-clock.js";
import {
	frameHasIntentIds,
	intentId,
	intentRows,
	latestIntentProjection,
	reliableMockCore,
	userMessageEnds,
} from "../../../tests/support/helpers/integration/gateway/reliable-turn-barriers.js";

const SAME_TEXT = "RELIABLE_IDENTICAL_STEER";
const MANUAL_PROMPT_ID = "intent-manual-prompt-0001";
const MANUAL_STEER_ID = "intent-manual-steer-0002";
const STEER_A_ID = "intent-steer-identical-0001";
const STEER_B_ID = "intent-steer-identical-0002";

function commandTexts(core: ReturnType<typeof reliableMockCore>): string[] {
	return core.commandJournal
		.filter((entry) => entry.kind === "prompt" || entry.kind === "steer")
		.map((entry) => String(entry.text));
}

function deliveryIntentId(frame: WsMsg): string | undefined {
	return frame.data?.deliveryIntentId
		?? frame.data?.message?.deliveryIntentId
		?? frame.data?.message?.intentId;
}

async function closeConnection(conn: WsConnection): Promise<void> {
	if (conn.ws.readyState >= 2) return;
	const closed = new Promise<void>((resolve) => conn.ws.once("close", () => resolve()));
	conn.close();
	await closed;
}

test.setTimeout(30_000);

test.describe("Reliable intent recovery protocol", () => {
	test("holds next-turn intent after agent_end until Pi emits agent_settled", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		const intent = "intent-post-agent-end-settled-0001";
		const text = "DELIVER_ONLY_AFTER_AGENT_SETTLED";
		try {
			core.armBarrier("turn:before-agent-end");
			core.armBarrier("turn:after-agent-end");
			core.armBarrier("prompt:2:received");
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "FIRST_TURN_BEFORE_SETTLEMENT" });
			await core.waitForBarrier("turn:before-agent-end");

			conn.send({ type: "prompt", text, intentId: intent });
			const queued = await conn.waitForFrom(cursor, (frame) => frameHasIntentIds(frame, [intent]));
			expect(intentRows(queued)).toEqual([
				expect.objectContaining({ id: intent, deliveryState: "queued", targetTurn: "next-turn" }),
			]);
			expect(commandTexts(core).filter((command) => command === text)).toHaveLength(0);
			expect((gateway.sessionManager.getSession(sessionId) as any)?._piAgentRunSettled,
				"agent_start must install the Pi settlement fence").toBe(false);

			core.releaseBarrier("turn:before-agent-end");
			await core.waitForBarrier("turn:after-agent-end");
			expect(commandTexts(core).filter((command) => command === text),
				"agent_end must not call prompt while Pi still owns finishRun").toHaveLength(0);

			core.releaseBarrier("turn:after-agent-end");
			await core.waitForBarrier("prompt:2:received");
			expect(commandTexts(core).filter((command) => command === text)).toHaveLength(1);
			core.releaseBarrier("prompt:2:received");
			await conn.waitForFrom(cursor, (frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === intent);
			await conn.waitForFrom(cursor, statusPredicate("idle"));
			expect(userMessageEnds(conn.messages.slice(cursor), text).map(deliveryIntentId)).toEqual([intent]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	test("mock runtime exposes threshold failure and overflow retry barriers without sleeps", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		try {
			core.configureReliableScenario({
				compaction: { threshold: { outcome: "failure", error: "fixture threshold failure" } },
			});
			core.armBarrier("threshold:compaction-start");
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "RELIABLE_COMPACTION:threshold" });
			await core.waitForBarrier("threshold:compaction-start");
			await conn.waitForFrom(cursor, (frame) =>
				frame.type === "event"
				&& (frame.data?.type === "auto_compaction_start" || frame.data?.type === "compaction_start")
				&& frame.data?.reason === "threshold",
			);

			core.releaseBarrier("threshold:compaction-start");
			await core.waitForBarrier("threshold:compaction-failed");
			const failure = await conn.waitForFrom(cursor, (frame) =>
				frame.type === "event"
				&& (frame.data?.type === "auto_compaction_end" || frame.data?.type === "compaction_end")
				&& frame.data?.reason === "threshold",
			);
			expect(failure.data).toMatchObject({
				aborted: false,
				error: "fixture threshold failure",
				willRetry: false,
			});
			await conn.waitForFrom(cursor, statusPredicate("idle"));

			core.configureReliableScenario({ compaction: { overflow: { outcome: "success", willRetry: true } } });
			core.armBarrier("overflow:compaction-start");
			core.armBarrier("overflow:before-retry");
			const overflowCursor = conn.messageCount();
			conn.send({ type: "prompt", text: "RELIABLE_COMPACTION:overflow" });
			await core.waitForBarrier("overflow:length-tail");
			await core.waitForBarrier("overflow:compaction-start");
			core.releaseBarrier("overflow:compaction-start");
			await core.waitForBarrier("overflow:compaction-end");
			const overflowEnd = await conn.waitForFrom(overflowCursor, (frame) =>
				frame.type === "event"
				&& (frame.data?.type === "auto_compaction_end" || frame.data?.type === "compaction_end")
				&& frame.data?.reason === "overflow",
			);
			expect(overflowEnd.data?.willRetry).toBe(true);
			await core.waitForBarrier("overflow:before-retry");
			core.releaseBarrier("overflow:before-retry");
			await conn.waitForFrom(overflowCursor, statusPredicate("idle"));
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	for (const reason of ["threshold", "overflow"] as const) {
		test(`${reason} compaction failure retains a continuation until the final safe boundary`, async ({ gateway }) => {
			const sessionId = await createSession();
			const conn = await connectWs(sessionId);
			const core = reliableMockCore(gateway, sessionId);
			const continuationId = `intent-failed-${reason}-continuation`;
			const continuationText = `FAILED_${reason.toUpperCase()}_CONTINUATION`;
			try {
				core.configureReliableScenario({
					compaction: { [reason]: { outcome: "failure", error: `fixture ${reason} failure` } },
				});
				core.armBarrier(`${reason}:compaction-start`);
				core.armBarrier(`${reason}:compaction-failed`);
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: `RELIABLE_COMPACTION:${reason}` });
				if (reason === "overflow") await core.waitForBarrier("overflow:length-tail");
				await core.waitForBarrier(`${reason}:compaction-start`);

				conn.send({ type: "steer", text: continuationText, intentId: continuationId });
				const queued = await conn.waitForFrom(cursor, (frame) => frameHasIntentIds(frame, [continuationId]));
				expect(intentRows(queued)).toEqual([
					expect.objectContaining({
						id: continuationId,
						deliveryState: "queued",
						targetTurn: "continuation",
					}),
				]);
				expect(core.commandJournal.filter((entry) => entry.text === continuationText)).toHaveLength(0);

				core.releaseBarrier(`${reason}:compaction-start`);
				await core.waitForBarrier(`${reason}:compaction-failed`);
				const failedEnd = await conn.waitForFrom(cursor, (frame) =>
					frame.type === "event"
						&& (frame.data?.type === "auto_compaction_end" || frame.data?.type === "compaction_end")
						&& frame.data?.reason === reason,
				);
				expect(failedEnd.data).toMatchObject({
					aborted: false,
					error: `fixture ${reason} failure`,
					willRetry: false,
				});
				expect(core.commandJournal.filter((entry) => entry.text === continuationText),
					"failed compaction_end must not dispatch into the interrupted turn").toHaveLength(0);
				expect(intentRows(latestIntentProjection(conn.messages))).toEqual([
					expect.objectContaining({ id: continuationId, deliveryState: "queued", targetTurn: "continuation" }),
				]);

				core.releaseBarrier(`${reason}:compaction-failed`);
				await conn.waitFor((frame) => frame.type === "event"
					&& frame.data?.type === "message_end"
					&& deliveryIntentId(frame) === continuationId);
				expect(core.commandJournal.filter((entry) => entry.text === continuationText)).toHaveLength(1);
				expect(userMessageEnds(conn.messages, continuationText).map(deliveryIntentId)).toEqual([continuationId]);
				expect(intentRows(latestIntentProjection(conn.messages))).toEqual([]);
			} finally {
				core.releaseAllBarriers();
				await closeConnection(conn);
				await deleteSession(sessionId);
			}
		});
	}

	test("manual compaction accepts prompt and steer into one durable ID-keyed outbox before any Pi RPC", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		try {
			await conn.waitFor((frame) => frame.type === "queue_update");
			core.armBarrier("manual:compaction-start");
			conn.send({ type: "compact" });
			await core.waitForBarrier("manual:compaction-start");

			const admissionCursor = conn.messageCount();
			conn.send({ type: "prompt", text: SAME_TEXT, intentId: MANUAL_PROMPT_ID });
			conn.send({ type: "steer", text: SAME_TEXT, intentId: MANUAL_STEER_ID });

			const firstBoundary = await Promise.race([
				conn.waitForFrom(admissionCursor, (frame) =>
					frameHasIntentIds(frame, [MANUAL_PROMPT_ID, MANUAL_STEER_ID]),
				).then((frame) => ({ kind: "outbox" as const, frame })),
				core.waitForBarrier("prompt:1:received").then(() => ({ kind: "rpc" as const })),
				core.waitForBarrier("steer:1:received").then(() => ({ kind: "rpc" as const })),
			]);
			expect(
				firstBoundary.kind,
				"RELIABLE_INTENT_COMPACTION_FENCE: accepted input reached Pi before its durable outbox projection while manual compaction was active",
			).toBe("outbox");

			const projected = firstBoundary.kind === "outbox" ? intentRows(firstBoundary.frame) : [];
			expect(projected.map(intentId)).toEqual([MANUAL_PROMPT_ID, MANUAL_STEER_ID]);
			expect(new Set(projected.map(intentId)).size).toBe(2);
			expect(projected.map((row) => row.deliveryState)).toEqual(["queued", "queued"]);
			expect(commandTexts(core)).toEqual([]);

			core.releaseBarrier("manual:compaction-start");
			await conn.waitFor((frame) => frame.type === "event" && frame.data?.type === "compaction_end");
			const promptEcho = await conn.waitFor((frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === MANUAL_PROMPT_ID);
			const promptEchoIndex = conn.messages.indexOf(promptEcho);
			const steerEcho = await conn.waitForFrom(promptEchoIndex + 1, (frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === MANUAL_STEER_ID);
			expect(conn.messages.indexOf(promptEcho)).toBeLessThan(conn.messages.indexOf(steerEcho));

			expect(commandTexts(core).filter((text) => text === SAME_TEXT)).toHaveLength(2);
			expect(userMessageEnds(conn.messages, SAME_TEXT).map(deliveryIntentId).sort()).toEqual(
				[MANUAL_PROMPT_ID, MANUAL_STEER_ID].sort(),
			);
			const finalProjection = latestIntentProjection(conn.messages);
			expect(intentRows(finalProjection)).toEqual([]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	test("two identical live steers remain visible through delayed acknowledgement, reconnect, and user start", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		try {
			core.armBarrier("tool:before-end");
			conn.send({ type: "prompt", text: "RELIABLE_TOOL_HOLD" });
			await core.waitForBarrier("tool:before-end");

			for (const occurrence of [1, 2]) {
				core.armBarrier(`steer:${occurrence}:before-ack`);
				core.armBarrier(`steer:${occurrence}:before-user-start`);
			}
			const steerCursor = conn.messageCount();
			conn.send({ type: "steer", text: SAME_TEXT, intentId: STEER_A_ID });
			conn.send({ type: "steer", text: SAME_TEXT, intentId: STEER_B_ID });
			await core.waitForBarrier("steer:1:before-ack");

			const projectionAtAck = await conn.waitForFrom(steerCursor, (frame) =>
				frameHasIntentIds(frame, [STEER_A_ID, STEER_B_ID]),
			);
			expect(intentRows(projectionAtAck).map(intentId),
				"RELIABLE_IDENTICAL_ACK_CONTINUITY: both accepted occurrences must remain ordered in the outbox until correlated Pi user starts",
			).toEqual([STEER_A_ID, STEER_B_ID]);
			expect(userMessageEnds(conn.messages.slice(steerCursor), SAME_TEXT)).toHaveLength(0);

			core.releaseBarrier("steer:1:before-ack");
			await core.waitForBarrier("steer:2:before-ack");
			core.releaseBarrier("steer:2:before-ack");

			await closeConnection(conn);
			conn = await connectWs(sessionId);
			const snapshotCursor = conn.messageCount();
			const reconnectProjection = conn.waitForFrom(0, (frame) =>
				frameHasIntentIds(frame, [STEER_A_ID, STEER_B_ID]),
			);
			conn.send({ type: "get_messages" });
			await conn.waitForFrom(snapshotCursor, (frame) => frame.type === "messages");
			expect(intentRows(await reconnectProjection).map(intentId),
				"reconnect must project both dispatching occurrences before either Pi user start",
			).toEqual([STEER_A_ID, STEER_B_ID]);

			core.releaseBarrier("tool:before-end");
			await core.waitForBarrier("steer:1:before-user-start");
			core.releaseBarrier("steer:1:before-user-start");
			await core.waitForBarrier("steer:2:before-user-start");
			core.releaseBarrier("steer:2:before-user-start");

			await conn.waitFor((frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === STEER_B_ID);
			const ends = userMessageEnds(conn.messages, SAME_TEXT);
			expect(ends.map(deliveryIntentId)).toEqual([STEER_A_ID, STEER_B_ID]);
			expect(core.commandJournal.filter((entry) => entry.kind === "steer" && entry.text === SAME_TEXT)).toHaveLength(2);
			expect(intentRows(latestIntentProjection(conn.messages))).toEqual([]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	test("graceful Stop does not redrive an acknowledged steer whose original user start arrives late", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		const lateIntentId = "intent-graceful-stop-late-0001";
		const lateText = "GRACEFUL_STOP_LATE_ORIGINAL_ECHO";
		try {
			core.armBarrier("tool:before-end");
			conn.send({ type: "prompt", text: "RELIABLE_TOOL_HOLD" });
			await core.waitForBarrier("tool:before-end");

			core.armBarrier("steer:1:before-ack");
			core.armBarrier("steer:1:before-user-start");
			conn.send({ type: "steer", text: lateText, intentId: lateIntentId });
			await core.waitForBarrier("steer:1:before-ack");
			core.releaseBarrier("steer:1:before-ack");

			const stopCursor = conn.messageCount();
			conn.send({ type: "abort" });
			await conn.waitForFrom(stopCursor, (frame) => frame.type === "event"
				&& frame.data?.type === "agent_end");
			await conn.waitForFrom(stopCursor, statusPredicate("idle"));

			core.releaseBarrier("tool:before-end");
			await core.waitForBarrier("steer:1:before-user-start");
			expect(core.commandJournal.filter((entry) => entry.text === lateText)).toHaveLength(1);
			const uncertainProjection = await conn.waitForFrom(stopCursor, (frame) =>
				intentRows(frame).some((row) => intentId(row) === lateIntentId && row.deliveryState === "uncertain"),
			);
			expect(intentRows(uncertainProjection).find((row) => intentId(row) === lateIntentId)?.retryable).toBe(false);

			core.releaseBarrier("steer:1:before-user-start");
			await conn.waitFor((frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === lateIntentId);

			expect(core.commandJournal.filter((entry) => entry.text === lateText)).toHaveLength(1);
			expect(userMessageEnds(conn.messages, lateText).map(deliveryIntentId)).toEqual([lateIntentId]);
			expect(intentRows(latestIntentProjection(conn.messages))).toEqual([]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	test("gateway restore preserves the accepted intent ID and redrives a proven unechoed steer once", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		const restoredIntentId = "intent-gateway-restore-0001";
		const restoredText = "RESTORE_THIS_OCCURRENCE_ONCE";
		try {
			core.armBarrier("tool:before-end");
			conn.send({ type: "prompt", text: "RELIABLE_TOOL_HOLD" });
			await core.waitForBarrier("tool:before-end");
			const live = gateway.sessionManager.getSession(sessionId);
			expect(live).toBeTruthy();
			live.rpcClient._agent.env.MOCK_STEER_QUEUE_DROP = "always";

			conn.send({ type: "steer", text: restoredText, intentId: restoredIntentId });
			await core.waitForBarrier("steer:1:before-ack");
			const persisted = gateway.sessionManager.resolveStoreForSession(sessionId).get(sessionId);
			const ledger = persisted?.inFlightSteerTexts ?? persisted?.deliveryOutbox ?? [];
			expect(
				ledger.some((row: any) => intentId(row) === restoredIntentId),
				"RELIABLE_RESTART_IDENTITY: persisted dispatch evidence must retain the browser-created occurrence ID",
			).toBe(true);

			core.releaseBarrier("tool:before-end");
			await core.waitForBarrier("tool:after-end");
			await closeConnection(conn);
			live.unsubscribe();
			await live.rpcClient.stop();
			gateway.sessionManager.sessions.delete(sessionId);

			const restoredClock = await restoreWithLocalMockAgentClock(gateway, sessionId);
			await restoredClock.settleCurrentPrompt();
			conn = await connectWs(sessionId);
			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const snapshot = await conn.waitForFrom(snapshotCursor, (frame) => frame.type === "messages");
			const messages = Array.isArray(snapshot.data) ? snapshot.data : snapshot.data?.messages ?? [];
			const restoredUsers = messages.filter((message: any) =>
				(message.role === "user" || message.role === "user-with-attachments")
				&& message.content?.some?.((part: any) => part?.type === "text" && part.text === restoredText),
			);
			expect(restoredUsers).toHaveLength(1);
			expect(restoredUsers[0].deliveryIntentId ?? restoredUsers[0].intentId).toBe(restoredIntentId);
			expect(intentRows(latestIntentProjection(conn.messages))).toEqual([]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});

	test("ambiguous steer acknowledgement stays uncertain across reconnect and late echo instead of replaying", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		const intentIdValue = "intent-ambiguous-steer-0001";
		try {
			core.armBarrier("tool:before-end");
			conn.send({ type: "prompt", text: "RELIABLE_TOOL_HOLD" });
			await core.waitForBarrier("tool:before-end");

			core.configureReliableScenario({ steerFailures: { 1: "ambiguous" } });
			core.armBarrier("steer:1:before-ack");
			core.armBarrier("steer:1:before-user-start");
			const cursor = conn.messageCount();
			conn.send({ type: "steer", text: "AMBIGUOUS_LATE_ECHO", intentId: intentIdValue });
			await core.waitForBarrier("steer:1:before-ack");
			const heldProjection = await conn.waitForFrom(cursor, (frame) => frameHasIntentIds(frame, [intentIdValue]));
			expect(intentRows(heldProjection).map(intentId)).toContain(intentIdValue);
			core.releaseBarrier("steer:1:before-ack");

			const uncertain = await conn.waitForFrom(cursor, (frame) =>
				intentRows(frame).some((row) => intentId(row) === intentIdValue && row.deliveryState === "uncertain"),
			);
			expect(intentRows(uncertain).find((row) => intentId(row) === intentIdValue)?.retryable).toBe(false);

			await closeConnection(conn);
			conn = await connectWs(sessionId);
			const reconnectCursor = conn.messageCount();
			const restoredUncertain = conn.waitForFrom(0, (frame) =>
				intentRows(frame).some((row) => intentId(row) === intentIdValue && row.deliveryState === "uncertain"),
			);
			conn.send({ type: "get_messages" });
			await conn.waitForFrom(reconnectCursor, (frame) => frame.type === "messages");
			expect(intentRows(await restoredUncertain).find((row) => intentId(row) === intentIdValue)?.retryable).toBe(false);

			conn.send({ type: "retry_intent", intentId: intentIdValue });
			core.releaseBarrier("tool:before-end");
			await core.waitForBarrier("steer:1:before-user-start");
			core.releaseBarrier("steer:1:before-user-start");
			await conn.waitFor((frame) => frame.type === "event"
				&& frame.data?.type === "message_end"
				&& deliveryIntentId(frame) === intentIdValue);

			expect(core.commandJournal.filter((entry) => entry.kind === "steer" && entry.text === "AMBIGUOUS_LATE_ECHO"))
				.toHaveLength(1);
			expect(userMessageEnds(conn.messages, "AMBIGUOUS_LATE_ECHO").map(deliveryIntentId)).toEqual([intentIdValue]);
			expect(intentRows(latestIntentProjection(conn.messages))).toEqual([]);
		} finally {
			core.releaseAllBarriers();
			await closeConnection(conn);
			await deleteSession(sessionId);
		}
	});
});
