/**
 * E2E test proving the thinking level toggle is non-functional.
 *
 * The server currently has no handler for `set_thinking_level` messages,
 * so sending one produces an UNKNOWN_TYPE error. This test will pass
 * once the server-side plumbing is wired up.
 */
import { test, expect } from "./in-process-harness.js";
import { createSession, connectWs } from "./e2e-setup.js";

test.describe("Thinking Level", () => {

	test("set_thinking_level is handled by the server", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Wait for initial state
			await conn.waitFor((m) => m.type === "queue_update");

			// Clear messages for clean assertions
			conn.messages.length = 0;

			// Send set_thinking_level
			conn.send({ type: "set_thinking_level", level: "high" });

			// Send a follow-up message we know the server responds to.
			// If set_thinking_level was going to produce an error, it would
			// arrive before this response (WS messages are ordered).
			conn.send({ type: "get_state" });
			await conn.waitFor((m) => m.type === "state");

			const errors = conn.messages.filter(
				(m) => m.type === "error" && m.code === "UNKNOWN_TYPE",
			);
			expect(
				errors.length,
				"set_thinking_level not recognized by server",
			).toBe(0);
		} finally {
			conn.close();
		}
	});
});
