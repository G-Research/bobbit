import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgent } from "../../src/app/remote-agent.js";
import type { ChatPanel } from "../../src/ui/ChatPanel.js";
import { backToSessions, uncacheSession } from "../../src/app/session-manager.js";
import { GW_SESSION_KEY, GW_URL_KEY, setRenderApp, state } from "../../src/app/state.js";

const SESSION_ID = "portrait-cache-session";

class MockRemoteAgent {
	connected = true;
	gatewaySessionId = SESSION_ID;
	disconnect = vi.fn();
}

class MockChatPanel {
	agent: MockRemoteAgent;
	agentInterface: { session: MockRemoteAgent };
	classList = { add: vi.fn(), remove: vi.fn() };

	constructor(agent: MockRemoteAgent) {
		this.agent = agent;
		this.agentInterface = { session: agent };
	}
}

function responseFor(input: RequestInfo | URL): Response {
	const path = new URL(String(input), "http://localhost").pathname;
	if (path === "/api/projects") return Response.json({ projects: [] });
	return Response.json({ changed: false });
}

beforeEach(() => {
	setRenderApp(() => {});
	vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(responseFor(input))));
	localStorage.setItem(GW_URL_KEY, "http://localhost");
	localStorage.setItem(GW_SESSION_KEY, SESSION_ID);
	state.sessionsGeneration = 1;
	state.goalsGeneration = 1;
	state.gatewaySessions = [];
	state.goals = [];
	state.projects = [];
	state.selectedSessionId = null;
	state.chatPanel = null;
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
});

afterEach(() => {
	uncacheSession(SESSION_ID);
	state.selectedSessionId = null;
	state.chatPanel = null;
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	setRenderApp(() => {});
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("portrait session-list cache ownership", () => {
	it("transfers a matching connected panel and agent to the session cache", () => {
		const outgoingAgent = new MockRemoteAgent();
		const outgoingPanel = new MockChatPanel(outgoingAgent);
		state.selectedSessionId = SESSION_ID;
		state.chatPanel = outgoingPanel as unknown as ChatPanel;
		state.remoteAgent = outgoingAgent as unknown as RemoteAgent;
		state.connectionStatus = "connected";

		backToSessions();

		expect(
			outgoingAgent.disconnect,
			"PORTRAIT_SESSION_CACHE_MISS: backToSessions disconnected the matching connected outgoing session instead of caching it",
		).not.toHaveBeenCalled();
		expect(state.selectedSessionId).toBeNull();
		expect(state.chatPanel).toBeNull();
		expect(state.remoteAgent).toBeNull();

		// The cache is module-private; explicit eviction proves the exact outgoing
		// agent was admitted without exposing a test-only production hook.
		uncacheSession(SESSION_ID);
		expect(outgoingAgent.disconnect).toHaveBeenCalledOnce();
	});
});
