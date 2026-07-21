import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	defaultProject,
	messageEndPredicate,
	type WsConnection,
} from "./_e2e/e2e-setup.js";
import { gatewaySync } from "./_e2e/runtime.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

const HUMAN_PROMPT = "AUTHOR_HUMAN_LIVE_SNAPSHOT_RECONNECT";
const STAFF_PROMPT = "AUTHOR_STAFF_RENAME_LIVE_SNAPSHOT";
const SYSTEM_PROMPT = "AUTHOR_SYSTEM_TASK_NOTIFICATION";

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

async function getMessages(conn: WsConnection): Promise<any[]> {
	const cursor = conn.messageCount();
	conn.send({ type: "get_messages" });
	return snapshotMessages(await conn.waitForFrom(cursor, (message) => message.type === "messages"));
}

function authoredTurn(messages: any[], prompt: string): { user: any; assistant: any } {
	const user = messages.find((message) => message.role === "user" && messageText(message) === prompt);
	const assistant = messages.find((message) => message.role === "assistant");
	expect(user, `snapshot contains user prompt ${prompt}`).toBeTruthy();
	expect(assistant, "snapshot contains assistant response").toBeTruthy();
	return { user, assistant };
}

test("human WS author survives live echo, snapshot, and reconnect without changing roles or text", async ({ gateway }) => {
	const sessionId = await createSession();
	const agentClock = attachLocalMockAgentClock(gateway, sessionId);
	const conn = await connectWs(sessionId);
	let liveSnapshot: { user: any; assistant: any };

	try {
		conn.send({ type: "prompt", text: HUMAN_PROMPT });
		const liveUser = await conn.waitFor(messageEndPredicate("user"));
		expect(liveUser.data.message.role).toBe("user");
		expect(messageText(liveUser.data.message)).toBe(HUMAN_PROMPT);
		expect(liveUser.data.message.author).toEqual({
			kind: "user",
			id: "user:local",
			label: "User",
		});

		await agentClock.settleCurrentPrompt();
		const liveAssistant = conn.messages.find(messageEndPredicate("assistant"));
		expect(liveAssistant?.data.message.role).toBe("assistant");
		expect(liveAssistant?.data.message.author).toMatchObject({
			kind: "agent",
			id: `session:${sessionId}`,
		});

		liveSnapshot = authoredTurn(await getMessages(conn), HUMAN_PROMPT);
	} finally {
		conn.close();
	}

	const reconnected = await connectWs(sessionId);
	try {
		const reconnectSnapshot = authoredTurn(await getMessages(reconnected), HUMAN_PROMPT);
		expect(reconnectSnapshot.user).toMatchObject({
			role: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		expect(messageText(reconnectSnapshot.user)).toBe(HUMAN_PROMPT);
		expect(reconnectSnapshot.assistant).toMatchObject({
			role: "assistant",
			author: { kind: "agent", id: `session:${sessionId}` },
		});
		expect(reconnectSnapshot.user.author).toEqual(liveSnapshot!.user.author);
		expect(reconnectSnapshot.assistant.author).toEqual(liveSnapshot!.assistant.author);
	} finally {
		reconnected.close();
	}
});

test("renamed staff uses the same current label in live assistant events and reload snapshots", async ({ gateway }) => {
	const project = await defaultProject();
	const oldName = `Author Staff Old ${Date.now()}`;
	const newName = `Author Staff New ${Date.now()}`;
	const created = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: oldName,
			systemPrompt: "Answer author identity regression prompts.",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
		}),
	});
	expect(created.status, await created.clone().text()).toBe(201);
	const staff = await created.json();
	const sessionId = staff.currentSessionId as string;
	let conn: WsConnection | undefined;

	try {
		const liveSession = gateway.sessionManager.getSession(sessionId);
		expect(liveSession?.title).toBe(oldName);
		expect(liveSession?.staffId).toBe(staff.id);

		const renamed = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ name: newName }),
		});
		expect(renamed.status, await renamed.clone().text()).toBe(200);
		// Preserve the review finding's exact condition: the staff record changes,
		// while the already-running session retains its original title.
		expect(gateway.sessionManager.getSession(sessionId)?.title).toBe(oldName);

		const agentClock = attachLocalMockAgentClock(gateway, sessionId);
		conn = await connectWs(sessionId);
		conn.send({ type: "prompt", text: STAFF_PROMPT });
		const liveUser = await conn.waitFor(messageEndPredicate("user"));
		expect(liveUser.data.message.role).toBe("user");
		expect(messageText(liveUser.data.message)).toBe(STAFF_PROMPT);

		await agentClock.settleCurrentPrompt();
		const liveAssistant = conn.messages.find(messageEndPredicate("assistant"))?.data.message;
		expect(liveAssistant).toMatchObject({
			role: "assistant",
			author: { kind: "agent", id: `staff:${staff.id}`, label: newName },
		});

		const snapshot = authoredTurn(await getMessages(conn), STAFF_PROMPT);
		expect(snapshot.assistant.role).toBe("assistant");
		expect(snapshot.assistant.author).toEqual(liveAssistant.author);
		expect(snapshot.assistant.author.label).toBe(newName);
	} finally {
		conn?.close();
		await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => undefined);
	}
});

test("server-generated prompt is system-authored in the live stream and get_messages snapshot", async ({ gateway }) => {
	const sessionId = await createSession();
	const agentClock = attachLocalMockAgentClock(gateway, sessionId);
	const conn = await connectWs(sessionId);

	try {
		const result = await gatewaySync().sessionManager.enqueuePrompt(sessionId, SYSTEM_PROMPT, {
			isSteered: true,
			source: "task-notification",
		});
		expect(result.status).toBe("dispatched");

		const liveUser = await conn.waitFor(messageEndPredicate("user"));
		expect(liveUser.data.message.role).toBe("user");
		expect(messageText(liveUser.data.message)).toBe(SYSTEM_PROMPT);
		expect(liveUser.data.message.author).toEqual({
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		});

		await agentClock.settleCurrentPrompt();
		const liveAssistant = conn.messages.find(messageEndPredicate("assistant"));
		expect(liveAssistant?.data.message.author).toMatchObject({
			kind: "agent",
			id: `session:${sessionId}`,
		});

		const snapshot = authoredTurn(await getMessages(conn), SYSTEM_PROMPT);
		expect(snapshot.user).toMatchObject({
			role: "user",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});
		expect(messageText(snapshot.user)).toBe(SYSTEM_PROMPT);
	} finally {
		conn.close();
	}
});
