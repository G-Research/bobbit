import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-sequence-hole.spec.ts (v2-dom tier).
// The legacy Playwright fixture hand-copied the sequencer to reproduce the bug
// where a top-level `tool_permission_needed` frame consumes an EventBuffer seq
// but did not advance the client sequencer, stalling the following event forever.
// Here we drive the REAL RemoteAgent handleServerMessage (`case "event"` +
// `case "tool_permission_needed"` + _advanceTopLevelSeq), asserting the same
// invariant on production code. The simulated dispatcher (handleAgentEvent) is
// the only mirrored piece; the permission card is observed on the REAL reducer
// state. session-manager imported first (TDZ guard); safe-markdown-block
// pre-imported so lazy defines resolve.
import { describe, expect, it } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";
import { setRenderApp } from "../../src/app/state.js";

setRenderApp(() => {});

function makeAgent() {
	const ra: any = new RemoteAgent();
	const dispatched: string[] = [];
	ra.send = () => {};
	// Mirror the fixture's simulated dispatcher, recording `${type}:${id}`.
	ra.handleAgentEvent = (event: any) => {
		dispatched.push(`${event.type}:${event.message?.id || event.toolName || ""}`);
	};
	ra.__dispatched = dispatched;
	return ra;
}

// The permission card is applied to the REAL reducer state as a message with
// role "tool_permission_needed".
function cards(ra: any) {
	return ra.reducerState.messages
		.filter((m: any) => m.role === "tool_permission_needed")
		.map((m: any) => ({ toolName: m.toolName }));
}

describe("RemoteAgent event sequencer handles top-level permission frames", () => {
	it("contiguous event frames dispatch", async () => {
		const a = makeAgent();
		await a.handleServerMessage({ type: "event", seq: 1, data: { type: "message_end", message: { id: "u1" } } });
		await a.handleServerMessage({ type: "event", seq: 2, data: { type: "message_end", message: { id: "a1" } } });
		expect(a.__dispatched).toEqual(["message_end:u1", "message_end:a1"]);
		expect(a._highestSeq).toBe(2);
		expect(a._pendingEvents.length).toBe(0);
	});

	it("top-level tool_permission_needed seq does not stall subsequent event stream", async () => {
		const a = makeAgent();
		await a.handleServerMessage({ type: "event", seq: 1, data: { type: "message_end", message: { id: "u1" } } });
		await a.handleServerMessage({ type: "tool_permission_needed", seq: 2, ts: 20, toolName: "Bash" });
		await a.handleServerMessage({ type: "event", seq: 3, data: { type: "message_end", message: { id: "a1" } } });

		// After the fix: seq=2 advances the sequencer, so seq=3 dispatches
		// immediately and no event remains buffered — and the card is rendered.
		expect(cards(a)).toEqual([{ toolName: "Bash" }]);
		expect(a.__dispatched).toEqual(["message_end:u1", "message_end:a1"]);
		expect(a._highestSeq).toBe(3);
		expect(a._pendingEvents.length).toBe(0);
	});
});
