import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { emitSessionEvent, SessionManager } from "../../src/server/agent/session-manager.ts";
import { handleWebSocketConnection } from "../../src/server/ws/handler.ts";
import {
	LARGE_CONTENT_THRESHOLD,
	truncateLargeToolContent,
} from "../../src/server/agent/truncate-large-content.ts";
import { parsePartialToolArguments, reconstructAssistantStreamDelta } from "../../src/shared/assistant-stream-delta.ts";

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

function makeToolUpdate(argumentsValue: Record<string, unknown>, type: "toolcall_start" | "toolcall_delta", delta?: string) {
	const message = {
		role: "assistant",
		id: "stream-tool-1",
		content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: structuredClone(argumentsValue) }],
		timestamp: 1_735_000_000_000,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type,
			contentIndex: 0,
			...(delta === undefined ? {} : { delta }),
			partial: structuredClone(message),
		},
	};
}

function makeWriteUpdate(content: string, type: "toolcall_delta" | "toolcall_start", delta?: string, nextTool = false) {
	const message = {
		role: "assistant",
		id: "stream-large-write",
		content: [
			{ type: "toolCall", id: "large-write", name: "write", arguments: { path: "large.txt", content } },
			...(nextTool ? [{ type: "toolCall", id: "next-read", name: "read", arguments: { path: "large.txt" } }] : []),
		],
		timestamp: 1_735_000_000_000,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type,
			contentIndex: nextTool ? 1 : 0,
			...(delta === undefined ? {} : { delta }),
			partial: structuredClone(message),
		},
	};
}

function makeLargeWriteEnd(blockType: "toolCall" | "tool_use") {
	const marker = "TOOLCALL_END_LARGE_WRITE_MARKER";
	const content = `${"x".repeat(256 * 1024)}${marker}`;
	const payload = { path: "large.txt", content };
	const block = blockType === "toolCall"
		? { type: blockType, id: "large-write-end", name: "write", arguments: payload }
		: { type: blockType, id: "large-write-end", name: "write", input: payload };
	const message = {
		role: "assistant",
		id: "stream-large-write-end",
		content: [block],
		timestamp: 1_735_000_000_000,
	};
	return {
		content,
		marker,
		payloadField: blockType === "toolCall" ? "arguments" : "input",
		event: {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: structuredClone(block),
				partial: structuredClone(message),
			},
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
		isKnownImageModel: () => true,
		persistSessionImageModel: () => {},
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

	it("keeps progressive tool JSON compact while retaining raw cumulative events", async () => {
		const session: any = {
			id: "sess-tools",
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

		emitSessionEvent(session, makeToolUpdate({}, "toolcall_start"));
		let json = "";
		const fragments = ['{"path":"src/assi', 'stant-stream.ts","flags":[tru', 'e,2]}'];
		for (const fragment of fragments) {
			json += fragment;
			emitSessionEvent(session, makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragment));
		}

		let previous: any;
		for (const frame of eventFrames(capable)) {
			assert.equal(frame.data.assistantStreamDelta, 1, "every capable tool frame stays compact");
			assert.equal("message" in frame.data, false);
			const reconstructed = reconstructAssistantStreamDelta(frame.data, previous) as any;
			previous = reconstructed.message;
		}
		assert.deepEqual(previous.content[0].arguments, { path: "src/assistant-stream.ts", flags: [true, 2] });

		const retained = session.eventBuffer.getAll().map((entry: any) => entry.event);
		assert.deepEqual(retained, eventFrames(legacy).map((frame) => frame.data));
		assert.deepEqual(
			retained.slice(1).map((event: any) => event.message.content[0].arguments),
			fragments.map((_, index) => parsePartialToolArguments(fragments.slice(0, index + 1).join(""))),
		);
		assert.equal(JSON.stringify(retained).includes("partialJson"), false, "raw replay must not retain transport chain state");
	});

	it("falls back safely at the write truncation boundary and resumes from a projected reconnect baseline", async () => {
		const session: any = {
			id: "sess-large-write",
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
		capable.sent.length = 0;

		emitSessionEvent(session, truncateLargeToolContent(makeWriteUpdate("", "toolcall_start")));
		const endMarker = "LARGE_WRITE_TRANSITION_END";
		const below = `${"x".repeat(1024)}${endMarker}${"x".repeat(LARGE_CONTENT_THRESHOLD - 4096 - endMarker.length)}`;
		const initialDelta = `{"path":"large.txt","content":"${below}`;
		const belowEvent = truncateLargeToolContent(makeWriteUpdate(below, "toolcall_delta", initialDelta));
		emitSessionEvent(session, belowEvent);

		let previous: any;
		for (const frame of eventFrames(capable)) {
			assert.equal(frame.data.assistantStreamDelta, 1);
			const reconstructed = reconstructAssistantStreamDelta(frame.data, previous) as any;
			assert.notStrictEqual(reconstructed, frame.data, "below-threshold compact frames must reconstruct");
			previous = reconstructed.message;
		}
		assert.deepEqual(previous.content[0].arguments, belowEvent.message.content[0].arguments);
		assert.equal(previous.content[0].partialJson, initialDelta);

		capable.sent.length = 0;
		const above = `${below}${"x".repeat(8192)}`;
		const crossingEvent = truncateLargeToolContent(makeWriteUpdate(above, "toolcall_delta", "x".repeat(8192))) as any;
		emitSessionEvent(session, crossingEvent);

		const crossingFrame = eventFrames(capable)[0].data;
		assert.equal(crossingFrame.assistantStreamDelta, undefined, "descriptor cutover must use the complete projected event when append-only reconstruction cannot converge");
		assert.deepEqual(reconstructAssistantStreamDelta(crossingFrame, previous), crossingEvent);
		assert.equal(crossingFrame.message.content[0].arguments.content._truncated, true);
		assert.equal(crossingFrame.assistantMessageEvent.partial.content[0].arguments.content._truncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(crossingFrame), "utf8") < LARGE_CONTENT_THRESHOLD);
		assert.equal(JSON.stringify(crossingFrame).includes(endMarker), false);

		(capable as any).assistantStreamDeltaNeedsBaseline = true;
		capable.sent.length = 0;
		const reconnectEvent = truncateLargeToolContent(makeWriteUpdate(above, "toolcall_start", undefined, true)) as any;
		emitSessionEvent(session, reconnectEvent);

		const reconnectFrame = eventFrames(capable)[0].data;
		assert.equal(reconnectFrame.assistantStreamDelta, 1);
		assert.equal(reconnectFrame.assistantMessageBaseline.content[0].arguments.content._truncated, true);
		assert.equal(JSON.stringify(reconnectFrame).includes(endMarker), false);
		assert.equal((capable as any).assistantStreamDeltaNeedsBaseline, false);
		assert.deepEqual(reconstructAssistantStreamDelta(reconnectFrame), reconnectEvent);
	});

	it.each(["toolCall", "tool_use"] as const)(
		"bounds every %s copy in toolcall_end without breaking compact reconstruction",
		async (blockType) => {
			const session: any = {
				id: `sess-large-write-end-${blockType}`,
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

			const { content, event, marker, payloadField } = makeLargeWriteEnd(blockType);
			const projected = truncateLargeToolContent(event) as any;
			const projectedCopies = [
				projected.message.content[0],
				projected.assistantMessageEvent.partial.content[0],
				projected.assistantMessageEvent.toolCall,
			];
			for (const block of projectedCopies) {
				assert.equal(block[payloadField].content._truncated, true);
				assert.equal(block[payloadField].content._originalLength, content.length);
			}
			const sourceCopies = [
				event.message.content[0],
				event.assistantMessageEvent.partial.content[0],
				event.assistantMessageEvent.toolCall,
			];
			for (const block of sourceCopies) assert.equal((block as any)[payloadField].content, content);
			assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") < LARGE_CONTENT_THRESHOLD);
			assert.equal(JSON.stringify(projected).includes(marker), false);

			emitSessionEvent(session, projected);

			const retained = session.eventBuffer.getAll()[0].event;
			const legacyFrame = eventFrames(legacy)[0];
			const capableFrame = eventFrames(capable)[0];
			assert.deepEqual(retained, projected);
			assert.deepEqual(legacyFrame.data, projected);
			assert.equal(capableFrame.data.assistantStreamDelta, 1);
			assert.deepEqual(reconstructAssistantStreamDelta(capableFrame.data), projected);
			for (const value of [retained, legacyFrame, capableFrame]) {
				const serialized = JSON.stringify(value);
				assert.ok(Buffer.byteLength(serialized, "utf8") < LARGE_CONTENT_THRESHOLD);
				assert.equal(serialized.includes(marker), false);
			}
		},
	);

	it("gives a capable mid-tool attach a self-contained baseline without changing replay", async () => {
		const session: any = {
			id: "sess-tool-attach",
			projectId: "project-1",
			status: "idle",
			statusVersion: 1,
			title: "Session",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: { toArray: () => [] },
			cwd: process.cwd(),
			rpcClient: { getState: async () => ({ success: false }) },
		};
		const steady = await authenticate(session, { assistantStreamDelta: 1 });
		const legacy = await authenticate(session);
		steady.sent.length = 0;
		legacy.sent.length = 0;

		emitSessionEvent(session, makeToolUpdate({}, "toolcall_start"));
		const fragments = ['{"path":"src/assi', 'stant.ts","flags":[tru', 'e]}'];
		let json = fragments[0];
		emitSessionEvent(session, makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragments[0]));

		const attached = await authenticate(session, { assistantStreamDelta: 1 });
		assert.equal((attached as any).assistantStreamDeltaNeedsBaseline, true);
		attached.sent.length = 0;
		steady.sent.length = 0;

		for (const fragment of fragments.slice(1)) {
			json += fragment;
			emitSessionEvent(session, makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragment));
		}

		const attachedFrames = eventFrames(attached);
		assert.equal(attachedFrames.length, 2);
		assert.equal(attachedFrames[0].data.assistantStreamDelta, 1);
		assert.ok(attachedFrames[0].data.assistantMessageBaseline, "first attached frame must carry prior tool JSON state");
		assert.equal(attachedFrames[0].data.assistantMessageBaseline.content[0].partialJson, fragments[0]);
		assert.equal((attached as any).assistantStreamDeltaNeedsBaseline, false);
		let reconstructed = reconstructAssistantStreamDelta(attachedFrames[0].data) as any;
		assert.deepEqual(reconstructed.message.content[0].arguments, parsePartialToolArguments(fragments.slice(0, 2).join("")));
		assert.equal("assistantMessageBaseline" in attachedFrames[1].data, false);
		reconstructed = reconstructAssistantStreamDelta(attachedFrames[1].data, reconstructed.message) as any;
		assert.deepEqual(reconstructed.message.content[0].arguments, { path: "src/assistant.ts", flags: [true] });

		for (const frame of eventFrames(steady)) {
			assert.equal(frame.data.assistantStreamDelta, 1, "an established capable recipient stays on steady compact frames");
			assert.equal("assistantMessageBaseline" in frame.data, false);
		}
		const retained = session.eventBuffer.getAll().map((entry: any) => entry.event);
		assert.deepEqual(retained, eventFrames(legacy).map((frame) => frame.data));
		assert.equal(JSON.stringify(retained).includes("partialJson"), false, "authoritative replay stays cumulative and transport-free");
	});

	it("keeps a new recipient baseline armed across raw fallback until a compact boundary", async () => {
		const session: any = {
			id: "sess-baseline-fallback",
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
		capable.sent.length = 0;

		const unsupported: any = makeAssistantUpdate("opaque", "opaque");
		unsupported.assistantMessageEvent.type = "image_delta";
		emitSessionEvent(session, unsupported);
		assert.deepEqual(eventFrames(capable)[0].data, unsupported);
		assert.equal((capable as any).assistantStreamDeltaNeedsBaseline, true, "raw fallback must not consume the baseline fence");

		emitSessionEvent(session, { type: "process_exit" });
		emitSessionEvent(session, makeAssistantUpdate("Fresh", "Fresh"));
		const compact = eventFrames(capable).at(-1)!.data;
		assert.equal(compact.assistantStreamDelta, 1);
		assert.ok(compact.assistantMessageBaseline);
		assert.equal((capable as any).assistantStreamDeltaNeedsBaseline, false);
	});

	it("re-arms only capable recipients sent a compaction snapshot", async () => {
		const session: any = {
			id: "sess-snapshot",
			projectId: "project-1",
			status: "idle",
			statusVersion: 1,
			title: "Session",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: { toArray: () => [] },
			cwd: process.cwd(),
			rpcClient: {
				getMessages: async () => ({ success: true, data: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }] }),
				getState: async () => ({ success: false }),
			},
		};
		const capable = await authenticate(session, { assistantStreamDelta: 1 });
		const legacy = await authenticate(session);
		capable.sent.length = 0;
		legacy.sent.length = 0;
		emitSessionEvent(session, makeAssistantUpdate("Hello", "Hello"));
		assert.equal((capable as any).assistantStreamDeltaNeedsBaseline, false);
		const legacyBaselineBeforeSnapshot = (legacy as any).assistantStreamDeltaNeedsBaseline;

		const closedCapable = new FakeWebSocket() as any;
		closedCapable.readyState = 3;
		closedCapable.assistantStreamDeltaCapable = true;
		closedCapable.assistantStreamDeltaNeedsBaseline = false;
		session.clients.add(closedCapable);
		const manager = Object.create(SessionManager.prototype) as any;
		manager.broadcastSessionCost = () => {};
		manager.buildVisibleMessageSnapshot = (_id: string, data: unknown) => data;
		await manager.refreshAfterCompaction(session);

		assert.equal(capable.sent.at(-1)?.type, "messages");
		assert.equal((capable as any).assistantStreamDeltaNeedsBaseline, true);
		assert.equal((legacy as any).assistantStreamDeltaNeedsBaseline, legacyBaselineBeforeSnapshot);
		assert.equal(closedCapable.assistantStreamDeltaNeedsBaseline, false, "an unsent snapshot must not alter the baseline");

		emitSessionEvent(session, makeAssistantUpdate("Hello world", " world"));
		const compact = eventFrames(capable).at(-1)!.data;
		assert.ok(compact.assistantMessageBaseline, "the first post-snapshot delta must be self-contained");
		const reconstructed = reconstructAssistantStreamDelta(compact) as any;
		assert.equal(reconstructed.message.content[0].text, "Hello world");
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

		fast.emit("message", JSON.stringify({ type: "set_image_model", provider: "test", modelId: "image-test" }));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(slow.sent.length, 0, "handler-local state broadcasts must honor delayed-close cutover");
		assert.deepEqual(fast.sent.at(-1), {
			type: "state",
			data: { imageGenerationModel: { provider: "test", id: "image-test" } },
		});

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
