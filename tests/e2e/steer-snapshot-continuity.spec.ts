/**
 * Steer snapshot/queue continuity — regression for "steer briefly disappears".
 *
 * Race surface
 * ------------
 * `SessionManager._dispatchSteer()` removes the steered row from
 * `promptQueue` and broadcasts the empty queue *before* awaiting
 * `rpcClient.steer()`. The SDK only echoes the steered text back as
 * `message_end(role:user)` after a roundtrip, and the agent only flushes
 * that echo to `.jsonl` at that point.
 *
 * Between queue-removal and echo, a client `get_messages` (visibility
 * resync, WS reconnect resume-fallback, second tab attach) sees a
 * snapshot read from `rpcClient.getMessages()` that does NOT contain the
 * user-message row for the steered text. Before the fix, the response
 * also didn't carry any in-flight-steer marker — so the client saw:
 *   - queue empty (pill gone, since _dispatchSteer broadcast the
 *     empty queue), AND
 *   - snapshot without the user-message row (echo not yet flushed).
 *
 * Symptom: the steered text vanishes for a fraction of a second and
 * reappears once the echo lands.
 *
 * Invariant
 * ---------
 * For any moment in the dispatch→echo window, a `get_messages` response
 * paired with the latest `queue_update` must surface the steer text in
 * at least one of the two channels (pill or transcript). The text must
 * never disappear from both.
 *
 * Determinism
 * -----------
 * `MOCK_STEER_ECHO_DELAY_MS` widens the race window by parking the
 * mock's `handlePrompt(steeredText)` for N ms after the steer RPC
 * resolves. Without it, the echo fires synchronously enough that the
 * test can't reliably observe the gap.
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

const STEER_TEXT = "STEER_CONTINUITY_SENTINEL_42";

function userMsgHasText(msg: any, needle: string): boolean {
	if (!msg) return false;
	if (msg.role !== "user" && msg.role !== "user-with-attachments") return false;
	if (typeof msg.content === "string") return msg.content.includes(needle);
	if (Array.isArray(msg.content)) {
		return msg.content.some(
			(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.includes(needle),
		);
	}
	return false;
}

function snapshotHasSteer(payload: any, needle: string): boolean {
	const messages = Array.isArray(payload) ? payload : payload?.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some((m: any) => userMsgHasText(m, needle));
}

function queueHasSteer(queue: any[] | undefined, needle: string): boolean {
	if (!Array.isArray(queue)) return false;
	return queue.some((row: any) => typeof row?.text === "string" && row.text.includes(needle));
}

test.describe("Steer snapshot/queue continuity", () => {
	test.beforeAll(() => {
		process.env.MOCK_STEER_ECHO_DELAY_MS = "400";
	});
	test.afterAll(() => {
		delete process.env.MOCK_STEER_ECHO_DELAY_MS;
	});

	test("steer_queued: text is always visible in queue OR snapshot across dispatch→echo", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");

			conn.send({ type: "prompt", text: "STAY_BUSY:800 long task" });
			await conn.waitFor(statusPredicate("streaming"));

			conn.send({ type: "prompt", text: STEER_TEXT });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const msgId = (queued.queue as any[])[0].id;

			let latestQueue: any[] = (queued.queue as any[]) ?? [];
			let observedEcho = false;
			conn.ws.on("message", (raw) => {
				const m: WsMsg = JSON.parse(raw.toString());
				if (m.type === "queue_update") {
					latestQueue = (m.queue as any[]) ?? [];
				}
				if (
					m.type === "event" &&
					m.data?.type === "message_end" &&
					userMsgHasText(m.data?.message, STEER_TEXT)
				) {
					observedEcho = true;
				}
			});

			conn.send({ type: "steer_queued", messageId: msgId });

			const violations: Array<{ snapshotSize: number; queue: any[] }> = [];
			let pollsDuringGap = 0;
			const startedAt = Date.now();
			while (Date.now() - startedAt < 6_000) {
				if (observedEcho) break;
				const queueBefore = latestQueue;
				const cursor = conn.messageCount();
				conn.send({ type: "get_messages" });
				let resp: WsMsg;
				try {
					resp = await conn.waitForFrom(cursor, (m) => m.type === "messages", 3_000);
				} catch {
					break;
				}
				const queueAfter = latestQueue;
				const inSnapshot = snapshotHasSteer(resp.data, STEER_TEXT);
				const inQueueAround =
					queueHasSteer(queueBefore, STEER_TEXT) || queueHasSteer(queueAfter, STEER_TEXT);

				if (!queueHasSteer(queueAfter, STEER_TEXT)) pollsDuringGap++;

				if (!inSnapshot && !inQueueAround) {
					const echoRow = conn.messages.find(
						(m: WsMsg) =>
							m.type === "event" &&
							m.data?.type === "message_end" &&
							userMsgHasText(m.data?.message, STEER_TEXT),
					);
					if (echoRow) {
						observedEcho = true;
						break;
					}
					violations.push({
						snapshotSize: Array.isArray(resp.data)
							? (resp.data as any[]).length
							: (resp.data as any)?.messages?.length ?? -1,
						queue: queueAfter,
					});
				}
				await new Promise((r) => setImmediate(r));
			}

			expect(observedEcho, "the steered text must echo back as a user-role message_end").toBe(true);
			expect(
				pollsDuringGap,
				"test sanity: at least one get_messages poll must occur during the dispatch→echo gap",
			).toBeGreaterThan(0);
			expect(
				violations,
				`Continuity invariant violated: steer text was simultaneously absent from queue AND snapshot. ` +
					`Sample of ${Math.min(violations.length, 3)} violations: ` +
					JSON.stringify(violations.slice(0, 3)),
			).toEqual([]);

			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("direct steer: a snapshot taken during dispatch→echo carries the steer text", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");
			conn.send({ type: "prompt", text: "STAY_BUSY:600 long task" });
			await conn.waitFor(statusPredicate("streaming"));

			const DIRECT_STEER = "STEER_DIRECT_SENTINEL_99";
			const cursor = conn.messageCount();
			conn.send({ type: "steer", text: DIRECT_STEER });

			let sawInSnapshot = false;
			let sawEcho = false;
			const startedAt = Date.now();
			while (Date.now() - startedAt < 6_000) {
				const echoMsg = conn.messages
					.slice(cursor)
					.find(
						(m: WsMsg) =>
							m.type === "event" &&
							m.data?.type === "message_end" &&
							userMsgHasText(m.data?.message, DIRECT_STEER),
					);
				if (echoMsg) {
					sawEcho = true;
					break;
				}
				const reqCursor = conn.messageCount();
				conn.send({ type: "get_messages" });
				let resp: WsMsg;
				try {
					resp = await conn.waitForFrom(reqCursor, (m) => m.type === "messages", 3_000);
				} catch {
					break;
				}
				if (snapshotHasSteer(resp.data, DIRECT_STEER)) {
					sawInSnapshot = true;
					break;
				}
				await new Promise((r) => setImmediate(r));
			}

			expect(sawInSnapshot, "a snapshot during the dispatch→echo window must carry the steer text").toBe(true);
			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("WS reconnect mid-dispatch→echo: the steer text never disappears from both queue and transcript", async () => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");
			conn.send({ type: "prompt", text: "STAY_BUSY:600 long task" });
			await conn.waitFor(statusPredicate("streaming"));

			const RECONNECT_STEER = "STEER_RECONNECT_SENTINEL_77";
			conn.send({ type: "steer", text: RECONNECT_STEER });

			await conn.waitFor(
				(m) =>
					m.type === "queue_update" &&
					((m.queue as any[]) || []).every((r: any) => r.isSteered) === true,
				5_000,
			);

			conn.close();
			conn = await connectWs(sessionId);

			const cursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const resp = await conn.waitForFrom(cursor, (m) => m.type === "messages", 6_000);

			const queueUpdates = conn.messages.filter((m: WsMsg) => m.type === "queue_update");
			const latestQueue = (queueUpdates[queueUpdates.length - 1]?.queue as any[]) ?? [];
			const inQueue = queueHasSteer(latestQueue, RECONNECT_STEER);
			const inSnapshot = snapshotHasSteer(resp.data, RECONNECT_STEER);
			expect(
				inQueue || inSnapshot,
				`Reconnected client lost continuity: steer text not in queue AND not in snapshot. ` +
					`queue=${JSON.stringify(latestQueue)} snapshotSize=${
						Array.isArray(resp.data) ? (resp.data as any[]).length : (resp.data as any)?.messages?.length ?? -1
					}`,
			).toBe(true);

			await conn.waitFor(
				(m: WsMsg) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					userMsgHasText(m.data?.message, RECONNECT_STEER),
				10_000,
			);
			const echoes = conn.messages.filter(
				(m: WsMsg) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					userMsgHasText(m.data?.message, RECONNECT_STEER),
			);
			expect(echoes.length).toBe(1);

			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
