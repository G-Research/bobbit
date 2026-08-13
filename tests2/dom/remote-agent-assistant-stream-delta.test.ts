import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { setRenderApp } from "../../src/app/state.js";
import {
	compactAssistantStreamDelta,
	parsePartialToolArguments,
	reconstructAssistantStreamDelta,
} from "../../src/shared/assistant-stream-delta.ts";

setRenderApp(() => {});

class FakeWS {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	readyState = FakeWS.OPEN;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((evt: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(_url: string) {}
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = FakeWS.CLOSED; }
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("RemoteAgent assistant stream delta", () => {
	it("advertises assistantStreamDelta on auth and latches the server ack", async () => {
		vi.stubGlobal("WebSocket", FakeWS);
		const agent: any = new RemoteAgent();
		agent._sessionId = "stream-cap-session";
		agent._authToken = "token";

		const connect = agent._connectWs(true);
		const ws: FakeWS = agent.ws;
		ws.onopen?.();

		expect(JSON.parse(ws.sent[0])).toMatchObject({
			type: "auth",
			clientKind: "app",
			capabilities: { assistantStreamDelta: 1 },
		});

		ws.onmessage?.({ data: JSON.stringify({ type: "auth_ok", capabilities: { assistantStreamDelta: 1 } }) });
		await connect;
		expect(agent._assistantStreamDeltaEnabled).toBe(true);
	});

	it("reconstructs compact assistant updates exactly and clears raw state on snapshot and terminal boundaries", async () => {
		const agent: any = new RemoteAgent();
		agent.send = () => {};

		const firstRaw = makeAssistantUpdate("Hello", "Hello");
		const firstCompact = compactAssistantStreamDelta(firstRaw) as any;
		await agent.handleServerMessage({ type: "event", seq: 1, ts: 10, data: firstCompact });
		expect(agent.state.streamingMessage.content[0].text).toBe("Hello");

		const secondRaw = makeAssistantUpdate("Hello world", " world");
		const secondCompact = compactAssistantStreamDelta(secondRaw, firstRaw.message) as any;
		await agent.handleServerMessage({ type: "event", seq: 2, ts: 20, data: secondCompact });
		expect(agent.state.streamingMessage.content[0].text).toBe("Hello world");
		expect(agent._previousRawAssistantStreamMessage.content[0].text).toBe("Hello world");

		await agent.handleServerMessage({ type: "event", seq: 3, ts: 30, data: { type: "process_exit" } });
		expect(agent._previousRawAssistantStreamMessage).toBeUndefined();

		const thirdRaw = makeAssistantUpdate("Bye", "Bye");
		const thirdCompact = compactAssistantStreamDelta(thirdRaw) as any;
		await agent.handleServerMessage({ type: "event", seq: 4, ts: 40, data: thirdCompact });
		expect(agent.state.streamingMessage.content[0].text).toBe("Bye");

		await agent.handleServerMessage({ type: "messages", data: [] });
		expect(agent._previousRawAssistantStreamMessage).toBeUndefined();

		const fourthRaw = makeAssistantUpdate("Again", "Again");
		const fourthCompact = compactAssistantStreamDelta(fourthRaw) as any;
		await agent.handleServerMessage({ type: "event", seq: 5, ts: 50, data: fourthCompact });
		expect(agent.state.streamingMessage.content[0].text).toBe("Again");

		await agent.handleServerMessage({
			type: "event",
			seq: 6,
			ts: 60,
			data: { type: "message_end", message: { role: "assistant", id: "stream-1", content: [{ type: "text", text: "Again" }] } },
		});
		expect(agent._previousRawAssistantStreamMessage).toBeUndefined();
	});

	it("continues progressive tool JSON after a snapshot with a self-contained baseline", async () => {
		const agent: any = new RemoteAgent();
		const ws = new FakeWS("ws://test");
		agent.ws = ws;
		agent.send = () => {};
		agent._assistantStreamDeltaEnabled = true;

		const start = makeToolUpdate({}, "toolcall_start");
		let previous = (reconstructAssistantStreamDelta(compactAssistantStreamDelta(start)) as any).message;
		const fragments = ['{"path":"src/assi', 'stant.ts","flags":[tru', 'e]}'];
		let json = fragments[0];
		const first = makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragments[0]);
		const compactFirst = compactAssistantStreamDelta(first, previous);
		previous = (reconstructAssistantStreamDelta(compactFirst, previous) as any).message;

		await agent.handleServerMessage({ type: "messages", data: [first.message] });
		expect(agent._previousRawAssistantStreamMessage).toBeUndefined();

		json += fragments[1];
		const attach = makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragments[1]);
		const selfContained = compactAssistantStreamDelta(attach, previous, { selfContained: true });
		await agent.handleServerMessage({ type: "event", seq: 1, ts: 10, data: selfContained });
		expect(agent.state.streamingMessage.content[0].arguments).toEqual(parsePartialToolArguments(json));
		expect(ws.readyState).toBe(FakeWS.OPEN);

		json += fragments[2];
		const next = makeToolUpdate(parsePartialToolArguments(json), "toolcall_delta", fragments[2]);
		const steady = compactAssistantStreamDelta(next, agent._previousRawAssistantStreamMessage);
		await agent.handleServerMessage({ type: "event", seq: 2, ts: 20, data: steady });
		expect(agent.state.streamingMessage.content[0].arguments).toEqual({ path: "src/assistant.ts", flags: [true] });
		expect(ws.readyState).toBe(FakeWS.OPEN);
	});

	it("reconnects when a compact delta cannot be reconstructed so the server resets its socket baseline", async () => {
		const agent: any = new RemoteAgent();
		const ws = new FakeWS("ws://test");
		agent.ws = ws;
		agent._assistantStreamDeltaEnabled = true;

		await agent.handleServerMessage({
			type: "event",
			seq: 1,
			ts: 10,
			data: {
				type: "message_update",
				assistantStreamDelta: 1,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lost" },
			},
		});

		expect(ws.readyState).toBe(FakeWS.CLOSED);
		expect(agent._previousRawAssistantStreamMessage).toBeUndefined();
	});
});
