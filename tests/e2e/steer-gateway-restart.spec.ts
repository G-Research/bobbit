/**
 * AC §3 — Steer + gateway restart durability.
 *
 * Sequence: STAY_BUSY → queue a prompt containing two sentinel lines → promote
 * it to steered → while streaming, promotion immediately dequeues it and calls
 * the live steer dispatch path → simulate a gateway restart during the in-flight
 * dispatch→echo window → assert both sentinel lines remain in the transcript
 * exactly once each, ordering preserved.
 *
 * "Restart" model: the in-process harness shares Node's module cache, so we
 * simulate a clean restart by:
 *   - tearing down the live SessionInfo (close clients, kill rpcClient,
 *     delete from the in-memory `sessions` Map),
 *   - calling `SessionManager.restoreSessions()` — the same path the server
 *     takes at boot, which re-reads `sessions.json` and replays
 *     restoreSession() per row.
 *
 * Current steer-queue behavior: `steer_queued` while streaming does not wait
 * for a later tool boundary. It removes the promoted row(s) from
 * `messageQueue` and immediately calls `_dispatchSteer()`, whose dispatch path
 * owns wait abort, persisted in-flight ledger handoff, and RPC-failure recovery.
 * If the gateway restarts before the steer echoes into the transcript, restore
 * must re-enqueue the ledger entry exactly once.
 *
 * Pattern reference: tests/e2e/pool-claim-restart-resume.spec.ts.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	queueLenPredicate,
	statusPredicate,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(60_000);

test.describe("Steer + gateway restart (AC §3)", () => {
	test("steered queued text survives in-flight restart exactly once, ordered", async ({ gateway }) => {
		const priorSteerEchoDelay = process.env.MOCK_STEER_ECHO_DELAY_MS;
		process.env.MOCK_STEER_ECHO_DELAY_MS = "5000";
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m: any) => m.type === "queue_update");

			// Step 1 — start a long-running turn so we can stage queued rows,
			// then promote them while the session is streaming. Promotion should
			// dispatch immediately through _dispatchSteer, not wait for the busy
			// tool's later boundary.
			conn.send({ type: "prompt", text: "STAY_BUSY:2000 long task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Step 2 — queue a multi-line message, then promote it to steered.
			const steeredText = "RESTART_M1\nRESTART_M2";
			conn.send({ type: "prompt", text: steeredText });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const messageId = queued.queue!.find((m: any) => m.text === steeredText)!.id;

			conn.messages.length = 0;
			conn.send({ type: "steer_queued", messageId });

			// Streaming promotion immediately drains the steered front group(s)
			// through _dispatchSteer, so the persisted queue should become empty
			// before restart.
			await conn.waitFor(queueLenPredicate(0), 10_000);

			const sm = (gateway as any).sessionManager;
			await expect.poll(() => {
				const storeState = sm.resolveStoreForSession(sessionId).get(sessionId);
				return {
					queueLen: storeState?.messageQueue?.length ?? 0,
					ledger: storeState?.inFlightSteerTexts ?? [],
				};
			}, { timeout: 10_000, intervals: [50, 100, 250] }).toEqual({
				queueLen: 0,
				ledger: [steeredText],
			});

			// Test sanity: restart before the user-message echo is durable. This is
			// the vulnerable window where queue rows are gone but the transcript does
			// not yet contain the promoted steer.
			expect(conn.messages.some(
				(m: any) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					String(m.data?.message?.content?.[0]?.text || "").includes("RESTART_M1"),
			)).toBe(false);

			// Step 3 — simulate gateway restart in the in-flight dispatch→echo window.
			conn.close();
			const liveSession = sm.sessions.get(sessionId);
			expect(liveSession, "session live before restart").toBeTruthy();
			liveSession.unsubscribe();
			try { await liveSession.rpcClient.stop(); } catch { /* already dead */ }
			sm.sessions.delete(sessionId);

			await sm.restoreSessions();

			// Step 4 — reconnect and wait for the restored ledger to be re-enqueued
			// and echoed as a real user message.
			conn = await connectWs(sessionId);
			await conn.waitFor((m: any) => m.type === "queue_update", 5_000);
			await conn.waitFor(
				(m: any) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					String(m.data?.message?.content?.[0]?.text || "").includes("RESTART_M1") &&
					String(m.data?.message?.content?.[0]?.text || "").includes("RESTART_M2"),
				30_000,
			);
			await conn.waitFor(statusPredicate("idle"), 30_000).catch(() => { /* already idle/no status replay */ });

			const readUserBodies = async (): Promise<string[]> => {
				const beforeMessages = conn.messageCount();
				conn.send({ type: "get_messages" });
				const messagesResponse = await conn.waitForFrom(beforeMessages, (m: any) => m.type === "messages", 10_000);
				const messages = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: (messagesResponse.data?.messages || []);
				return messages
					.filter((m: any) => m.role === "user")
					.map((m: any) => m.content?.[0]?.text || "");
			};
			const countOccurrences = (bodies: string[], needle: string): number =>
				bodies.reduce(
					(n: number, body: string) => n + (body.split(needle).length - 1),
					0,
				);

			// Step 5 — final count after the restored turn has settled. Both sentinels
			// must appear exactly once across all user-message bodies.
			const userBodies = await pollUntil(async () => {
				const bodies = await readUserBodies();
				return countOccurrences(bodies, "RESTART_M1") === 1 && countOccurrences(bodies, "RESTART_M2") === 1
					? bodies
					: null;
			}, { timeoutMs: 10_000, intervalMs: 250, label: "restored in-flight steer persisted exactly once" });
			expect(countOccurrences(userBodies, "RESTART_M1")).toBe(1);
			expect(countOccurrences(userBodies, "RESTART_M2")).toBe(1);

			// Ordering: M1 must appear at-or-before M2 in the joined transcript.
			const joined = userBodies.join("\n");
			expect(joined.indexOf("RESTART_M1")).toBeLessThan(joined.indexOf("RESTART_M2"));

			// Sanity: REST API agrees the session is back.
			const stillThere = await apiFetch(`/api/sessions/${sessionId}`);
			expect(stillThere.status).toBe(200);
		} finally {
			if (priorSteerEchoDelay === undefined) delete process.env.MOCK_STEER_ECHO_DELAY_MS;
			else process.env.MOCK_STEER_ECHO_DELAY_MS = priorSteerEchoDelay;
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
