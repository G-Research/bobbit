// Test entry — bundles the REAL RemoteAgent to drive the S2 send-outbox through
// the production send()/getQueue()/_flushOutbox() with a fake WebSocket whose
// readyState the test controls.
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { setRenderApp, state } from "../../src/app/state.js";

let renderCount = 0;
setRenderApp(() => { renderCount++; });

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
(window as any).__event = (ra: any, event: any) => ra.handleAgentEvent(event);
(window as any).__serverMessage = async (ra: any, msg: any) => { await ra.handleServerMessage(msg); };
(window as any).__setHeadquartersVisibleState = (visible: boolean) => { state.showHeadquartersInProjectLists = visible; };
(window as any).__getHeadquartersVisibleState = () => state.showHeadquartersInProjectLists;
(window as any).__resetRenderCount = () => { renderCount = 0; };
(window as any).__renderCount = () => renderCount;
(window as any).__nextRenderFrame = () => new Promise<void>((resolve) => {
	requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});
(window as any).__snapshot = (ra: any) => ({
	outboxLen: ra._pendingOutbox.length,
	sent: ra.__sentFrames.map((s: string) => JSON.parse(s)),
	queue: ra.getQueue(),
	messages: ra._state.messages.length,
	providerAuthRequired: ra._state.providerAuthRequired,
	autoRetryPending: ra._state.autoRetryPending,
	queueUpdateCount: ra.__queueUpdates.length,
});
(window as any).__ready = true;
