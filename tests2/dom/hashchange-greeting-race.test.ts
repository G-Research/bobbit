// Migrated from tests/hashchange-greeting-race.spec.ts (v2-dom tier).
// The legacy spec loaded a self-contained file:// fixture that SIMULATES the
// src/app main.ts ⇄ session-manager.ts hashchange/connect race (the real
// functions are not isolatable — they are wired into the whole app bootstrap).
// The fixture embeds the FIXED handleHashChange guard and asserts the post-fix
// behavior. We port that exact simulation into happy-dom (which fires real
// hashchange events on location.hash assignment) and assert the same facts:
// the assistant greeting fires, and the fixed guard suppresses the duplicate
// connectToSession that hashchange would otherwise trigger while connecting.
import { afterEach, describe, expect, it } from "vitest";

interface RaceResult {
	greetingSent: boolean;
	greetingMessage: string | null;
	connectCalls: number;
	handleHashChangeCalls: number;
	finalSessionId: string | null;
	remoteAgentSession: string | null;
}

function makeSimulation() {
	const state: any = {
		selectedSessionId: null as string | null,
		connectingSessionId: null as string | null,
		remoteAgent: null as { gatewaySessionId: string } | null,
		switchGeneration: 0,
		connectionStatus: "disconnected",
		appView: "authenticated",
	};

	const tracking = {
		greetingSent: false,
		greetingMessage: null as string | null,
		connectCalls: [] as any[],
		handleHashChangeCalls: 0,
	};

	function getRouteFromHash(): { view: string; sessionId?: string } {
		const match = window.location.hash.match(/^#\/session\/(.+)$/);
		if (match) return { view: "session", sessionId: match[1] };
		return { view: "landing" };
	}

	function selectSession(sessionId: string) {
		state.switchGeneration++;
		state.selectedSessionId = sessionId;
		window.location.hash = `#/session/${sessionId}`;
	}

	let handlingHashChange = false;
	async function handleHashChange() {
		if (handlingHashChange) return;
		handlingHashChange = true;
		try {
			const route = getRouteFromHash();
			if (route.view === "session" && route.sessionId) {
				// FIX: bail if the session is already selected or currently connecting.
				if (state.selectedSessionId === route.sessionId || state.connectingSessionId === route.sessionId) return;
				if (state.remoteAgent?.gatewaySessionId === route.sessionId) return;
				tracking.handleHashChangeCalls++;
				await connectToSession(route.sessionId, true);
			}
		} finally {
			handlingHashChange = false;
		}
	}

	async function connectToSession(sessionId: string, isExisting: boolean, options?: { assistantType?: string }) {
		tracking.connectCalls.push({ sessionId, isExisting, assistantType: options?.assistantType || null });
		selectSession(sessionId);
		const gen = state.switchGeneration;
		const isStale = () => state.switchGeneration !== gen;
		state.connectingSessionId = sessionId;
		try {
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (isStale()) return;
			state.remoteAgent = { gatewaySessionId: sessionId };
			state.connectionStatus = "connected";
			if (options?.assistantType && !isExisting) {
				tracking.greetingSent = true;
				tracking.greetingMessage = `Start the ${options.assistantType} creation session.`;
			}
		} finally {
			if (state.connectingSessionId === sessionId) state.connectingSessionId = null;
		}
	}

	window.addEventListener("hashchange", handleHashChange);

	async function simulateRace(sessionId: string, assistantType: string): Promise<RaceResult> {
		window.location.hash = "";
		await connectToSession(sessionId, false, { assistantType });
		await new Promise((resolve) => setTimeout(resolve, 50));
		return {
			greetingSent: tracking.greetingSent,
			greetingMessage: tracking.greetingMessage,
			connectCalls: tracking.connectCalls.length,
			handleHashChangeCalls: tracking.handleHashChangeCalls,
			finalSessionId: state.selectedSessionId,
			remoteAgentSession: state.remoteAgent?.gatewaySessionId || null,
		};
	}

	const dispose = () => window.removeEventListener("hashchange", handleHashChange);
	return { simulateRace, dispose };
}

let sim: ReturnType<typeof makeSimulation> | null = null;
afterEach(() => { sim?.dispose(); sim = null; window.location.hash = ""; });

describe("Hashchange greeting race condition", () => {
	it("greeting fires when connectToSession races with hashchange", async () => {
		sim = makeSimulation();
		const result = await sim.simulateRace("sess-1", "goal");
		expect(result.greetingSent).toBe(true);
		expect(result.greetingMessage).toContain("goal");
	});

	it("handleHashChange does not fire a duplicate connectToSession during connecting", async () => {
		sim = makeSimulation();
		const result = await sim.simulateRace("sess-1", "goal");
		// After the fix, handleHashChange bails (selectedSessionId matches), so no
		// duplicate connect is issued.
		expect(result.handleHashChangeCalls).toBe(0);
	});
});
