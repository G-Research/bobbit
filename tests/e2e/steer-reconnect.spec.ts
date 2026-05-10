import { test, expect } from "./in-process-harness.js";
import { createSession, deleteSession, connectWs, statusPredicate } from "./e2e-setup.js";

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
			await conn.waitFor(statusPredicate("idle"), 30_000);
			const userSteers = conn.messages.filter(
				(m: any) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user" &&
					((m.data?.message?.content?.[0]?.text) || "").includes("RECONNECT_STEER_TEXT"),
			);
			expect(userSteers.length).toBe(1);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
