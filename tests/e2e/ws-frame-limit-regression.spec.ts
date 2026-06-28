import { expect } from "@playwright/test";
import { test } from "./in-process-harness.js";
import { connectWs, createSession, deleteSession, messageEndPredicate } from "./e2e-setup.js";

const EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES = 1024 * 1024;

test.describe("WebSocket frame size routing", () => {
	test("allows authenticated non-extension prompt frames over the extension-channel envelope cap", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const promptText = "x".repeat(EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: promptText });

				const outcome = await conn.waitForFrom(
					cursor,
					(m) => m.type === "error" || messageEndPredicate("user")(m),
					10_000,
				);

				expect(
					messageEndPredicate("user")(outcome),
					`Non-extension prompt frames larger than 1 MiB must not be rejected by the extension-channel envelope guard; received ${JSON.stringify(outcome)}. FRAME_TOO_LARGE means the regression is present.`,
				).toBe(true);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
