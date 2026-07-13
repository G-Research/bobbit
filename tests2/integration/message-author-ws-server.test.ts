import { test, expect } from "./_e2e/in-process-harness.js";
import {
	agentEndPredicate,
	connectWs,
	createSession,
	messageEndPredicate,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function snapshotMessages(frame: any): any[] {
	return Array.isArray(frame?.data) ? frame.data : frame?.data?.messages ?? [];
}

test("human WS author survives live echo, snapshot, and reconnect without changing roles or text", async () => {
	const sessionId = await createSession();
	const marker = `author-human-${Date.now()}`;
	const conn = await connectWs(sessionId);

	try {
		conn.send({ type: "prompt", text: marker });
		const liveUser = await conn.waitFor(messageEndPredicate("user"));
		expect(liveUser.data.message.role).toBe("user");
		expect(messageText(liveUser.data.message)).toContain(marker);
		expect(liveUser.data.message.author).toEqual({
			kind: "user",
			id: "user:local",
			label: "User",
		});

		const liveAssistant = await conn.waitFor(messageEndPredicate("assistant"));
		expect(liveAssistant.data.message.role).toBe("assistant");
		expect(liveAssistant.data.message.author?.kind).toBe("agent");
		expect(liveAssistant.data.message.author?.id).toBe(`session:${sessionId}`);
		await conn.waitFor(agentEndPredicate(), 10_000).catch(() => {});
	} finally {
		conn.close();
	}

	const reconnected = await connectWs(sessionId);
	try {
		const snapshot = await pollUntil(async () => {
			const cursor = reconnected.messageCount();
			reconnected.send({ type: "get_messages" });
			const frame = await reconnected.waitForFrom(cursor, (message) => message.type === "messages");
			const rows = snapshotMessages(frame);
			const user = rows.find((row) => row.role === "user" && messageText(row).includes(marker));
			const assistant = rows.find((row) => row.role === "assistant" && row.author?.kind === "agent");
			return user && assistant ? { user, assistant } : null;
		}, {
			timeoutMs: 5_000,
			intervalMs: 100,
			label: "authored messages visible after reconnect",
		});

		expect(snapshot.user.role).toBe("user");
		expect(messageText(snapshot.user)).toContain(marker);
		expect(snapshot.user.author).toEqual({ kind: "user", id: "user:local", label: "User" });
		expect(snapshot.assistant.role).toBe("assistant");
		expect(snapshot.assistant.author?.kind).toBe("agent");
		expect(snapshot.assistant.author?.id).toBe(`session:${sessionId}`);
	} finally {
		reconnected.close();
	}
});
