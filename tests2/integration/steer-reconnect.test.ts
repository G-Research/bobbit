import { test, expect } from "./_e2e/in-process-harness.js";
import { createSession, deleteSession, connectWs, statusPredicate } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

test.setTimeout(30_000);

test.describe("Steer + WS reconnect (AC §2)", () => {
	test("steer survives WS reconnect mid-flight without duplication", async () => {
		const sessionId = await createSession();
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 long task" });
			await conn.waitFor(statusPredicate("streaming"));
			conn.send({ type: "steer", text: "RECONNECT_STEER_TEXT" });
			// Wait for the server to ack the steer via a queue_update before closing
			// the WS, so the steer is guaranteed to have been processed server-side.
			await conn.waitFor(
				(m) =>
					(m.type === "queue_update" && (m.queue || []).some((q: any) => q.isSteered)) ||
					(m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user" &&
						((m.data?.message?.content?.[0]?.text) || "").includes("RECONNECT_STEER_TEXT")),
				5000,
			);
			conn.close();
			conn = await connectWs(sessionId);
			await conn.waitFor((m) => m.type === "queue_update", 5000);
			// Best-effort: the session may already be idle at reconnect (the WS-connect
			// snapshot carries the current status, which waitFor scans), so don't hard-fail
			// if the idle transition already happened.
			await conn.waitFor(statusPredicate("idle"), 30_000).catch(() => { /* already idle */ });

			// Assert on the DURABLE transcript, not a live broadcast. Counting live
			// `message_end` frames on the reconnected socket is racy: under load the
			// steered turn can be echoed during the close→reconnect gap, so the new
			// connection never observes the live frame (count 0) even though the steer
			// persisted correctly. The dedup property is about the PERSISTED transcript
			// containing the steer exactly once — poll get_messages and count there.
			const countSteerInSnapshot = async (): Promise<number> => {
				const cursor = conn.messageCount();
				conn.send({ type: "get_messages" });
				const resp = await conn.waitForFrom(cursor, (m) => m.type === "messages", 10_000);
				const messages = Array.isArray((resp as any).data)
					? (resp as any).data
					: ((resp as any).data?.messages || []);
				return messages
					.filter((m: any) => m.role === "user")
					.reduce(
						(n: number, m: any) => n + (String(m.content?.[0]?.text || "").split("RECONNECT_STEER_TEXT").length - 1),
						0,
					);
			};
			await pollUntil(async () => (await countSteerInSnapshot()) === 1, {
				timeoutMs: 10_000,
				intervalMs: 250,
				label: "steer persisted exactly once after reconnect",
			});
			expect(await countSteerInSnapshot()).toBe(1);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
