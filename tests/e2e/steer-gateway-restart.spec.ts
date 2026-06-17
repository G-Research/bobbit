/**
 * AC §3 — Steer + gateway restart durability.
 *
 * Sequence: STAY_BUSY → queue a prompt containing two sentinel lines → promote
 * it to steered → while streaming, promotion immediately dequeues it and calls
 * the live steer dispatch path → simulate a gateway restart → assert both
 * sentinel lines remain in the transcript exactly once each, ordering preserved,
 * with no queued rows redrained after restore.
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
 * owns wait abort, shadow-ledger handoff, and RPC-failure recovery. After the
 * steer echoes into the transcript, a restart should not find steered rows to
 * drain again.
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

test.setTimeout(60_000);

test.describe("Steer + gateway restart (AC §3)", () => {
	test("steered queued text survives restart exactly once, ordered", async ({ gateway }) => {
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

			await expect.poll(() => {
				const userMsgs = conn.messages.filter(
					(m: any) =>
						m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user",
				);
				const text = userMsgs
					.map((m: any) => m.data?.message?.content?.[0]?.text || "")
					.join("\n");
				return text.includes("RESTART_M1") && text.includes("RESTART_M2");
			}, { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);

			await conn.waitFor(statusPredicate("idle"), 30_000).catch(() => { /* already idle/no status replay */ });

			// Step 3 — simulate gateway restart.
			conn.close();
			const sm = (gateway as any).sessionManager;
			const liveSession = sm.sessions.get(sessionId);
			expect(liveSession, "session live before restart").toBeTruthy();
			liveSession.unsubscribe();
			try { await liveSession.rpcClient.stop(); } catch { /* already dead */ }
			sm.sessions.delete(sessionId);

			// The steered rows were dispatched before restart, so restore should
			// not read queued steered rows and redrain them.
			const storeState = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(storeState?.messageQueue?.length ?? 0).toBe(0);

			await sm.restoreSessions();

			// Step 4 — reconnect and read the restored transcript.
			conn = await connectWs(sessionId);
			await conn.waitFor((m: any) => m.type === "queue_update", 5_000);
			const beforeMessages = conn.messageCount();
			conn.send({ type: "get_messages" });
			const messagesResponse = await conn.waitForFrom(beforeMessages, (m: any) => m.type === "messages", 10_000);
			const messages = Array.isArray(messagesResponse.data)
				? messagesResponse.data
				: (messagesResponse.data?.messages || []);

			// Step 5 — count occurrences of each sentinel. Both must appear
			// exactly once across all user-message bodies.
			const userBodies = messages
				.filter((m: any) => m.role === "user")
				.map((m: any) => m.content?.[0]?.text || "");
			const countOccurrences = (needle: string): number =>
				userBodies.reduce(
					(n: number, body: string) => n + (body.split(needle).length - 1),
					0,
				);
			expect(countOccurrences("RESTART_M1")).toBe(1);
			expect(countOccurrences("RESTART_M2")).toBe(1);

			// Ordering: M1 must appear at-or-before M2 in the joined transcript.
			const joined = userBodies.join("\n");
			expect(joined.indexOf("RESTART_M1")).toBeLessThan(joined.indexOf("RESTART_M2"));

			// Sanity: REST API agrees the session is back.
			const stillThere = await apiFetch(`/api/sessions/${sessionId}`);
			expect(stillThere.status).toBe(200);
		} finally {
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
