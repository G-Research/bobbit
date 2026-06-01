// Test entry — bundles the REAL RemoteAgent so a test can drive the production
// handleServerMessage seq gate (WP0 seq harness; pins S9 overflow re-baseline).
// This replaces the hand-copied HTML fixture that omitted the overflow branch.
import { RemoteAgent } from "../../src/app/remote-agent.js";

function makeAgent() {
	const ra: any = new RemoteAgent();
	const sent: any[] = [];
	ra.send = (m: any) => sent.push(m); // stub transport — record frames, no real ws
	ra.__sent = sent;
	return ra;
}

(window as any).__makeAgent = makeAgent;
(window as any).__feed = async (ra: any, frame: any) => { await ra.handleServerMessage(frame); };
(window as any).__seqState = (ra: any) => ({
	highestSeq: ra._highestSeq,
	seqInitialized: ra._seqInitialized,
	pending: ra._pendingEvents.length,
	getMessagesSent: ra.__sent.filter((m: any) => m?.type === "get_messages").length,
});
(window as any).__ready = true;
