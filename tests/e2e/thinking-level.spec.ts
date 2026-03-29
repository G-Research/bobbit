/**
 * E2E test proving the thinking level toggle is non-functional.
 *
 * The server currently has no handler for `set_thinking_level` messages,
 * so sending one produces an UNKNOWN_TYPE error. This test will pass
 * once the server-side plumbing is wired up.
 */
import { test, expect } from "./gateway-harness.js";
import { createSession, connectWs, waitForHealth } from "./e2e-setup.js";

test.describe("Thinking Level", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

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

			// The server should NOT respond with an error.
			// On the broken codebase, it responds with:
			//   { type: "error", message: "Unknown message type", code: "UNKNOWN_TYPE" }
			// Wait a moment for any error to arrive
			await new Promise((r) => setTimeout(r, 500));

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
