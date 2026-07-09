import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-seq-overflow.spec.ts (v2-dom tier).
// Drives the REAL RemoteAgent.handleServerMessage seq gate (was an esbuild
// file:// bundle) with a stub transport, pinning that a _pendingEvents overflow
// re-baselines the seq gate (clears _seqInitialized) so the next live frame
// re-baselines instead of stalling forever. session-manager first (TDZ guard),
// safe-markdown-block pre-imported so lazy defines resolve during the test.
import { describe, expect, it } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";

function makeAgent() {
	const ra: any = new RemoteAgent();
	const sent: any[] = [];
	ra.send = (m: any) => sent.push(m); // stub transport — record frames, no real ws
	ra.__sent = sent;
	return ra;
}

const feed = async (ra: any, frame: any) => { await ra.handleServerMessage(frame); };
const seqState = (ra: any) => ({
	highestSeq: ra._highestSeq,
	seqInitialized: ra._seqInitialized,
	pending: ra._pendingEvents.length,
	getMessagesSent: ra.__sent.filter((m: any) => m?.type === "get_messages").length,
});

const ev = (seq: number) => ({
	type: "event",
	seq,
	ts: 0,
	data: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
});

describe("RemoteAgent pending-events overflow re-baseline", () => {
	it("overflow clears _seqInitialized and the next live frame re-baselines (no permanent stall)", async () => {
		const ra = makeAgent();
		const frames = {
			first: ev(1),
			gap: Array.from({ length: 501 }, (_, i) => ev(i + 3)), // seqs 3..503
			next: ev(504),
		};

		// Baseline on seq 1.
		await feed(ra, frames.first);
		// 501 out-of-order frames (gap at seq 2) → overflow the 500-cap buffer.
		for (const f of frames.gap) await feed(ra, f);
		const afterOverflow = seqState(ra);
		// A fresh live frame at a large seq AFTER the overflow.
		await feed(ra, frames.next);
		const afterNext = seqState(ra);

		// After overflow: re-baseline armed, snapshot requested.
		expect(afterOverflow.highestSeq).toBe(0);
		expect(afterOverflow.seqInitialized).toBe(false); // the S9 fix (true on master)
		expect(afterOverflow.getMessagesSent).toBeGreaterThan(0);

		// After the next frame: re-baselined to seq-1 and DISPATCHED (highestSeq=504),
		// not re-gap-buffered (which on master leaves highestSeq=0, pending>0).
		expect(afterNext.highestSeq).toBe(504);
		expect(afterNext.pending).toBe(0);
	});
});
