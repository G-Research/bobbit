import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { emitSessionEvent } from "../../src/server/agent/session-manager.ts";
import { handleWebSocketConnection } from "../../src/server/ws/handler.ts";

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	terminated = 0;
	readonly sent: any[] = [];

	send(data: string, cb?: (err?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		cb?.();
	}

	terminate(): void {
		this.terminated++;
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", code, reason);
	}
}

function makeAssistantUpdate(text: string, delta: string) {
	const message = {
		role: "assistant",
		id: "stream-1",
		content: [{ type: "text", text }],
		timestamp: 1_735_000_000_000,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: structuredClone(message),
		},
	};
}

function eventFrames(ws: FakeWebSocket) {
	return ws.sent.filter((msg) => msg?.type === "event");
}

function authOk(ws: FakeWebSocket) {
	return ws.sent.find((msg) => msg?.type === "auth_ok");
}

function makeSessionManager(session: any) {
	return {
		getSession: (id: string) => (id === session.id ? session : undefined),
		getArchivedSession: () => undefined,
		addClient: (_id: string, ws: FakeWebSocket) => {
			session.clients.add(ws);
			return true;
		},
		removeClient: (_id: string, ws: FakeWebSocket) => {
			session.clients.delete(ws);
		},
		getPersistedSession: () => undefined,
		getImageModelForSession: () => undefined,
		withSessionCostInState: (_id: string, data: unknown) => data,
		getSessionCostUpdate: () => undefined,
		getPendingToolPermission: () => undefined,
		getProjectContextManager: () => undefined,
	};
}

async function authenticate(session: any, capabilities?: { assistantStreamDelta?: 1 }) {
	const ws = new FakeWebSocket();
	handleWebSocketConnection(
		ws as any,
		session.id,
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		makeSessionManager(session) as any,
		"token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		undefined,
		true,
		undefined,
		undefined,
		{} as any,
		undefined,
		undefined,
		undefined,
	);
	ws.emit("message", JSON.stringify({
		type: "auth",
		token: "ignored",
		clientKind: "app",
		...(capabilities ? { capabilities } : {}),
	}));
	await Promise.resolve();
	return ws;
}

describe("assistant stream session broadcast", () => {
	it("negotiates assistantStreamDelta on auth and stays optional for legacy clients", async () => {
		const session = {
			id: "sess-1",
			projectId: "project-1",
			status: "idle",
			statusVersion: 1,
			title: "Session",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: { toArray: () => [] },
			cwd: process.cwd(),
			rpcClient: {},
		};

		const capable = await authenticate(session, { assistantStreamDelta: 1 });
		const legacy = await authenticate(session);

		assert.equal(authOk(capable)?.capabilities?.assistantStreamDelta, 1);
		assert.equal(authOk(legacy)?.capabilities?.assistantStreamDelta, undefined);
	});

	it("sends compact live deltas only to capable clients while retaining cumulative replay events", async () => {
		const session: any = {
			id: "sess-2",
			projectId: "project-1",
			status: "idle",
			statusVersion: 1,
			title: "Session",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: { toArray: () => [] },
			cwd: process.cwd(),
			rpcClient: {},
		};

		const capable = await authenticate(session, { assistantStreamDelta: 1 });
		const legacy = await authenticate(session);
		capable.sent.length = 0;
		legacy.sent.length = 0;

		const first = makeAssistantUpdate("Hello", "Hello");
		emitSessionEvent(session, first);

		const capableFirst = eventFrames(capable)[0].data;
		const legacyFirst = eventFrames(legacy)[0].data;
		assert.equal(capableFirst.assistantStreamDelta, 1);
		assert.equal("message" in capableFirst, false);
		assert.equal(capableFirst.assistantMessageBaseline.content[0].text, "");
		assert.equal(legacyFirst.message.content[0].text, "Hello");

		const second = makeAssistantUpdate("Hello world", " world");
		emitSessionEvent(session, second);

		const capableSecond = eventFrames(capable)[1].data;
		const legacySecond = eventFrames(legacy)[1].data;
		assert.equal(capableSecond.assistantStreamDelta, 1);
		assert.equal("assistantMessageBaseline" in capableSecond, false);
		assert.equal(legacySecond.message.content[0].text, "Hello world");

		assert.deepEqual(
			session.eventBuffer.getAll().map((entry: any) => entry.event.message.content[0].text),
			["Hello", "Hello world"],
			"EventBuffer must retain authoritative cumulative replay events",
		);
		assert.deepEqual(
			session.eventBuffer.since(0).map((entry: any) => entry.event.message.content[0].text),
			["Hello", "Hello world"],
		);
	});

	it("cuts over only the slow replaceable client and fences later sends on that socket", async () => {
		const session: any = {
			id: "sess-3",
			projectId: "project-1",
			status: "idle",
			statusVersion: 1,
			title: "Session",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: { toArray: () => [] },
			cwd: process.cwd(),
			rpcClient: { getState: async () => ({ success: true, data: { model: { provider: "test", id: "test" } } }) },
		};

		const slow = await authenticate(session, { assistantStreamDelta: 1 });
		const fast = await authenticate(session, { assistantStreamDelta: 1 });
		const legacy = await authenticate(session);
		slow.sent.length = 0;
		fast.sent.length = 0;
		legacy.sent.length = 0;
		slow.bufferedAmount = 1024 * 1024;

		emitSessionEvent(session, makeAssistantUpdate("abc", "abc"));
		assert.equal(slow.terminated, 1, "slow client should be cut over before the replaceable send");
		assert.equal(eventFrames(slow).length, 0, "slow client must not receive the oversized replaceable update");
		assert.equal(eventFrames(fast).length, 1, "fast capable client still receives compact live updates");
		assert.equal(eventFrames(legacy).length, 1, "legacy client still receives cumulative live updates");

		emitSessionEvent(session, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
		assert.equal(slow.sent.length, 0, "later sends must stay fenced on the cut-over socket even if readyState never changed");
		assert.equal(fast.sent.at(-1)?.data?.type, "tool_execution_start");
		assert.equal(legacy.sent.at(-1)?.data?.type, "tool_execution_start");

		// Async handler responses must honor the same fence. The fake terminate()
		// intentionally leaves readyState OPEN to reproduce a delayed-close transport.
		slow.emit("message", JSON.stringify({ type: "get_state" }));
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(slow.sent.length, 0, "late state/snapshot sends must not refill a cut-over socket");

		// Both resumable replay and resume_gap use handler-owned send paths rather
		// than emitSessionEvent; neither may bypass the delayed-close fence.
		slow.emit("message", JSON.stringify({ type: "resume", fromSeq: 0 }));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(slow.sent.length, 0, "paced replay must not send after cutover");
		slow.emit("message", JSON.stringify({ type: "resume", fromSeq: -100 }));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(slow.sent.length, 0, "resume_gap must not send after cutover");
	});
});
