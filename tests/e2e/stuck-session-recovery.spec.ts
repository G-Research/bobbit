/**
 * E2E test for "Unstick sessions on new input".
 *
 * Forces a session turn to end with stopReason:"error" (via MOCK_ERROR), then
 * sends a new prompt and verifies that the session dispatches the new message
 * automatically — with the [SYSTEM: previous turn failed ...] prefix — rather
 * than parking it in the queue until a human clicks Retry.
 */
import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	connectWs,
	waitForHealth,
	statusPredicate,
	apiFetch,
	type WsMsg,
} from "./e2e-setup.js";

test.describe("Stuck-session recovery (implicit unstick)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("new prompt after errored turn dispatches with system prefix (no Retry needed)", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// 1. Force an errored turn.
			const c0 = conn.messageCount();
			conn.send({ type: "prompt", text: "MOCK_ERROR trigger failure" });
			await conn.waitForFrom(c0, statusPredicate("streaming"), 10_000);
			await conn.waitForFrom(c0, statusPredicate("idle"), 10_000);

			// 2. Verify the session is flagged errored via REST.
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const sessionInfo = await resp.json();
			expect(sessionInfo.lastTurnErrored).toBe(true);

			// 3. Clear message buffer so we can observe only what happens next.
			const cursor = conn.messageCount();

			// 4. Send a new prompt via WS — no Retry click.
			conn.send({ type: "prompt", text: "please continue" });

			// 5. Expect an agent_start event (i.e. the new prompt actually
			//    dispatched). If the old park-in-queue behaviour were still in
			//    place, this would time out.
			await conn.waitForFrom(
				cursor,
				(m) => m.type === "event" && m.data?.type === "agent_start",
				10_000,
			);

			// 6. Wait for the user message_end event and confirm it carries the
			//    system-prefix explaining the prior error.
			const userMsg = await conn.waitForFrom(
				cursor,
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user",
				10_000,
			);
			const content = userMsg.data.message.content;
			const userText =
				typeof content === "string"
					? content
					: Array.isArray(content)
					? content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("")
					: "";
			expect(userText).toMatch(/^\[SYSTEM: previous turn failed with: /);
			expect(userText).toContain("please continue");

			// 7. Wait for the turn to finish and confirm lastTurnErrored is cleared.
			await conn.waitForFrom(
				cursor,
				(m) => m.type === "event" && m.data?.type === "agent_end",
				10_000,
			);
			await conn.waitFor(statusPredicate("idle"), 10_000);

			const resp2 = await apiFetch(`/api/sessions/${sessionId}`);
			const sessionInfo2 = await resp2.json();
			expect(sessionInfo2.lastTurnErrored).toBeFalsy();
		} finally {
			conn.close();
		}
	});
});
