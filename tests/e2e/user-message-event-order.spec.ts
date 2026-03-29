/**
 * E2E test to capture the exact event order when a prompt is sent.
 * Goal: understand if there's a window where user message_end can be lost.
 */
import { test, expect } from "./gateway-harness.js";
import { createSession, connectWs, messageEndPredicate, agentEndPredicate } from "./e2e-setup.js";

test("capture event order after prompt", async () => {
	const sessionId = await createSession();
	const conn = await connectWs(sessionId);

	try {
		// Clear auth-phase messages
		conn.messages.length = 0;

		// Send prompt
		conn.send({ type: "prompt", text: "Say hello" });

		// Wait for agent to finish (replaces the old 5s sleep)
		await conn.waitFor(agentEndPredicate());

		// Log the event order
		const eventSummary = conn.messages.map(e => {
			if (e.type === "event") {
				const d = e.data;
				if (d.type === "message_end") return `event:message_end(role=${d.message?.role})`;
				if (d.type === "message_start") return `event:message_start(role=${d.message?.role})`;
				if (d.type === "message_update") return `event:message_update(role=${d.message?.role})`;
				return `event:${d.type}`;
			}
			return e.type;
		});

		console.log("Event order after prompt:");
		eventSummary.forEach((e, i) => console.log(`  ${i}: ${e}`));

		// Verify user message_end appears
		const userMsgEnd = conn.messages.find(e =>
			e.type === "event" && e.data?.type === "message_end" && e.data?.message?.role === "user"
		);
		expect(userMsgEnd).toBeTruthy();

		// Check: does agent_start come before or after user message_end?
		const agentStartIdx = eventSummary.findIndex(e => e === "event:agent_start");
		const userMsgEndIdx = eventSummary.findIndex(e => e === "event:message_end(role=user)");

		console.log(`\nagent_start index: ${agentStartIdx}`);
		console.log(`user message_end index: ${userMsgEndIdx}`);
		console.log(`Order: ${userMsgEndIdx < agentStartIdx ? "user_msg BEFORE agent_start" : "agent_start BEFORE user_msg"}`);
	} finally {
		conn.close();
	}
});

test("reconnect race: send get_messages while agent streams, check for user message", async () => {
	const sessionId = await createSession();
	const conn = await connectWs(sessionId);

	try {
		conn.messages.length = 0;

		// Send prompt
		conn.send({ type: "prompt", text: "Write a haiku about testing" });

		// Wait for agent to start streaming
		await conn.waitFor(
			(m) => m.type === "event" && m.data?.type === "agent_start",
		);

		// Now send get_messages (simulates reconnect requesting message state)
		conn.send({ type: "get_messages" });

		// Wait for messages response
		const messagesResponse = await conn.waitFor((m) => m.type === "messages");

		const msgs = Array.isArray(messagesResponse.data)
			? messagesResponse.data
			: messagesResponse.data?.messages;

		const userMsg = msgs?.find((m: any) =>
			m.role === "user" && Array.isArray(m.content) &&
			m.content.some((c: any) => c.text?.includes("haiku"))
		);

		console.log(`\nget_messages during streaming: ${msgs?.length} messages`);
		console.log(`User message present: ${!!userMsg}`);

		expect(userMsg).toBeTruthy();
	} finally {
		conn.close();
	}
});
