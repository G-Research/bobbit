import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/stale-session-selection.spec.ts (v2-dom tier).
// The legacy fixture copied activeSessionId() + the hashchange cleanup branches
// verbatim in plain JS. This port drives the REAL activeSessionId() from
// src/app/state.ts against the real `state` singleton and the window hash
// (config-page suppression flows through the real isConfigPageRoute()).
// The navigation helpers reproduce the exact state mutations src/app/main.ts's
// hashchange handler performs for each route branch.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { state, activeSessionId } from "../../src/app/state.js";

type RemoteAgent = typeof state.remoteAgent;

let saved: {
	sel: string | null;
	conn: string | null;
	remote: RemoteAgent;
	status: typeof state.connectionStatus;
};

beforeEach(() => {
	saved = {
		sel: state.selectedSessionId,
		conn: state.connectingSessionId,
		remote: state.remoteAgent,
		status: state.connectionStatus,
	};
});

afterEach(() => {
	state.selectedSessionId = saved.sel;
	state.connectingSessionId = saved.conn;
	state.remoteAgent = saved.remote;
	state.connectionStatus = saved.status;
	window.location.hash = "";
});

// ── Route + cleanup simulators (mirror src/app/main.ts hashchange branches) ──
function simulateConnectToSession(sessionId: string) {
	window.location.hash = `#/session/${sessionId}`;
	state.selectedSessionId = sessionId;
	state.connectingSessionId = null;
	state.remoteAgent = { gatewaySessionId: sessionId, connected: true } as unknown as RemoteAgent;
	state.connectionStatus = "connected";
}

function disconnect() {
	if (state.remoteAgent) {
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
	}
}

function simulateNavigateToGoalView(goalId: string) {
	window.location.hash = `#/goal/${goalId}`;
	disconnect();
	state.selectedSessionId = null;
}

function simulateNavigateToGoalDashboard(goalId: string) {
	window.location.hash = `#/goal/${goalId}/agents`;
	disconnect();
	state.selectedSessionId = null;
}

function simulateNavigateToLanding() {
	window.location.hash = "#/";
	disconnect();
	state.selectedSessionId = null;
}

function simulateNavigateToConfigPage(view: string) {
	window.location.hash = `#/${view}`;
	disconnect();
	// NOTE: mirrors main.ts — config-page cleanup does NOT clear selectedSessionId;
	// suppression is handled by isConfigPageRoute() inside activeSessionId().
}

function simulateBackToSessions() {
	window.location.hash = "#/";
	state.selectedSessionId = null;
	disconnect();
}

describe("Stale selectedSessionId bug", () => {
	it("activeSessionId should be undefined after navigating to goal view", () => {
		simulateConnectToSession("session-123");
		expect(activeSessionId()).toBe("session-123");

		simulateNavigateToGoalView("goal-abc");
		expect(state.remoteAgent).toBeNull();
		expect(activeSessionId()).toBeUndefined();
	});

	it("activeSessionId should be undefined after navigating to goal dashboard", () => {
		simulateConnectToSession("session-456");
		expect(activeSessionId()).toBe("session-456");

		simulateNavigateToGoalDashboard("goal-xyz");
		expect(state.remoteAgent).toBeNull();
		expect(activeSessionId()).toBeUndefined();
	});

	it("activeSessionId should be undefined after navigating to landing", () => {
		simulateConnectToSession("session-789");
		expect(activeSessionId()).toBe("session-789");

		simulateNavigateToLanding();
		expect(state.remoteAgent).toBeNull();
		expect(activeSessionId()).toBeUndefined();
	});

	it("backToSessions correctly clears selectedSessionId (reference behavior)", () => {
		simulateConnectToSession("session-aaa");
		expect(activeSessionId()).toBe("session-aaa");

		simulateBackToSessions();
		expect(activeSessionId()).toBeUndefined();
	});

	it("config page navigation returns undefined (already working)", () => {
		simulateConnectToSession("session-bbb");
		expect(activeSessionId()).toBe("session-bbb");

		// Navigate to a config page — isConfigPageRoute() makes activeSessionId return undefined
		simulateNavigateToConfigPage("roles");
		expect(activeSessionId()).toBeUndefined();
	});

	it("normal session switching works correctly", () => {
		simulateConnectToSession("session-A");
		expect(activeSessionId()).toBe("session-A");

		simulateConnectToSession("session-B");
		expect(activeSessionId()).toBe("session-B");

		simulateConnectToSession("session-A");
		expect(activeSessionId()).toBe("session-A");
	});
});
