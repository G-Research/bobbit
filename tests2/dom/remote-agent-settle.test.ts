import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-settle.spec.ts (v2-dom tier).
// Drives the REAL RemoteAgent turn-termination handlers (`case "error"` in
// handleServerMessage and `case "agent_end"` in handleAgentEvent) with a stub
// transport (no real socket), pinning that an unreconciled optimistic prompt is
// SETTLED out of the far-future tail sentinel on both paths. Was an esbuild
// file:// bundle. session-manager is imported first (TDZ guard) and
// safe-markdown-block pre-imported so lazy defines resolve during the test.
import { afterEach, describe, expect, it } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";

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
	document.documentElement.dataset.playAgentFinishSound = "false";
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

// Drive the production `case "error"` in handleServerMessage. Downstream side
// effects (notification append, emit) are NOT under test; swallow any throw so
// the assertion sees the post-settle reducer state.
async function triggerError(ra: any) {
	try {
		await ra.handleServerMessage({ type: "error", message: "model 404", code: "not_found" });
	} catch { /* side effects not under test */ }
}
// Drive the production `case "agent_end"` in handleAgentEvent. Same caveat.
function triggerAgentEnd(ra: any) {
	try {
		ra.handleAgentEvent({ type: "agent_end" });
	} catch { /* side effects not under test; settle must already have applied */ }
}

afterEach(() => {
	delete document.documentElement.dataset.playAgentFinishSound;
});

describe("RemoteAgent settles optimistic rows on turn termination", () => {
	it("error handler settles an unreconciled optimistic prompt out of the tail sentinel", async () => {
		const ra = makeAgent();
		seedOptimistic(ra, "optimistic_err", "hello");
		const before = optimisticRows(ra);
		await triggerError(ra);
		const after = optimisticRows(ra);

		// Seeded at the far-future tail sentinel.
		expect(before).toHaveLength(1);
		expect(before[0].order).toBeGreaterThan(OPTIMISTIC_SENTINEL_FLOOR);
		// After the error turn ends: still present (visible) AND settled below the sentinel.
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe("optimistic_err");
		expect(after[0].order).toBeLessThan(OPTIMISTIC_SENTINEL_FLOOR);
	});

	it("agent_end handler settles an unreconciled optimistic prompt out of the tail sentinel", () => {
		const ra = makeAgent();
		seedOptimistic(ra, "optimistic_end", "hello");
		const before = optimisticRows(ra);
		triggerAgentEnd(ra);
		const after = optimisticRows(ra);

		expect(before).toHaveLength(1);
		expect(before[0].order).toBeGreaterThan(OPTIMISTIC_SENTINEL_FLOOR);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe("optimistic_end");
		expect(after[0].order).toBeLessThan(OPTIMISTIC_SENTINEL_FLOOR);
	});
});
