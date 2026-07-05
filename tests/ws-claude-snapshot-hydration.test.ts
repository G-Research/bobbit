import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { handleWebSocketConnection } from "../src/server/ws/handler.ts";

class FakeWs extends EventEmitter {
	readyState = 1;
	sent: any[] = [];
	closed: { code: number; reason: string } | undefined;

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	close(code: number, reason: string) {
		this.closed = { code, reason };
		this.readyState = 3;
	}
}

function makeSession(overrides: Record<string, any> = {}) {
	return {
		id: "session-1",
		title: "Test session",
		status: "idle",
		statusVersion: 7,
		clients: new Set(),
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => [] },
		rpcClient: {
			getMessages: mock.fn(async () => ({ success: true, data: { messages: [] } })),
		},
		...overrides,
	};
}

function makeManager(session: any, persisted: any, hydrate = mock.fn(async (_id: string, live: unknown) => live)): any {
	return {
		getSession: mock.fn(() => session),
		getArchivedSession: mock.fn(() => undefined),
		addClient: mock.fn((_id: string, ws: any) => {
			session.clients.add(ws);
			return true;
		}),
		getSessionCostUpdate: mock.fn(() => undefined),
		getPersistedSession: mock.fn(() => persisted),
		getImageModelForSession: mock.fn(() => undefined),
		withSessionCostInState: mock.fn((_id: string, data: unknown) => data),
		getPendingToolPermission: mock.fn(() => undefined),
		hydrateClaudeCodeSnapshotMessages: hydrate,
		// Fake stand-in for SessionManager.getMessagesSnapshotBase(). This test
		// exercises handler.ts wiring the attach path and the explicit
		// `get_messages` path through the shared hydrate step, not PERF-06's
		// memoization (that's covered directly against the real SessionManager
		// in session-manager-snapshot-memo.test.ts) — so this fake intentionally
		// does NOT cache, preserving the original per-call
		// hydrate.mock.callCount() assertions below.
		getMessagesSnapshotBase: mock.fn(async (s: any) => {
			const msgsResp = await s.rpcClient.getMessages();
			if (!msgsResp?.success) return msgsResp;
			const hydrated = await hydrate(s.id, msgsResp.data);
			return { ...msgsResp, data: hydrated };
		}),
	};
}

async function connect(ws: FakeWs, manager: any) {
	handleWebSocketConnection(
		ws as any,
		"session-1",
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		manager,
		"token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		undefined,
		true,
	);
	ws.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "" })));
	await waitImmediate();
	await waitImmediate();
}

function messageFrames(ws: FakeWs) {
	return ws.sent.filter((frame) => frame.type === "messages");
}

describe("WebSocket Claude Code snapshot hydration", () => {
	it("hydrates both attach-time and explicit get_messages snapshots through the persisted Claude transcript fallback", async () => {
		const persistedMessages = [
			{ id: "user-1", role: "user", content: [{ type: "text", text: "hello after restart" }] },
			{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "restored answer" }] },
		];
		const session = makeSession();
		const hydrate = mock.fn(async (_id: string, _live: unknown) => ({ messages: persistedMessages.map((message) => ({ ...message })) }));
		const manager = makeManager(session, { id: "session-1", runtime: "claude-code", modelProvider: "claude-code" }, hydrate);
		const ws = new FakeWs();

		await connect(ws, manager);
		let frames = messageFrames(ws);
		assert.equal(frames.length, 1, "Claude Code attach should send one hydrated snapshot");
		assert.equal(frames[0].data.messages[0].content[0].text, "hello after restart");

		ws.emit("message", Buffer.from(JSON.stringify({ type: "get_messages" })));
		await waitImmediate();
		await waitImmediate();

		frames = messageFrames(ws);
		assert.equal(frames.length, 2, "explicit get_messages should send a second hydrated snapshot");
		assert.equal(frames[1].data.messages[1].content[0].text, "restored answer");
		assert.equal(hydrate.mock.callCount(), 2);
	});

	it("keeps Pi attach behavior unchanged and only sends live snapshots on explicit get_messages", async () => {
		const session = makeSession();
		const hydrate = mock.fn(async (_id: string, live: unknown) => live);
		const manager = makeManager(session, { id: "session-1", runtime: "pi", modelProvider: "anthropic" }, hydrate);
		const ws = new FakeWs();

		await connect(ws, manager);
		assert.equal(messageFrames(ws).length, 0, "Pi attach must not send the Claude Code proactive snapshot");
		assert.equal(session.rpcClient.getMessages.mock.callCount(), 0);

		ws.emit("message", Buffer.from(JSON.stringify({ type: "get_messages" })));
		await waitImmediate();
		await waitImmediate();

		const frames = messageFrames(ws);
		assert.equal(frames.length, 1);
		assert.deepEqual(frames[0].data.messages, []);
		assert.equal(hydrate.mock.callCount(), 1);
	});
});
