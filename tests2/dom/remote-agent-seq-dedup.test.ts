import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-seq-dedup.spec.ts (v2-dom tier).
// The legacy Playwright fixture hand-copied RemoteAgent's seq dedup/ordering/
// resume reducer into plain JS. Here we drive the REAL RemoteAgent seq gate
// (handleServerMessage `case "event"` + _drainOrderedEvents) and the REAL
// reconnect resume/get_messages decision (via a fake WebSocket firing the real
// onopen→auth_ok handshake). The simulated dispatcher (handleAgentEvent) is the
// only mirrored piece — it was never the real dispatcher even in the fixture;
// the sequencer under test is production code. session-manager imported first
// (TDZ guard); safe-markdown-block pre-imported so lazy defines resolve.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";
import { setRenderApp } from "../../src/app/state.js";

setRenderApp(() => {});

// A minimal fake WebSocket so we can drive the REAL onopen/onmessage handshake
// synchronously. `send` records outbound frames.
class FakeWS {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = FakeWS.OPEN;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((evt: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(_url: string) {}
	send(s: string) { this.sent.push(s); }
	close() { this.readyState = FakeWS.CLOSED; }
}

/**
 * Real RemoteAgent with the dispatcher (handleAgentEvent) replaced by the
 * fixture's simulated one, so we observe the sequencer's dispatch order and a
 * dedup-by-id message list exactly as the legacy test did.
 */
function makeAgent() {
	const ra: any = new RemoteAgent();
	const dispatched: any[] = [];
	const messages: any[] = [];
	ra.handleAgentEvent = (data: any) => {
		dispatched.push(data);
		if (data && data.type === "message_end" && data.message) {
			const id = data.message.id;
			if (!messages.some((m) => m.id === id)) messages.push(data.message);
		}
	};
	ra.__dispatched = dispatched;
	ra.__messages = messages;
	return ra;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("RemoteAgent seq-dedup / ordering / resume", () => {
	it("duplicate seq is dropped", async () => {
		const a = makeAgent();
		const frame = { type: "event", seq: 1, ts: 100, data: { type: "message_end", message: { id: "m1", role: "assistant", content: "hi" } } };
		await a.handleServerMessage(frame);
		await a.handleServerMessage(frame); // duplicate
		expect(a.__messages.length).toBe(1);
		expect(a.__dispatched.length).toBe(1);
		expect(a._highestSeq).toBe(1);
	});

	it("out-of-order events buffer until gap fills", async () => {
		const a = makeAgent();
		const mk = (seq: number, id: string) => ({ type: "event", seq, ts: seq * 10, data: { type: "message_end", message: { id, role: "assistant", content: String(seq) } } });
		// First frame initializes the seq baseline; dispatch seq:1 to establish it.
		await a.handleServerMessage(mk(1, "m1"));
		expect(a.__messages.map((m: any) => m.id)).toEqual(["m1"]);
		await a.handleServerMessage(mk(3, "m3"));
		expect(a.__dispatched.length).toBe(1); // seq 3 buffered while waiting for seq 2
		await a.handleServerMessage(mk(2, "m2"));
		expect(a.__dispatched.length).toBe(3); // both 2 and 3 dispatched once gap fills
		expect(a.__messages.map((m: any) => m.id)).toEqual(["m1", "m2", "m3"]);
		expect(a._highestSeq).toBe(3);
	});

	it("reconnect sends resume when highestSeq > 0", async () => {
		vi.stubGlobal("WebSocket", FakeWS);
		// The real reconnect handshake fire-and-forgets hydrateSidePanelWorkspace()
		// (a REST fetch, caught internally). Stub fetch so it never hits the network.
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
		const a = makeAgent();
		await a.handleServerMessage({ type: "event", seq: 1, ts: 10, data: { type: "noop" } });
		await a.handleServerMessage({ type: "event", seq: 2, ts: 20, data: { type: "noop" } });
		expect(a._highestSeq).toBe(2);

		// Drive the REAL reconnect handshake (initial=false).
		a._connectWs(false);
		const ws: FakeWS = a.ws;
		ws.onopen?.();
		ws.sent.length = 0; // discard the auth frame; keep only post-auth_ok traffic
		ws.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
		const sent = ws.sent.map((s) => JSON.parse(s));

		expect(sent[0]).toEqual({ type: "resume", fromSeq: 2 });
		expect(sent[1]).toEqual({ type: "get_state" });
	});

	it("reconnect falls back to get_messages when highestSeq === 0", () => {
		vi.stubGlobal("WebSocket", FakeWS);
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
		const a = makeAgent();

		a._connectWs(false);
		const ws: FakeWS = a.ws;
		ws.onopen?.();
		ws.sent.length = 0;
		ws.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
		const sent = ws.sent.map((s) => JSON.parse(s));

		expect(sent[0]).toEqual({ type: "get_messages" });
		expect(sent[1]).toEqual({ type: "get_state" });
	});

	it("frame without seq is dispatched (compat)", async () => {
		const a = makeAgent();
		await a.handleServerMessage({ type: "event", data: { type: "message_end", message: { id: "x", role: "assistant", content: "hi" } } });
		expect(a.__dispatched.length).toBe(1);
		expect(a._highestSeq).toBe(0); // highestSeq unchanged when seq missing
	});

	it("full buffer replay is fully deduped", async () => {
		const a = makeAgent();
		const frames = [1, 2, 3, 4, 5].map((seq) => ({
			type: "event", seq, ts: seq * 10,
			data: { type: "message_end", message: { id: "m" + seq, role: "assistant", content: String(seq) } },
		}));
		for (const f of frames) await a.handleServerMessage(f);
		expect(a.__messages.length).toBe(5);
		// Replay identical buffer
		for (const f of frames) await a.handleServerMessage(f);
		expect(a.__messages.length).toBe(5); // after replay: still 5
		expect(a._highestSeq).toBe(5);
	});
});
