/**
 * AC §3 — Steer + gateway restart durability.
 *
 * Sequence: STAY_BUSY → queue 2 prompts → promote both to steered → simulate
 * a gateway restart → drive the restored session to idle → assert both steered
 * messages appear as user-messages exactly once each, ordering preserved.
 *
 * "Restart" model: the in-process harness shares Node's module cache, so we
 * simulate a clean restart by:
 *   - tearing down the live SessionInfo (close clients, kill rpcClient,
 *     delete from the in-memory `sessions` Map),
 *   - calling `SessionManager.restoreSessions()` — the same path the server
 *     takes at boot, which re-reads `sessions.json` and replays
 *     restoreSession() per row.
 *
 * The persisted `messageQueue` field carries the steered rows across the
 * restart; on the next agent_end the rows drain via _dispatchSteer as a
 * single steered batch.
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
	test("two steered messages survive restart and arrive exactly once each, ordered", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m: any) => m.type === "queue_update");

			// Step 1 — start a long-running turn so we can stage steered rows
			// in the queue (steer_queued does NOT eagerly dispatch — rows wait
			// for the next tool boundary, then for restart-driven drainQueue).
			conn.send({ type: "prompt", text: "STAY_BUSY:60000 long task" });
			await conn.waitFor(statusPredicate("streaming"));

			// Step 2 — queue M1 and M2, then promote both to steered.
			conn.send({ type: "prompt", text: "RESTART_M1" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "RESTART_M2" });
			const q2 = await conn.waitFor(queueLenPredicate(2));
			const m1Id = q2.queue!.find((m: any) => m.text === "RESTART_M1")!.id;
			const m2Id = q2.queue!.find((m: any) => m.text === "RESTART_M2")!.id;

			conn.send({ type: "steer_queued", messageId: m1Id });
			conn.send({ type: "steer_queued", messageId: m2Id });
			// Both rows now isSteered=true, still resident in promptQueue
			// (no tool_execution_end yet — STAY_BUSY hasn't ticked through).
			await conn.waitFor((m: any) =>
				m.type === "queue_update" &&
				(m.queue || []).filter((q: any) => q.isSteered).length === 2,
			);

			// Step 3 — simulate gateway restart.
			// Close the WS so the client doesn't observe stale events from
			// the dying bridge, then teardown the live SessionInfo and call
			// restoreSessions() — same path as boot.
			conn.close();
			const sm = (gateway as any).sessionManager;
			const liveSession = sm.sessions.get(sessionId);
			expect(liveSession, "session live before restart").toBeTruthy();
			liveSession.unsubscribe();
			try { await liveSession.rpcClient.stop(); } catch { /* already dead */ }
			// A real gateway restart starts from a clean process — the prior
			// SessionInfo and its in-memory shadow ledger / inFlightSteerTexts
			// are gone. Drop the row from the map BEFORE the persisted store
			// records a streaming flag the restore path would re-prompt on.
			sm.sessions.delete(sessionId);

			// Optional: ensure the persisted messageQueue is what the next
			// boot will read. We don't tweak it — the queue was broadcast on
			// every steer_queued via broadcastQueue() which writes through to
			// the store. Sanity-check via the persisted view.
			const storeState = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(storeState?.messageQueue?.length ?? 0).toBe(2);
			expect(storeState!.messageQueue!.every((q: any) => q.isSteered)).toBe(true);

			await sm.restoreSessions();

			// Step 4 — reconnect and drive the restored session to idle.
			conn = await connectWs(sessionId);
			await conn.waitFor((m: any) => m.type === "queue_update", 5_000);

			// The restore path may or may not re-prompt (`wasStreaming` was
			// true before the teardown). Either way, the restored session
			// will eventually become idle once the steered batch + any
			// re-prompt continuation completes. Bound the wait generously.
			await conn.waitFor(statusPredicate("idle"), 30_000);
			// The steered rows drain on the first agent_end after restore.
			// Wait until the queue is empty AND we've observed the user
			// messages the SDK echoed.
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

			// Step 5 — count occurrences of each steered text. Both must
			// appear exactly once across all user-message echoes (steered
			// batch dispatches as a single prompt with newline-joined text;
			// the user-role echo carries both substrings in one body).
			const userBodies = conn.messages
				.filter(
					(m: any) =>
						m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user",
				)
				.map((m: any) => m.data?.message?.content?.[0]?.text || "");
			const countOccurrences = (needle: string): number =>
				userBodies.reduce(
					(n, body) => n + (body.split(needle).length - 1),
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
