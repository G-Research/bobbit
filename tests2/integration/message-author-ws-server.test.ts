import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

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
import {
	prepareVisibleAgentEvent,
} from "../../src/server/agent/session-manager.js";
import {
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import { attachLocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

const HUMAN_PROMPT = "AUTHOR_HUMAN_LIVE_SNAPSHOT_RECONNECT";
const STAFF_PROMPT = "AUTHOR_STAFF_RENAME_LIVE_SNAPSHOT";
const SYSTEM_PROMPT = "AUTHOR_SYSTEM_TASK_NOTIFICATION";
const SYSTEM_PREFIX = "[System]: ";
const PREFIX_SHAPED_SYSTEM_PROMPT = "[System]: hello";
const STRUCTURED_SYSTEM_PROMPT = "AUTHOR_SYSTEM_ECHO_IMAGE_BLOCK";
const AGENT_AUTHOR = {
	kind: "agent",
	id: "session:abcdef12-3456-7890",
	label: "Test Coordinator",
} as const;
const AGENT_PREFIX = "[Test Coordinator (abcdef)]: ";

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

function rawUserMessages(gateway: any, sessionId: string): any[] {
	const messages = gateway.sessionManager.getSession(sessionId)?.rpcClient?._agent?.conversationMessages;
	expect(Array.isArray(messages), "session uses the in-process mock transcript").toBe(true);
	return messages.filter((message: any) => message?.role === "user" || message?.role === "user-with-attachments");
}

function authorSidecarPath(gateway: any, sessionId: string): string {
	return path.join(gateway.bobbitDir, "secrets", "author-sidecar", `${sessionId}.jsonl`);
}

function sidecarBinding(sessionId: string, modelText: string): any {
	return readAuthorSidecar(sessionId).find((entry) => promptAuthorBindingMatchesText(entry, modelText));
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

		const rawHumanRows = rawUserMessages(gateway, sessionId)
			.filter(message => messageText(message) === HUMAN_PROMPT);
		expect(rawHumanRows, "human Pi text remains byte-for-byte unprefixed").toHaveLength(1);
		const humanBinding = sidecarBinding(sessionId, HUMAN_PROMPT);
		expect(humanBinding).toMatchObject({
			source: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		expect(humanBinding?.modelPrefix).toBeUndefined();

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

test("server-generated prompt is prefixed only at Pi and projects unchanged through live and snapshot views", async ({ gateway }) => {
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

		const piText = `${SYSTEM_PREFIX}${SYSTEM_PROMPT}`;
		expect(rawUserMessages(gateway, sessionId).filter(message => messageText(message) === piText),
			"Pi receives exactly one system prefix").toHaveLength(1);
		const binding = sidecarBinding(sessionId, piText);
		expect(binding).toMatchObject({
			modelPrefix: SYSTEM_PREFIX,
			source: "task-notification",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});
		expect(promptAuthorBindingMatchesText(binding, SYSTEM_PROMPT),
			"sidecar digest covers exact Pi text rather than visible base text").toBe(false);

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
		expect(JSON.stringify(snapshot.user)).not.toContain(piText);
	} finally {
		conn.close();
	}
});

test("prefix-shaped system text projects once across EventBuffer resume, cloned re-entry, and fresh snapshot fallback", async ({ gateway }) => {
	const sessionId = await createSession();
	let conn = await connectWs(sessionId);
	const session = gateway.sessionManager.getSession(sessionId) as any;
	const mockAgent = session?.rpcClient?._agent;
	expect(mockAgent, "session uses the in-process mock bridge").toBeTruthy();
	const originalHandlePrompt = mockAgent.handlePrompt;
	const stableMessageId = `prefix-shaped-${sessionId}`;

	mockAgent.handlePrompt = async function handleStablePrefixPrompt(text: string) {
		const message = {
			id: stableMessageId,
			role: "user",
			content: [{ type: "text", text }],
		};
		this.conversationMessages.push(message);
		this.emit({ type: "message_end", message });
		this.emit({ type: "agent_end" });
		this.emit({ type: "session_status", status: "idle" });
	};

	try {
		const result = await gateway.sessionManager.enqueuePrompt(sessionId, PREFIX_SHAPED_SYSTEM_PROMPT, {
			source: "task-notification",
		});
		expect(result.status).toBe("dispatched");
		const live = await conn.waitFor((frame: any) => messageEndPredicate("user")(frame)
			&& frame.data.message.id === stableMessageId);
		expect(messageText(live.data.message)).toBe(PREFIX_SHAPED_SYSTEM_PROMPT);
		expect(live.data.message.author).toEqual({
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		});

		const rawPiText = `${SYSTEM_PREFIX}${PREFIX_SHAPED_SYSTEM_PROMPT}`;
		expect(rawUserMessages(gateway, sessionId).find(message => message.id === stableMessageId)).toMatchObject({
			content: [{ type: "text", text: rawPiText }],
		});

		const buffered = session.eventBuffer.getAll().find((entry: any) =>
			entry.event?.type === "message_end" && entry.event.message?.id === stableMessageId,
		);
		expect(buffered, "projected stable-id event is retained by EventBuffer").toBeTruthy();
		expect(messageText(buffered.event.message)).toBe(PREFIX_SHAPED_SYSTEM_PROMPT);

		const clonedVisibleEvent = JSON.parse(JSON.stringify(buffered.event));
		delete clonedVisibleEvent.message.author;
		const reentered = prepareVisibleAgentEvent(session, clonedVisibleEvent) as any;
		expect(reentered.message.author).toEqual({
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		});
		expect(messageText(reentered.message),
			"digest mismatch on an already-projected clone must preserve prefix-shaped base text").toBe(PREFIX_SHAPED_SYSTEM_PROMPT);

		conn.close();
		conn = await connectWs(sessionId);
		const resumeCursor = conn.messageCount();
		conn.send({ type: "resume", fromSeq: buffered.seq - 1 });
		const resumed = await conn.waitForFrom(resumeCursor, (frame: any) =>
			messageEndPredicate("user")(frame) && frame.data.message.id === stableMessageId,
		);
		expect(messageText(resumed.data.message)).toBe(PREFIX_SHAPED_SYSTEM_PROMPT);
		expect(resumed.data.message.author.kind).toBe("system");

		const gapCursor = conn.messageCount();
		conn.send({ type: "resume", fromSeq: -1 });
		await conn.waitForFrom(gapCursor, (frame: any) => frame.type === "resume_gap");
		const fresh = (await getMessages(conn)).find(message => message.id === stableMessageId);
		expect(fresh, "fresh raw snapshot contains the stable-id prompt").toBeTruthy();
		expect(messageText(fresh)).toBe(PREFIX_SHAPED_SYSTEM_PROMPT);
		expect(fresh.author.kind).toBe("system");
	} finally {
		mockAgent.handlePrompt = originalHandlePrompt;
		conn.close();
	}
});

test("system image prompt keeps non-text blocks unchanged while projecting only the first text boundary", async ({ gateway }) => {
	const sessionId = await createSession();
	const agentClock = attachLocalMockAgentClock(gateway, sessionId);
	const conn = await connectWs(sessionId);
	const image = { type: "image" as const, data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" };

	try {
		const result = await gateway.sessionManager.enqueuePrompt(sessionId, STRUCTURED_SYSTEM_PROMPT, {
			source: "task-notification",
			images: [image],
		});
		expect(result.status).toBe("dispatched");
		const live = await conn.waitFor(messageEndPredicate("user"));
		expect(messageText(live.data.message)).toBe(STRUCTURED_SYSTEM_PROMPT);
		expect(live.data.message.content[1]).toEqual(image);

		const raw = rawUserMessages(gateway, sessionId).find(message =>
			messageText(message) === `${SYSTEM_PREFIX}${STRUCTURED_SYSTEM_PROMPT}`,
		);
		expect(raw?.content[0]).toEqual({ type: "text", text: `${SYSTEM_PREFIX}${STRUCTURED_SYSTEM_PROMPT}` });
		expect(raw?.content[1]).toEqual(image);
		expect(sidecarBinding(sessionId, `${SYSTEM_PREFIX}${STRUCTURED_SYSTEM_PROMPT}`)?.modelPrefix).toBe(SYSTEM_PREFIX);

		await agentClock.settleCurrentPrompt();
		const snapshot = (await getMessages(conn)).find(message => messageText(message) === STRUCTURED_SYSTEM_PROMPT);
		expect(snapshot?.content).toEqual([
			{ type: "text", text: STRUCTURED_SYSTEM_PROMPT },
			image,
		]);
		expect(snapshot?.author.kind).toBe("system");
	} finally {
		conn.close();
	}
});

test("sidecar append failure degrades a system occurrence to unprefixed usable Pi and visible text", async ({ gateway }) => {
	const sessionId = await createSession();
	const agentClock = attachLocalMockAgentClock(gateway, sessionId);
	const conn = await connectWs(sessionId);
	const target = authorSidecarPath(gateway, sessionId);
	fs.mkdirSync(target, { recursive: true });

	try {
		const prompt = "AUTHOR_SYSTEM_SIDECAR_APPEND_FAILURE";
		const result = await gateway.sessionManager.enqueuePrompt(sessionId, prompt, {
			source: "task-notification",
		});
		expect(result.status).toBe("dispatched");
		const live = await conn.waitFor(messageEndPredicate("user"));
		expect(messageText(live.data.message)).toBe(prompt);
		expect(live.data.message.author.kind).toBe("system");
		expect(rawUserMessages(gateway, sessionId).filter(message => messageText(message) === prompt)).toHaveLength(1);
		expect(rawUserMessages(gateway, sessionId).some(message => messageText(message) === `${SYSTEM_PREFIX}${prompt}`)).toBe(false);

		await agentClock.settleCurrentPrompt();
		expect(messageText((await getMessages(conn)).find(message => message.role === "user"))).toBe(prompt);
		expect(readAuthorSidecar(sessionId), "failed append leaves no durable proof row").toEqual([]);
	} finally {
		conn.close();
		fs.rmSync(target, { recursive: true, force: true });
	}
});

test("steer batches add one accountable prefix while durable ledgers retain only base text", async ({ gateway }) => {
	const cases = [
		{
			name: "same agent",
			rows: [
				{ text: "AGENT_BATCH_ONE", source: "agent", author: AGENT_AUTHOR },
				{ text: "AGENT_BATCH_TWO", source: "agent", author: AGENT_AUTHOR },
			],
			baseText: "AGENT_BATCH_ONE\nAGENT_BATCH_TWO",
			piText: `${AGENT_PREFIX}AGENT_BATCH_ONE\nAGENT_BATCH_TWO`,
			prefix: AGENT_PREFIX,
		},
		{
			name: "synthetic distinct humans",
			rows: [
				{ text: "HUMAN_BATCH_ONE", source: "user", author: { kind: "user", id: "user:one", label: "One" } },
				{ text: "HUMAN_BATCH_TWO", source: "user", author: { kind: "user", id: "user:two", label: "Two" } },
			],
			baseText: "HUMAN_BATCH_ONE\nHUMAN_BATCH_TWO",
			piText: "HUMAN_BATCH_ONE\nHUMAN_BATCH_TWO",
			prefix: undefined,
		},
		{
			name: "mixed human and agent",
			rows: [
				{ text: "MIXED_HUMAN", source: "user", author: { kind: "user", id: "user:local", label: "User" } },
				{ text: "MIXED_AGENT", source: "agent", author: AGENT_AUTHOR },
			],
			baseText: "MIXED_HUMAN\nMIXED_AGENT",
			piText: `${SYSTEM_PREFIX}MIXED_HUMAN\nMIXED_AGENT`,
			prefix: SYSTEM_PREFIX,
		},
	] as const;

	for (const fixture of cases) {
		const sessionId = await createSession();
		const session = gateway.sessionManager.getSession(sessionId) as any;
		const steer = vi.spyOn(session.rpcClient, "steer").mockResolvedValue({ success: true });
		try {
			const queued = fixture.rows.map(row => session.promptQueue.enqueue(row.text, {
				isSteered: true,
				source: row.source,
				author: row.author,
			}));
			await (gateway.sessionManager as any)._dispatchSteer(session, queued);
			expect(steer, `${fixture.name} exact Pi steer text`).toHaveBeenCalledOnce();
			expect(steer).toHaveBeenCalledWith(fixture.piText);
			expect(session.inFlightSteerTexts).toEqual([
				expect.objectContaining({ text: fixture.baseText }),
			]);
			const binding = sidecarBinding(sessionId, fixture.piText);
			expect(binding, `${fixture.name} sidecar binding`).toBeTruthy();
			expect(binding?.modelPrefix).toBe(fixture.prefix);
		} finally {
			steer.mockRestore();
		}
	}
});
