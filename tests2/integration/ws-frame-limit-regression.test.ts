import { expect } from "./_e2e/in-process-harness.js";
import { test } from "./_e2e/in-process-harness.js";
import { connectWs, createSession, deleteSession, messageEndPredicate } from "./_e2e/e2e-setup.js";

const EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES = 1024 * 1024;
const EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES = 8 * 1024 * 1024;
const handlerModule = await import("../../src/server/ws/handler.ts");
const MAX_AUTHENTICATED_PROMPT_TEXT_BYTES = Reflect.get(
	handlerModule,
	"MAX_AUTHENTICATED_PROMPT_TEXT_BYTES",
) as number;

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

	test("rejects authenticated prompt text above its generic cap with a structured error and keeps the socket usable", async () => {
		expect(MAX_AUTHENTICATED_PROMPT_TEXT_BYTES).toBe(EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES);
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const promptText = "x".repeat(EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: promptText });

				const outcome = await conn.waitForFrom(
					cursor,
					(m) => m.type === "error" || messageEndPredicate("user")(m),
					10_000,
				);

				expect(outcome.type).toBe("error");
				expect(outcome.code).toBe("PROMPT_TOO_LARGE");
				expect(outcome.message ?? "").toMatch(/prompt text.*maximum size|too large|size/i);

				const pingCursor = conn.messageCount();
				conn.send({ type: "ping" });
				await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 5_000);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("rejects oversized extension-channel frames with a structured result and keeps the socket usable", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const requestId = "oversized-ext-channel-send";
				const oversizedFrameText = "x".repeat(EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({
					type: "ext_channel_send",
					requestId,
					channelId: "channel-not-attached",
					frame: { kind: "text", data: oversizedFrameText },
				});

				const result = await conn.waitForFrom(
					cursor,
					(m) =>
						(m.type === "ext_channel_result" && m.requestId === requestId) ||
						m.type === "error",
					10_000,
				);

				const structuredFrameTooLargeError =
					(result.type === "error" &&
						result.code === "FRAME_TOO_LARGE" &&
						/WebSocket frame exceeds maximum envelope size|too large|size/i.test(result.message ?? "")) ||
					(result.type === "ext_channel_result" &&
						result.requestId === requestId &&
						result.ok === false &&
						/FRAME_TOO_LARGE|maximum envelope|too large|size/i.test(`${result.error ?? ""} ${result.message ?? ""}`));

				expect(
					structuredFrameTooLargeError,
					`Oversized extension-channel frames must reject with a structured size error instead of closing/crashing; received ${JSON.stringify(result)}`,
				).toBe(true);

				const pingCursor = conn.messageCount();
				conn.send({ type: "ping" });
				await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 5_000);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
