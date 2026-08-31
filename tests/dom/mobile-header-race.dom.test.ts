// Ported from tests/mobile-header-race.spec.ts (+ mobile-header-race.html)
// (v2-dom tier).
//
// The legacy spec drove a STANDALONE HTML fixture that reproduced the render
// race from src/app/render.ts: doRenderApp() branches on hasActiveSession(), and
// on mobile renders #app-header (with an optional goal-tab-bar) only when
// connected. It asserted the header is absent before connection, appears
// immediately after connect (the fix), shows the goal tab bar only for
// goal-assistant sessions, and re-renders correctly across the full connect
// lifecycle.
//
// The behaviour is pure DOM (innerHTML branching + class/attribute state); the
// only geometry the legacy read was the header's computed transform, which is a
// browser matrix() value — happy-dom returns the raw inline value, so we accept
// the at-rest forms. Following the v2-dom standalone-fixture convention (see
// dom/mobile-archived.test.ts) we reproduce the fixture's state + render + connect
// simulations and assert the same lifecycle behaviour.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function setInnerWidth(w: number) {
	try { (window as unknown as { innerWidth: number }).innerWidth = w; } catch { /* getter-only */ }
	if (window.innerWidth !== w) {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
	}
}

interface HeaderState {
	remoteAgent: { connected: boolean } | null;
	isGoalAssistantSession: boolean;
	goalAssistantTab: string;
	connectionStatus: string;
	chatPanel: unknown;
}

function mountHeaderFixture() {
	document.body.innerHTML = `<div id="app"></div>`;

	const state: HeaderState = {
		remoteAgent: null,
		isGoalAssistantSession: false,
		goalAssistantTab: "chat",
		connectionStatus: "disconnected",
		chatPanel: null,
	};

	function hasActiveSession() {
		return state.remoteAgent !== null && state.remoteAgent.connected;
	}
	function isDesktop() {
		return window.innerWidth >= 768;
	}

	let renderCount = 0;
	function doRenderApp() {
		renderCount++;
		const app = document.getElementById("app");
		if (!app) return;
		const connected = hasActiveSession();

		if (isDesktop()) {
			app.innerHTML = `<div class="app"><div>Desktop layout (connected=${connected})</div></div>`;
			return;
		}

		if (connected) {
			const goalTabBar = state.isGoalAssistantSession
				? `<div class="goal-tab-bar">
					<button class="goal-tab-pill ${state.goalAssistantTab === "chat" ? "goal-tab-pill--active" : ""}">Chat</button>
					<button class="goal-tab-pill ${state.goalAssistantTab === "preview" ? "goal-tab-pill--active" : ""}">Preview</button>
				</div>`
				: "";
			app.innerHTML = `
				<div class="app" data-mobile-header>
					<div id="app-header" class="header-visible" style="transform: translateY(0);">
						<div class="header-row"><span>&larr; Back</span><span>Session Title</span></div>
						${goalTabBar}
					</div>
					<div id="app-main"><div>Chat content here</div></div>
				</div>`;
		} else {
			app.innerHTML = `
				<div class="app">
					<div class="header-row"><span>Bobbit</span></div>
					<div class="landing-page"><span>Select or create a session</span></div>
				</div>`;
		}
	}

	// Mirrors the FIXED connectToSession flow in session-manager.ts.
	async function simulateConnect(opts?: { isGoalAssistant?: boolean; connectDelayMs?: number }) {
		const { isGoalAssistant, connectDelayMs } = opts || {};
		state.remoteAgent = null;
		state.isGoalAssistantSession = false;
		doRenderApp();
		await new Promise((r) => setTimeout(r, connectDelayMs || 10));
		state.remoteAgent = { connected: true };
		state.isGoalAssistantSession = !!isGoalAssistant;
		state.connectionStatus = "connected";
		doRenderApp(); // immediate render (the fix)
		await new Promise((r) => setTimeout(r, 5));
		doRenderApp(); // finally block render
	}

	// Mirrors the OLD (broken) flow: isGoalAssistantSession set LATE, before the
	// finally render — so the finally render still shows the tab bar.
	async function simulateConnectBroken(opts?: { isGoalAssistant?: boolean; connectDelayMs?: number }) {
		const { isGoalAssistant, connectDelayMs } = opts || {};
		state.remoteAgent = null;
		state.isGoalAssistantSession = false;
		doRenderApp();
		await new Promise((r) => setTimeout(r, connectDelayMs || 10));
		state.remoteAgent = { connected: true };
		state.connectionStatus = "connected";
		await new Promise((r) => setTimeout(r, 5));
		state.isGoalAssistantSession = !!isGoalAssistant;
		doRenderApp();
	}

	doRenderApp(); // initial render (disconnected)

	return {
		state,
		doRenderApp,
		simulateConnect,
		simulateConnectBroken,
		getRenderCount: () => renderCount,
		resetRenderCount: () => { renderCount = 0; },
	};
}

const $ = (sel: string) => document.querySelector(sel);
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));
function headerAtRest(): boolean {
	const header = document.getElementById("app-header");
	if (!header) return false;
	const t = header.style.transform || getComputedStyle(header).transform;
	return t === "none" || t === "" || /translateY\(0\)/.test(t) || t.endsWith(", 0)");
}

describe("Mobile header render race", () => {
	beforeEach(() => setInnerWidth(375)); // iPhone SE width — mobile layout
	afterEach(() => { document.body.innerHTML = ""; });

	it("header is absent before connection", () => {
		mountHeaderFixture();
		expect($("#app-header")).toBeNull();
		expect($(".landing-page")).not.toBeNull();
	});

	it("header appears immediately after connection (fixed flow)", async () => {
		const fx = mountHeaderFixture();
		expect($("#app-header")).toBeNull();
		await fx.simulateConnect();
		expect($("#app-header")).not.toBeNull();
		expect(headerAtRest()).toBe(true);
	});

	it("goal assistant tab bar appears for goal assistant sessions", async () => {
		const fx = mountHeaderFixture();
		await fx.simulateConnect({ isGoalAssistant: true });
		expect($("#app-header")).not.toBeNull();
		expect($(".goal-tab-bar")).not.toBeNull();
		const tabs = $$(".goal-tab-pill");
		expect(tabs).toHaveLength(2);
		expect(tabs[0].textContent?.trim()).toBe("Chat");
		expect(tabs[1].textContent?.trim()).toBe("Preview");
	});

	it("no goal tab bar for regular sessions", async () => {
		const fx = mountHeaderFixture();
		await fx.simulateConnect({ isGoalAssistant: false });
		expect($("#app-header")).not.toBeNull();
		expect($(".goal-tab-bar")).toBeNull();
	});

	it("header renders with correct state after full connect lifecycle", async () => {
		const fx = mountHeaderFixture();
		fx.resetRenderCount();
		await fx.simulateConnect();
		// Disconnected render + immediate post-connect render + finally render.
		expect(fx.getRenderCount()).toBeGreaterThanOrEqual(3);
		expect($("#app-header")).not.toBeNull();
	});

	it("broken flow: header eventually appears and goal tab bar is present after finally", async () => {
		const fx = mountHeaderFixture();
		await fx.simulateConnectBroken({ isGoalAssistant: true });
		expect($("#app-header")).not.toBeNull();
		// The finally render happens after isGoalAssistant is set, so the tab bar is present.
		expect($(".goal-tab-bar")).not.toBeNull();
	});

	it("transition from disconnected to connected re-renders correctly", async () => {
		const fx = mountHeaderFixture();
		expect($(".landing-page")).not.toBeNull();

		await fx.simulateConnect();
		expect($("#app-header")).not.toBeNull();
		expect($(".landing-page")).toBeNull();

		// Disconnect.
		fx.state.remoteAgent = null;
		fx.state.connectionStatus = "disconnected";
		fx.doRenderApp();
		expect($("#app-header")).toBeNull();
		expect($(".landing-page")).not.toBeNull();

		// Reconnect as goal assistant.
		await fx.simulateConnect({ isGoalAssistant: true });
		expect($("#app-header")).not.toBeNull();
		expect($(".goal-tab-bar")).not.toBeNull();
	});
});
