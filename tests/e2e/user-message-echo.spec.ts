/**
 * E2E test to verify user messages are echoed back via message_end events.
 *
 * This test reproduces the "missing user message" bug by:
 * 1. Connecting to a session via WebSocket
 * 2. Sending a prompt
 * 3. Verifying a message_end event with role=user arrives
 * 4. Testing reconnection scenarios to see if messages survive
 */
import { test, expect } from "./gateway-harness.js";
import { createSession, connectWs, messageEndPredicate } from "./e2e-setup.js";

test.describe("User message echo", () => {
	test("prompt sends back a message_end event with role=user", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			conn.send({ type: "prompt", text: "Hello, this is a test message" });

			const userMsgEnd = await conn.waitFor(messageEndPredicate("user"));

			expect(userMsgEnd.data.message.role).toBe("user");
			const content = userMsgEnd.data.message.content;
			const textContent = Array.isArray(content)
				? content.find((c: any) => c.type === "text")?.text
				: content;
			expect(textContent).toContain("Hello, this is a test message");
		} finally {
			conn.close();
		}
	});

	test("user message appears in get_messages response after prompt", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			conn.send({ type: "prompt", text: "Test message for get_messages" });

			await conn.waitFor(messageEndPredicate("user"));

			conn.send({ type: "get_messages" });

			const messagesResponse = await conn.waitFor((m) => m.type === "messages");

			const msgs = Array.isArray(messagesResponse.data)
				? messagesResponse.data
				: messagesResponse.data?.messages;
			expect(Array.isArray(msgs)).toBe(true);

			const userMsg = msgs.find((m: any) =>
				m.role === "user" && Array.isArray(m.content) &&
				m.content.some((c: any) => c.type === "text" && c.text?.includes("Test message for get_messages"))
			);
			expect(userMsg).toBeTruthy();
		} finally {
			conn.close();
		}
	});

	test("reconnect scenario: disconnect and reconnect, user message persists", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			conn1.send({ type: "prompt", text: "Message before disconnect" });
			await conn1.waitFor(messageEndPredicate("user"));
			conn1.close();

			await new Promise((r) => setTimeout(r, 200));

			const conn2 = await connectWs(sessionId);
			try {
				conn2.send({ type: "get_messages" });
				const messagesResponse = await conn2.waitFor((m) => m.type === "messages");

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Message before disconnect"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			// conn1 already closed
		}
	});

	test("race condition: disconnect during prompt, reconnect gets messages", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			conn1.send({ type: "prompt", text: "Race condition test message" });
			await new Promise((r) => setTimeout(r, 50));
			conn1.close();

			// Wait for the agent to process
			await new Promise((r) => setTimeout(r, 500));

			const conn2 = await connectWs(sessionId);
			try {
				conn2.send({ type: "get_messages" });
				const messagesResponse = await conn2.waitFor((m) => m.type === "messages");

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Race condition test message"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			// conn1 already closed
		}
	});

	test("second client joining mid-stream gets user message via get_messages", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			conn1.send({ type: "prompt", text: "Multi-client test" });

			await conn1.waitFor(
				(m) => m.type === "event" && m.data?.type === "agent_start",
			);

			const conn2 = await connectWs(sessionId);
			try {
				conn2.send({ type: "get_messages" });
				const messagesResponse = await conn2.waitFor((m) => m.type === "messages");

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Multi-client test"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			conn1.close();
		}
	});
});
