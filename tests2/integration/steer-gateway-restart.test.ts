/**
 * AC §3 — Steer + gateway restart durability.
 *
 * The pre-restart bridge is put in the mock SDK's deterministic queue-drop
 * mode. That leaves the accepted steer solely in SessionManager's persisted
 * in-flight ledger, exactly matching the dispatch→echo crash window without a
 * real busy turn or wall-clock delay. Restore then re-enqueues the ledger once;
 * a fresh bridge echoes it into the transcript observed after reconnect.
 */
import { it } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	queueLenPredicate,
} from "./_e2e/e2e-setup.js";
import { gatewaySync } from "./_e2e/runtime.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

test.beforeAll(() => { /* boot the fork-scoped gateway before direct declarations */ });

test.describe("Steer + gateway restart (AC §3)", () => {
	it("steered queued text survives in-flight restart exactly once, ordered", async () => {
		const priorQueueDrop = process.env.MOCK_STEER_QUEUE_DROP;
		process.env.MOCK_STEER_QUEUE_DROP = "always";
		const gateway = gatewaySync();
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m: any) => m.type === "queue_update");
			const sm = gateway.sessionManager as any;
			const live = sm.sessions.get(sessionId);
			expect(live, "session live before steer").toBeTruthy();

			// Drive the queue decision directly into the streaming branch. The mock
			// queue-drop mode accepts rpcClient.steer() without emitting a user echo,
			// leaving a deterministic restart snapshot with no timer or subprocess.
			live.status = "streaming";
			const steeredText = "RESTART_M1\nRESTART_M2";
			conn.send({ type: "prompt", text: steeredText });
			const queued = await conn.waitFor(queueLenPredicate(1));
			const messageId = queued.queue!.find((m: any) => m.text === steeredText)!.id;
			conn.messages.length = 0;
			conn.send({ type: "steer_queued", messageId });
			await conn.waitFor(queueLenPredicate(0));

			const persistedBeforeRestart = sm.resolveStoreForSession(sessionId).get(sessionId);
			expect(persistedBeforeRestart?.messageQueue ?? []).toHaveLength(0);
			expect(persistedBeforeRestart?.inFlightSteerTexts).toEqual([
				expect.objectContaining({
					text: steeredText,
					promptId: expect.stringMatching(/^steer:[a-f0-9]{64}$/),
					source: "user",
					author: { kind: "user", id: "user:local", label: "User" },
				}),
			]);

			// Simulate a gateway restart at the observable durability boundary.
			conn.close();
			live.unsubscribe();
			await live.rpcClient.stop();
			sm.sessions.delete(sessionId);

			// The replacement bridge is healthy: restore must consume the authored
			// ledger snapshot and produce the single durable user echo.
			delete process.env.MOCK_STEER_QUEUE_DROP;
			await sm.restoreSessions();
			const restoredClock = attachLocalMockAgentClock(gateway, sessionId);
			await restoredClock.settleCurrentPrompt();

			conn = await connectWs(sessionId);
			await conn.waitFor((m: any) => m.type === "queue_update");
			const beforeMessages = conn.messageCount();
			conn.send({ type: "get_messages" });
			const messagesResponse = await conn.waitForFrom(beforeMessages, (m: any) => m.type === "messages");
			const messages = Array.isArray(messagesResponse.data)
				? messagesResponse.data
				: (messagesResponse.data?.messages || []);
			const userMessages = messages.filter((m: any) => m.role === "user");
			const restoredMessage = userMessages.find((m: any) =>
				String(m.content?.[0]?.text || "").includes("RESTART_M1"),
			);
			expect(restoredMessage?.author).toEqual({
				kind: "user",
				id: "user:local",
				label: "User",
			});
			const userBodies = userMessages.map((m: any) => m.content?.[0]?.text || "");
			const countOccurrences = (needle: string): number => userBodies.reduce(
				(n: number, body: string) => n + (body.split(needle).length - 1),
				0,
			);

			expect(countOccurrences("RESTART_M1")).toBe(1);
			expect(countOccurrences("RESTART_M2")).toBe(1);
			const joined = userBodies.join("\n");
			expect(joined.indexOf("RESTART_M1")).toBeLessThan(joined.indexOf("RESTART_M2"));
			expect(sm.resolveStoreForSession(sessionId).get(sessionId)?.inFlightSteerTexts ?? []).toHaveLength(0);

			const stillThere = await apiFetch(`/api/sessions/${sessionId}`);
			expect(stillThere.status).toBe(200);
		} finally {
			if (priorQueueDrop === undefined) delete process.env.MOCK_STEER_QUEUE_DROP;
			else process.env.MOCK_STEER_QUEUE_DROP = priorQueueDrop;
			conn.close();
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
