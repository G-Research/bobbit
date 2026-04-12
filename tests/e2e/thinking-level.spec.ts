/**
 * E2E tests for thinking level support.
 *
 * Covers:
 * - set_thinking_level WS command is handled without error
 * - Fallback model state includes `reasoning` flag (PI-16 regression)
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

	test("fallback model state includes reasoning flag (PI-16 regression)", async () => {
		// When a client connects to a session that hasn't responded to get_state
		// yet (dormant/preparing), the server sends a fallback model state from
		// persisted data. This must include `reasoning` so the UI can show the
		// thinking level selector for reasoning-capable models.
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Wait for the initial state message with model info.
			// The fallback path fires for dormant sessions immediately on connect.
			const stateMsg = await conn.waitFor(
				(m) => m.type === "state" && m.data?.model?.id,
				10_000,
			);

			const model = stateMsg.data.model;
			expect(model).toBeTruthy();
			expect(model.id).toBeTruthy();
			// The reasoning field must be explicitly present (boolean), not undefined.
			// Without this, the thinking selector disappears from the UI.
			expect(
				typeof model.reasoning,
				`model.reasoning should be a boolean, got ${typeof model.reasoning} for model "${model.id}"`,
			).toBe("boolean");
		} finally {
			conn.close();
		}
	});
});
