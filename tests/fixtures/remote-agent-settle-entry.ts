// Test entry — bundles the REAL RemoteAgent to pin that the turn-termination
// handlers (`case "error"` in handleServerMessage and `case "agent_end"` in
// handleAgentEvent) SETTLE any unreconciled optimistic prompt/steer row out of
// the far-future tail sentinel. Drives the production handlers directly with a
// stubbed transport — no real WebSocket.
import { RemoteAgent } from "../../src/app/remote-agent.js";

// Mirror message-reducer's OPTIMISTIC_ORDER_BASE = MAX_SAFE_INTEGER - 1e9.
// A SETTLED row drops well below this floor; a PENDING (stranded) row stays
// above it.
const OPTIMISTIC_SENTINEL_FLOOR = Number.MAX_SAFE_INTEGER - 2_000_000_000;

function makeAgent() {
	const ra: any = new RemoteAgent();
	// Stub transport — record nothing, just don't touch a real socket.
	ra.send = () => {};
	// Silence the agent_end finish-beep gate (AudioContext) deterministically so
	// the handler's side effects can't throw before/around the settle dispatch.
	if (typeof document !== "undefined") {
		document.documentElement.dataset.playAgentFinishSound = "false";
	}
	// Capture every reducer action the production handlers dispatch via apply().
	const applied: any[] = [];
	const origApply = ra.apply.bind(ra);
	ra.apply = (action: any) => { applied.push(action); return origApply(action); };
	ra.__applied = applied;
	return ra;
}

function seedOptimistic(ra: any, id: string, text: string) {
	ra.apply({
		type: "optimistic-prompt",
		message: { id, role: "user", content: [{ type: "text", text }], timestamp: 0 },
	});
}

function optimisticRows(ra: any) {
	return ra.reducerState.messages
		.filter((m: any) => m._origin === "optimistic")
		.map((m: any) => ({ id: m.id, order: m._order }));
}

(window as any).__SENTINEL_FLOOR = OPTIMISTIC_SENTINEL_FLOOR;
(window as any).__makeAgent = makeAgent;
(window as any).__seedOptimistic = seedOptimistic;
(window as any).__optimisticRows = optimisticRows;
(window as any).__appliedTypes = (ra: any) => ra.__applied.map((a: any) => a.type);
// Drive the production `case "error"` in handleServerMessage. Downstream side
// effects (notification append, emit) are NOT under test; swallow any throw so
// the assertion sees the post-settle reducer state.
(window as any).__triggerError = async (ra: any) => {
	try {
		await ra.handleServerMessage({ type: "error", message: "model 404", code: "not_found" });
	} catch { /* side effects not under test */ }
};
// Drive the production `case "agent_end"` in handleAgentEvent. Same caveat.
(window as any).__triggerAgentEnd = (ra: any) => {
	try {
		ra.handleAgentEvent({ type: "agent_end" });
	} catch { /* side effects not under test; settle must already have applied */ }
};
(window as any).__ready = true;
