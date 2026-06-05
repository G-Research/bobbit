// Test entry — bundles the REAL RemoteAgent to drive the S2 send-outbox through
// the production send()/getQueue()/_flushOutbox() with a fake WebSocket whose
// readyState the test controls.
import { RemoteAgent } from "../../src/app/remote-agent.js";

function makeAgent(readyState: number) {
	const ra: any = new RemoteAgent();
	const sentFrames: string[] = [];
	ra.ws = { readyState, send: (s: string) => sentFrames.push(s) };
	ra.__sentFrames = sentFrames;
	ra.__queueUpdates = [];
	ra.onQueueUpdate = (q: any) => ra.__queueUpdates.push(q);
	return ra;
}

(window as any).__OPEN = 1;
(window as any).__CLOSED = 3;
(window as any).__makeAgent = makeAgent;
(window as any).__setReadyState = (ra: any, rs: number) => { ra.ws.readyState = rs; };
(window as any).__flush = (ra: any) => ra._flushOutbox();
(window as any).__snapshot = (ra: any) => ({
	outboxLen: ra._pendingOutbox.length,
	sent: ra.__sentFrames.map((s: string) => JSON.parse(s)),
	queue: ra.getQueue(),
	messages: ra._state.messages.length,
	queueUpdateCount: ra.__queueUpdates.length,
});
(window as any).__ready = true;
