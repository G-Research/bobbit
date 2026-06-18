import { html, render } from "lit";
import { state } from "../../src/app/state.js";
import "../../src/ui/components/GoalStatusWidget.js";

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = MockWebSocket.OPEN;
	sent: string[] = [];
	constructor(public url: string) {
		super();
		setTimeout(() => this.dispatchEvent(new Event("open")), 0);
	}
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = MockWebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
}

(globalThis as any).WebSocket = MockWebSocket;

const calls: Array<{ url: string; method: string; body?: string }> = [];
let gateRows: any[] = [];
let activeVerifications: any[] = [];
let signalsByGate = new Map<string, any[]>();

function jsonResponse(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

window.fetch = async (url: any, init: any = {}) => {
	const textUrl = String(url);
	const method = init?.method || "GET";
	calls.push({ url: textUrl, method, body: init?.body });
	if (/\/gates\/[^/]+\/signals/.test(textUrl)) {
		const gateId = decodeURIComponent(textUrl.match(/\/gates\/([^/]+)\/signals/)?.[1] || "");
		return jsonResponse({ signals: signalsByGate.get(gateId) || [] });
	}
	if (textUrl.endsWith("/verifications/active")) return jsonResponse({ verifications: activeVerifications });
	if (textUrl.endsWith("/gates")) return jsonResponse({ gates: gateRows });
	if (/\/reset$/.test(textUrl) || /\/bypass$/.test(textUrl)) return jsonResponse({ ok: true });
	return jsonResponse({ ok: true });
};

(window as any).__goalStatusCalls = () => [...calls];
(window as any).__openReviewEvents = [];
window.addEventListener("bobbit-open-review-document", (event) => {
	(window as any).__openReviewEvents.push((event as CustomEvent).detail);
});

(window as any).__mountGoalStatusWidget = async (fixture: {
	goalId: string;
	gates: any[];
	verifications?: any[];
	signals?: Record<string, any[]>;
	cache?: { passed: number; total: number; bypassed?: number; verifying?: boolean; verifyingCount?: number };
	goalState?: string;
}) => {
	calls.length = 0;
	(window as any).__openReviewEvents.length = 0;
	gateRows = fixture.gates;
	activeVerifications = fixture.verifications || [];
	signalsByGate = new Map(Object.entries(fixture.signals || {}));
	state.gateStatusCache.clear();
	state.gatewaySessions = [] as any;
	// Keep workflow.gates empty so scheduleGateStatusRefreshForGoal() is a no-op in
	// this isolated component fixture; the widget's own mocked /gates response still
	// drives its row rendering, while the explicit cache below drives the badge.
	state.goals = [{ id: fixture.goalId, title: "Fixture Goal", state: fixture.goalState || "in-progress", workflow: { gates: [] } }] as any;
	if (fixture.cache) state.gateStatusCache.set(fixture.goalId, fixture.cache as any);
	const container = document.getElementById("container")!;
	render(html`<goal-status-widget goalId=${fixture.goalId} token="test-token" branch="fixture/branch"></goal-status-widget>`, container);
	await customElements.whenDefined("goal-status-widget");
	await new Promise((resolve) => setTimeout(resolve, 20));
};

(window as any).__ready = true;
