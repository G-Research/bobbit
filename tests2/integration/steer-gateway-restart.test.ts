/**
 * AC §3 — Steer + gateway restart durability.
 *
 * The pre-restart in-process bridge is put in deterministic queue-drop mode.
 * That leaves the accepted steer solely in SessionManager's persisted in-flight
 * ledger, matching the dispatch→echo crash window without a subprocess, sleep,
 * polling loop, or real gateway restart. Restore then re-enqueues the ledger
 * once; a fresh mock bridge echoes it into the reconnect snapshot.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	connectWs,
	createSession,
	deleteSession,
	queueLenPredicate,
} from "./_e2e/e2e-setup.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

const STEER_TEXT = "RESTART_M1\nRESTART_M2";

function snapshotMessages(frame: any): any[] {
	return Array.isArray(frame?.data) ? frame.data : frame?.data?.messages ?? [];
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

test.describe("Steer + gateway restart (AC §3)", () => {
	test("steered queued text survives in-flight restart exactly once, ordered", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		const sm = gateway.sessionManager as any;

		try {
			await conn.waitFor((message: any) => message.type === "queue_update");
			const live = sm.sessions.get(sessionId);
			expect(live, "session live before steer").toBeTruthy();
			const mockAgent = live.rpcClient?._agent;
			expect(mockAgent, "session uses the in-process mock bridge").toBeTruthy();

			// Drive only this bridge into the dispatch→echo crash seam. Mutating the
			// session-owned mock env avoids process-global state and affects no peer.
			mockAgent.env.MOCK_STEER_QUEUE_DROP = "always";
			live.status = "streaming";
			conn.send({ type: "prompt", text: STEER_TEXT });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const messageId = queued.queue!.find((message: any) => message.text === STEER_TEXT)!.id;

			const emptyQueueCursor = conn.messageCount();
			conn.send({ type: "steer_queued", messageId });
			await conn.waitForFrom(emptyQueueCursor, queueLenPredicate(0));

			const persistedBeforeRestore = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(persistedBeforeRestore?.messageQueue ?? []).toHaveLength(0);
			expect(persistedBeforeRestore?.inFlightSteerTexts).toEqual([
				expect.objectContaining({
					text: STEER_TEXT,
					promptId: expect.stringMatching(/^steer:[a-f0-9]{64}$/),
					source: "user",
					author: { kind: "user", id: "user:local", label: "User" },
				}),
			]);

			// Simulate restart precisely at Bobbit's durable boundary, then restore
			// through SessionManager with a fresh healthy in-process bridge.
			conn.close();
			live.unsubscribe();
			await live.rpcClient.stop();
			sm.sessions.delete(sessionId);
			await sm.restoreSessions();

			const restoredClock = attachLocalMockAgentClock(gateway, sessionId);
			await restoredClock.settleCurrentPrompt();

			conn = await connectWs(sessionId);
			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const response = await conn.waitForFrom(snapshotCursor, (message: any) => message.type === "messages");
			const userMessages = snapshotMessages(response).filter((message: any) => message.role === "user");
			const restoredMessages = userMessages.filter((message: any) => messageText(message).includes("RESTART_M1"));

			expect(restoredMessages).toHaveLength(1);
			expect(restoredMessages[0].author).toEqual({
				kind: "user",
				id: "user:local",
				label: "User",
			});
			expect(messageText(restoredMessages[0])).toBe(STEER_TEXT);
			expect(sm.resolveStoreForSession(sessionId).get(sessionId)?.inFlightSteerTexts ?? []).toHaveLength(0);
		} finally {
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
