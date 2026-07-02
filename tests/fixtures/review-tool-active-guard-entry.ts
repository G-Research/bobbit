// Test entry — bundles RemoteAgent for the review-tool active-guard fixture.
//
// Regression coverage: when an agent in a *background/cached* session emits a
// `review_open` (or `review_close`) tool result, its `_checkReviewToolResult`
// must NOT mutate the globally-shared `state.review*` fields (which would
// land on whichever session the user is currently viewing).
//
// We can't easily construct a real connected RemoteAgent in a file:// fixture,
// so we instantiate two and drive `_checkReviewToolResult` directly with
// synthetic tool-result messages. `state.selectedSessionId` is the canonical
// "active session" pointer (set synchronously in selectSession before any
// agent connects) — the production code under test must consult it before
// mutating global review state.

import { RemoteAgent } from "../../src/app/remote-agent.js";
import { state } from "../../src/app/state.js";

(window as any).__state = state;
(window as any).__makeAgent = (sessionId: string) => {
	const a = new RemoteAgent();
	// _sessionId is private; assign for test purposes so the production code
	// path that consults it (e.g. localStorage.removeItem keying) is exercised.
	(a as any)._sessionId = sessionId;
	return a;
};
(window as any).__setActive = (a: any) => {
	state.remoteAgent = a;
	state.selectedSessionId = (a as any)._sessionId;
};
(window as any).__clearReviewState = () => {
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
};
(window as any).__getReviewState = () => ({
	open: state.reviewPanelOpen,
	activeTab: state.reviewActiveTab,
	docCount: state.reviewDocuments.size,
	docTitles: [...state.reviewDocuments.keys()],
});
(window as any).__deliverReviewToolResult = async (a: any, action: string, payload: any, isLive = true, shape = "json-text") => {
	// Build live tool-result-shaped messages. Replays only reopen when the server
	// workspace already has a matching review tab.
	const envelope = { action, ...payload };
	const json = JSON.stringify(envelope);
	const content = shape === "structured"
		? [{ type: "text", text: "(tool ack)" }, envelope]
		: shape === "nested-tool-result"
			? [{ type: "tool_result", content: [{ type: "text", text: "(tool ack)" }, envelope] }]
			: [{ type: "text", text: "(tool ack)" }, { type: "text", text: json }];
	const msg = { role: "toolResult", content };
	await (a as any)._checkReviewToolResult(msg, isLive);
};

(window as any).__ready = true;
