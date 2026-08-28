import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Mobile side-panel pane retention (docs/design/keep-side-panels-mounted.md §3.7).
//
// Acceptance criteria 10–13. The mobile slider keeps ONE track per session:
// append-only, exactly one visible, hidden tracks inert. Within a track the DOM
// order is append-only and the VISUAL order is CSS `order`, so a tab close or
// reorder repaints without moving a node — moving an <iframe> reloads it.
//
// IFRAME IDENTITY: see the header comment in side-panel-pane-retention.test.ts.
// happy-dom cannot execute a pack panel's Blob-URL ESM import, so the single
// projection chokepoint `renderPackPanelContent` is stubbed with a template
// that emits one `<iframe src>` per pack tab. Identity is asserted by holding
// the element reference (`===`) and by a MutationObserver on
// `attributes: ["src"]` that must record ZERO mutations.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";

vi.mock("../../src/app/pack-panels.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/app/pack-panels.js")>();
	return {
		...actual,
		renderPackPanelContent: (packId: string, panelId: string, _params?: Record<string, unknown>, boundSessionId?: string) =>
			html`<iframe
				data-testid="stub-pack-iframe"
				data-pack-id=${packId}
				data-panel-id=${panelId}
				src=${`about:blank#${packId}/${panelId}?session=${boundSessionId ?? ""}`}
			></iframe>`,
	};
});

type StateModule = typeof import("../../src/app/state.js");
type RenderModule = typeof import("../../src/app/render.js");
type PanelWorkspaceModule = typeof import("../../src/app/panel-workspace.js");
type RetentionModule = typeof import("../../src/app/panel-pane-retention.js");

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let doRenderApp!: RenderModule["doRenderApp"];
let packPanelTabId!: PanelWorkspaceModule["packPanelTabId"];
let setPanelTabsForSession!: PanelWorkspaceModule["setPanelTabsForSession"];
let setActivePanelTabIdForSession!: PanelWorkspaceModule["setActivePanelTabIdForSession"];
let resetPanelPaneRetention!: RetentionModule["resetPanelPaneRetention"];
let PANEL_PANE_RETENTION_LIMIT!: RetentionModule["PANEL_PANE_RETENTION_LIMIT"];

const MOBILE_WIDTH = 390;

function setViewportWidth(width: number): void {
	(window as any).innerWidth = width;
	window.dispatchEvent(new Event("resize"));
}

function renderOnce(): void {
	doRenderApp();
}

function packTab(packId: string, panelId: string, sessionId: string) {
	return {
		id: packPanelTabId(packId, panelId, "default"),
		kind: "pack" as const,
		title: panelId,
		label: panelId,
		source: { type: "pack" as const, packId, panelId, sessionId },
	};
}

function installSession(sessionId: string, tabs: any[], activeTabId?: string): void {
	if (!state.gatewaySessions.some((session) => session.id === sessionId)) {
		state.gatewaySessions = [...state.gatewaySessions, { id: sessionId, title: sessionId } as any];
	}
	(state as any).sidePanelWorkspaceBySession[sessionId] = {
		version: 1,
		tabs,
		activeTabId: activeTabId ?? tabs[0]?.id ?? "",
		sizeMode: "split",
	};
	setPanelTabsForSession(state, sessionId, tabs as any);
	if (activeTabId ?? tabs[0]?.id) setActivePanelTabIdForSession(state, sessionId, activeTabId ?? tabs[0].id);
}

function setTabs(sessionId: string, tabs: any[], activeTabId?: string): void {
	(state as any).sidePanelWorkspaceBySession[sessionId] = {
		version: 1,
		tabs,
		activeTabId: activeTabId ?? tabs[0]?.id ?? "",
		sizeMode: "split",
	};
	setPanelTabsForSession(state, sessionId, tabs as any);
	setActivePanelTabIdForSession(state, sessionId, activeTabId ?? tabs[0]?.id ?? "");
}

function chatPanelStub(): HTMLElement {
	const el = document.createElement("div");
	el.setAttribute("data-testid", "chat-panel-stub");
	return el;
}

function selectSession(sessionId: string): void {
	(state as any).selectedSessionId = sessionId;
	(state as any).connectingSessionId = null;
	(state as any).remoteAgent = { gatewaySessionId: sessionId, title: sessionId, state: {} } as any;
	if (!(state as any).chatPanel) (state as any).chatPanel = chatPanelStub();
}

/** The realistic COLD session switch (`connectToSession` → `selectSession` slow
 *  path): the outgoing agent + chat panel are transferred to the session cache
 *  and cleared, and `connectingSessionId` is set for a target that is not cached.
 *  `hasActiveSession()` is therefore FALSE for this frame. */
function beginColdSwitch(sessionId: string): void {
	(state as any).selectedSessionId = sessionId;
	(state as any).remoteAgent = null;
	(state as any).chatPanel = null;
	(state as any).connectingSessionId = sessionId;
}

const tracks = () => [...document.querySelectorAll<HTMLElement>("[data-mobile-pane-track]")];
const trackFor = (sessionKey: string) => document.querySelector<HTMLElement>(`[data-mobile-pane-track][data-mobile-track-session-key="${sessionKey}"]`);
const activeTrack = () => document.querySelector<HTMLElement>('[data-mobile-pane-track][data-mobile-track-active="true"]');
const paneKeysIn = (track: HTMLElement) => [...track.querySelectorAll<HTMLElement>("[data-mobile-pane-key]")].map((pane) => pane.dataset.mobilePaneKey ?? "");
const paneIn = (track: HTMLElement, key: string) => track.querySelector<HTMLElement>(`[data-mobile-pane-key="${key}"]`);
const iframeIn = (track: HTMLElement, key: string) => paneIn(track, key)?.querySelector<HTMLIFrameElement>("iframe") ?? null;
const orderOf = (pane: HTMLElement) => pane.style.order;

function watchSrc(iframe: HTMLIFrameElement): { count: () => number; stop: () => void } {
	let count = 0;
	const observer = new MutationObserver((records) => {
		for (const record of records) if (record.attributeName === "src") count += 1;
	});
	observer.observe(iframe, { attributes: true, attributeFilter: ["src"] });
	return {
		count: () => {
			for (const record of observer.takeRecords()) if (record.attributeName === "src") count += 1;
			return count;
		},
		stop: () => observer.disconnect(),
	};
}

/** `unifiedSlideX` is not exported; mirror its (trivial) contract. */
function expectedSlideX(index: number, count: number): number {
	return count <= 1 ? 0 : -(index * 100) / count;
}

beforeAll(async () => {
	(window as any).happyDOM?.setURL?.("file:///test.html");
	localStorage.setItem("gateway.url", "http://localhost");
	await import("../../src/app/session-manager.js");
	const stateMod = await import("../../src/app/state.js");
	const renderMod = await import("../../src/app/render.js");
	const panelMod = await import("../../src/app/panel-workspace.js");
	const retentionMod = await import("../../src/app/panel-pane-retention.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	doRenderApp = renderMod.doRenderApp;
	packPanelTabId = panelMod.packPanelTabId;
	setPanelTabsForSession = panelMod.setPanelTabsForSession;
	setActivePanelTabIdForSession = panelMod.setActivePanelTabIdForSession;
	resetPanelPaneRetention = retentionMod.resetPanelPaneRetention;
	PANEL_PANE_RETENTION_LIMIT = retentionMod.PANEL_PANE_RETENTION_LIMIT;
	__syncCE();
});

beforeEach(() => {
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
	document.body.innerHTML = `<div id="app"></div>`;
	setViewportWidth(MOBILE_WIDTH);
	resetPanelPaneRetention();
	state.gatewaySessions = [];
	state.archivedSessions = [];
	(state as any).sidePanelWorkspaceBySession = {};
	(state as any).panelTabsBySession = {};
	(state as any).panelWorkspaceActiveBySession = {};
	(state as any).selectedSessionId = null;
	(state as any).remoteAgent = null;
	(state as any).connectingSessionId = null;
	(state as any).creatingSession = false;
	(state as any).appView = "authenticated";
	(state as any).chatPanel = chatPanelStub();
	setRenderApp(() => {});
	// Settle the viewport-flip guard at mobile width before any assertion render,
	// and clear the per-track append-only DOM order it resets.
	renderOnce();
});

afterEach(() => {
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

const CHAT_PANE_KEY = "__mobile_chat_pane__";

describe("mobile side-panel pane retention", () => {
	it("self-check: the src observer actually fires on a real src mutation", () => {
		const tab = packTab("demo_pack", "a.panel", "sA");
		installSession("sA", [tab]);
		selectSession("sA");
		renderOnce();
		const frame = iframeIn(trackFor("sA")!, tab.id)!;
		const watch = watchSrc(frame);
		expect(watch.count()).toBe(0);
		frame.setAttribute("src", "about:blank#changed");
		expect(watch.count()).toBe(1);
		watch.stop();
	});

	it("A(pack) → B(pack) → A keeps both tracks with exactly one visible (criterion 10)", () => {
		const tabA = packTab("demo_pack", "a.panel", "sA");
		const tabB = packTab("demo_pack", "b.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);

		selectSession("sA");
		renderOnce();
		const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
		expect(frameA).toBeTruthy();
		const watchA = watchSrc(frameA);

		selectSession("sB");
		renderOnce();
		expect(tracks()).toHaveLength(2);
		expect(activeTrack()!.dataset.mobileTrackSessionKey).toBe("sB");
		const hiddenA = trackFor("sA")!;
		expect(hiddenA.style.display).toBe("none");
		expect(hiddenA.hasAttribute("hidden")).toBe(true);
		expect(hiddenA.hasAttribute("inert")).toBe(true);
		expect(hiddenA.getAttribute("aria-hidden")).toBe("true");
		// A hidden foreign track holds only its retained pack panes — never the
		// chat pane, which is a single element instance.
		expect(paneKeysIn(hiddenA)).toEqual([tabA.id]);
		expect(iframeIn(hiddenA, tabA.id)).toBe(frameA);

		selectSession("sA");
		renderOnce();
		const restoredA = trackFor("sA")!;
		expect(restoredA.dataset.mobileTrackActive).toBe("true");
		expect(iframeIn(restoredA, tabA.id)).toBe(frameA);
		expect(tracks().filter((track) => track.dataset.mobileTrackActive === "true")).toHaveLength(1);
		expect(watchA.count()).toBe(0);
		watchA.stop();
	});

	it("A track keeps its DOM position when it is created first and B is appended (criterion 10)", () => {
		const tabA = packTab("demo_pack", "a.panel", "sA");
		const tabB = packTab("demo_pack", "b.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);

		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		selectSession("sA");
		renderOnce();

		// DOM order is append-only: A first, B second, regardless of which is active.
		expect(tracks().map((track) => track.dataset.mobileTrackSessionKey)).toEqual(["sA", "sB"]);
	});

	it("A(pack) → B(no panel tabs) → A keeps A mounted and gives B a chat-only track (criterion 11)", () => {
		const tabA = packTab("demo_pack", "a.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);

		selectSession("sA");
		renderOnce();
		const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
		const watchA = watchSrc(frameA);

		selectSession("sB");
		renderOnce();

		// A stays mounted, hidden and inert.
		const hiddenA = trackFor("sA")!;
		expect(hiddenA.style.display).toBe("none");
		expect(hiddenA.hasAttribute("inert")).toBe(true);
		expect(iframeIn(hiddenA, tabA.id)).toBe(frameA);

		// B's active track is structurally pane 0 of the slider: one pane, full
		// width, no translation — the bare-chat rendering.
		const trackB = trackFor("sB")!;
		expect(trackB.dataset.mobileTrackActive).toBe("true");
		expect(paneKeysIn(trackB)).toEqual([CHAT_PANE_KEY]);
		const chatPane = paneIn(trackB, CHAT_PANE_KEY)!;
		expect(chatPane.style.width).toBe("100%");
		expect(orderOf(chatPane)).toBe("0");
		expect(trackB.style.transform).toBe("translateX(0%)");
		expect(chatPane.querySelector('[data-testid="chat-panel-stub"]')).toBeTruthy();
		// No mobile tab bar for a session without panel tabs (today's behaviour).
		expect(document.querySelector(".goal-tab-bar--mobile")).toBeNull();
		// Mobile scroll-tracking setup is unchanged: the shell still carries the
		// mobile-header marker the offset rules key off.
		expect(document.querySelector("[data-mobile-header]")).toBeTruthy();
		expect(document.getElementById("app-header")).toBeTruthy();

		selectSession("sA");
		renderOnce();
		expect(iframeIn(trackFor("sA")!, tabA.id)).toBe(frameA);
		expect(watchA.count()).toBe(0);
		watchA.stop();
	});

	it("within-session tab switch keeps DOM order and moves only the transform (criterion 12)", () => {
		const first = packTab("demo_pack", "one.panel", "sA");
		const second = packTab("demo_pack", "two.panel", "sA");
		installSession("sA", [first, second], first.id);
		selectSession("sA");
		renderOnce();

		const track = trackFor("sA")!;
		const domOrderBefore = paneKeysIn(track);
		expect(domOrderBefore).toEqual([CHAT_PANE_KEY, first.id, second.id]);
		const frameOne = iframeIn(track, first.id)!;
		const frameTwo = iframeIn(track, second.id)!;
		const watchOne = watchSrc(frameOne);
		const watchTwo = watchSrc(frameTwo);
		expect(track.style.transform).toBe(`translateX(${expectedSlideX(1, 3)}%)`);

		setTabs("sA", [first, second], second.id);
		renderOnce();

		const after = trackFor("sA")!;
		expect(paneKeysIn(after)).toEqual(domOrderBefore);
		expect(iframeIn(after, first.id)).toBe(frameOne);
		expect(iframeIn(after, second.id)).toBe(frameTwo);
		expect(after.style.transform).toBe(`translateX(${expectedSlideX(2, 3)}%)`);
		expect(watchOne.count()).toBe(0);
		expect(watchTwo.count()).toBe(0);
		watchOne.stop();
		watchTwo.stop();
	});

	it("a tab reorder changes CSS order only, never DOM order (criterion 12)", () => {
		const first = packTab("demo_pack", "one.panel", "sA");
		const second = packTab("demo_pack", "two.panel", "sA");
		installSession("sA", [first, second], first.id);
		selectSession("sA");
		renderOnce();

		const track = trackFor("sA")!;
		const frameOne = iframeIn(track, first.id)!;
		const frameTwo = iframeIn(track, second.id)!;
		const watchOne = watchSrc(frameOne);
		const watchTwo = watchSrc(frameTwo);
		expect(orderOf(paneIn(track, first.id)!)).toBe("1");
		expect(orderOf(paneIn(track, second.id)!)).toBe("2");

		setTabs("sA", [second, first], first.id);
		renderOnce();

		const after = trackFor("sA")!;
		// DOM order unchanged …
		expect(paneKeysIn(after)).toEqual([CHAT_PANE_KEY, first.id, second.id]);
		expect(iframeIn(after, first.id)).toBe(frameOne);
		expect(iframeIn(after, second.id)).toBe(frameTwo);
		// … visual order follows the new tab order.
		expect(orderOf(paneIn(after, second.id)!)).toBe("1");
		expect(orderOf(paneIn(after, first.id)!)).toBe("2");
		expect(orderOf(paneIn(after, CHAT_PANE_KEY)!)).toBe("0");
		expect(watchOne.count()).toBe(0);
		expect(watchTwo.count()).toBe(0);
		watchOne.stop();
		watchTwo.stop();
	});

	it("closing a tab destroys its pane while the track stays put (criterion 13)", () => {
		const first = packTab("demo_pack", "one.panel", "sA");
		const second = packTab("demo_pack", "two.panel", "sA");
		installSession("sA", [first, second], first.id);
		selectSession("sA");
		renderOnce();
		const frameSecond = iframeIn(trackFor("sA")!, second.id)!;
		expect(frameSecond).toBeTruthy();

		setTabs("sA", [first], first.id);
		renderOnce();

		const track = trackFor("sA")!;
		expect(paneKeysIn(track)).toEqual([CHAT_PANE_KEY, first.id]);
		expect(frameSecond.isConnected).toBe(false);
	});

	it("uninstalling the pack removes the retained pane from a hidden track (criterion 13)", () => {
		const tabA = packTab("demo_pack", "a.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
		expect(frameA).toBeTruthy();

		// The uninstall reconcile closes the tab in every session.
		setPanelTabsForSession(state, "sA", []);
		renderOnce(); // exactly one render

		expect(trackFor("sA")).toBeNull();
		expect(frameA.isConnected).toBe(false);
	});

	it("archiving the source session removes its retained pane (criterion 13)", () => {
		const tabA = packTab("demo_pack", "a.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		const frameA = iframeIn(trackFor("sA")!, tabA.id)!;

		state.gatewaySessions = state.gatewaySessions.filter((session) => session.id !== "sA");
		renderOnce(); // exactly one render

		expect(trackFor("sA")).toBeNull();
		expect(frameA.isConnected).toBe(false);
	});

	it("keeps A's track mounted through the cold session-switch loader frame", () => {
		// Review finding: the instant-loader gate returned a BARE loader as the whole
		// main area, a different `html` call site at that ChildPart — lit cleared the
		// slider and detached every live <iframe> on an ordinary first visit to
		// another session.
		const tabA = packTab("demo_pack", "a.panel", "sA");
		const tabB = packTab("demo_pack", "b.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);
		selectSession("sA");
		renderOnce();
		const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
		expect(frameA).toBeTruthy();
		const watchA = watchSrc(frameA);

		beginColdSwitch("sB");
		renderOnce(); // exactly one render

		const hiddenA = trackFor("sA")!;
		expect(iframeIn(hiddenA, tabA.id)).toBe(frameA);
		expect(frameA.isConnected).toBe(true);
		expect(hiddenA.dataset.mobileTrackActive).toBe("false");
		expect(hiddenA.style.display).toBe("none");
		expect(hiddenA.hasAttribute("inert")).toBe(true);
		// The incoming session gets a chat-only track holding the loader, never the
		// outgoing chat panel and never the incoming session's own panes yet.
		const incoming = activeTrack()!;
		expect(incoming.dataset.mobileTrackSessionKey).toBe("sB");
		expect(paneKeysIn(incoming)).toEqual([CHAT_PANE_KEY]);
		expect(document.querySelector('[data-testid="bobbit-loader"]')).toBeTruthy();
		expect(document.querySelector('[data-testid="chat-panel-stub"]')).toBeNull();
		expect(watchA.count()).toBe(0);

		// The connection completes, then back to A through the loader frame again.
		selectSession("sB");
		renderOnce();
		const frameB = iframeIn(trackFor("sB")!, tabB.id)!;
		expect(iframeIn(trackFor("sA")!, tabA.id)).toBe(frameA);

		beginColdSwitch("sA");
		renderOnce();
		// The incoming track keeps the panes it ALREADY had retained; dropping them
		// for the connecting frame would detach their live iframes.
		const incomingA = activeTrack()!;
		expect(incomingA.dataset.mobileTrackSessionKey).toBe("sA");
		// DOM order is append-only (the chat pane wrapper was pruned while sA was a
		// hidden foreign track, so it is re-appended at the tail); the VISUAL order is
		// CSS `order`, which repaints without moving — and therefore reloading — a node.
		expect([...paneKeysIn(incomingA)].sort()).toEqual([CHAT_PANE_KEY, tabA.id].sort());
		expect(orderOf(paneIn(incomingA, CHAT_PANE_KEY)!)).toBe("0");
		expect(orderOf(paneIn(incomingA, tabA.id)!)).toBe("1");
		expect(iframeIn(incomingA, tabA.id)).toBe(frameA);
		expect(iframeIn(trackFor("sB")!, tabB.id)).toBe(frameB);
		selectSession("sA");
		renderOnce();
		expect(iframeIn(trackFor("sA")!, tabA.id)).toBe(frameA);
		expect(iframeIn(trackFor("sB")!, tabB.id)).toBe(frameB);
		expect(trackFor("sA")!.dataset.mobileTrackActive).toBe("true");
		expect(watchA.count()).toBe(0);
		watchA.stop();
	});

	it("shows the bare loader when there is no live retained pane", () => {
		installSession("sB", []);
		beginColdSwitch("sB");
		renderOnce();

		expect(document.querySelector('[data-testid="bobbit-loader"]')).toBeTruthy();
		expect(tracks()).toHaveLength(0);
	});

	it("LRU eviction destroys the least-recently-active hidden pane (criterion 13)", () => {
		const sessions = ["m1", "m2", "m3", "m4"];
		const tabs = sessions.map((sid) => packTab("demo_pack", `${sid}.panel`, sid));
		sessions.forEach((sid, index) => installSession(sid, [tabs[index]]));

		selectSession("m1");
		renderOnce();
		const evicted = iframeIn(trackFor("m1")!, tabs[0].id)!;
		expect(evicted).toBeTruthy();

		for (const sid of sessions.slice(1)) {
			selectSession(sid);
			renderOnce();
		}

		expect(tracks()).toHaveLength(PANEL_PANE_RETENTION_LIMIT);
		expect(trackFor("m1")).toBeNull();
		expect(evicted.isConnected).toBe(false);
		expect(trackFor("m4")!.dataset.mobileTrackActive).toBe("true");
	});

	// The active mobile track mounts EVERY content tab, so an open-but-inactive pack
	// tab already has a live <iframe>. Retention observed only the ACTIVE key, so a
	// hidden foreign track (which projects only the retained slots) dropped the
	// inactive pane — retaining LESS than the slider already had mounted, and well
	// below the cap.
	it("keeps an open-but-inactive pack pane across a session round-trip under the cap", () => {
		const p1 = packTab("demo_pack", "one.panel", "sA");
		const p2 = packTab("demo_pack", "two.panel", "sA");
		const tabB = packTab("demo_pack", "b.panel", "sB");
		installSession("sA", [p1, p2], p1.id);
		installSession("sB", [tabB]);

		selectSession("sA");
		renderOnce();
		const trackA = trackFor("sA")!;
		const frameOne = iframeIn(trackA, p1.id)!;
		const frameTwo = iframeIn(trackA, p2.id)!;
		expect(frameOne).toBeTruthy();
		// The inactive pack tab is already mounted by the slider.
		expect(frameTwo).toBeTruthy();
		const watchOne = watchSrc(frameOne);
		const watchTwo = watchSrc(frameTwo);
		// Both of A's panes plus B's fit inside the cap.
		expect(PANEL_PANE_RETENTION_LIMIT).toBeGreaterThanOrEqual(3);

		selectSession("sB");
		renderOnce();

		const hiddenA = trackFor("sA")!;
		expect(hiddenA.dataset.mobileTrackActive).toBe("false");
		expect([...paneKeysIn(hiddenA)].sort()).toEqual([p1.id, p2.id].sort());
		expect(frameOne.isConnected).toBe(true);
		expect(frameTwo.isConnected).toBe(true);
		expect(iframeIn(hiddenA, p2.id)).toBe(frameTwo);

		selectSession("sA");
		renderOnce();

		const restoredA = trackFor("sA")!;
		expect(restoredA.dataset.mobileTrackActive).toBe("true");
		expect(iframeIn(restoredA, p1.id)).toBe(frameOne);
		expect(iframeIn(restoredA, p2.id)).toBe(frameTwo);
		expect(watchOne.count()).toBe(0);
		expect(watchTwo.count()).toBe(0);
		watchOne.stop();
		watchTwo.stop();
	});

	it("keeps an inactive pack pane when the ACTIVE tab is not a pack tab", () => {
		// Retention's active key is undefined for a non-pack active tab, so the only
		// thing that can retain P2 here is the observed-mounted-pane input.
		const pack = packTab("demo_pack", "one.panel", "sA");
		const preview = {
			id: "preview:entry:index.html",
			kind: "preview" as const,
			title: "index.html",
			label: "index.html",
			source: { type: "preview" as const, entry: "index.html", sessionId: "sA" },
		};
		installSession("sA", [preview, pack], preview.id);
		installSession("sB", []);

		selectSession("sA");
		renderOnce();
		const framePack = iframeIn(trackFor("sA")!, pack.id)!;
		expect(framePack).toBeTruthy();
		const watch = watchSrc(framePack);

		selectSession("sB");
		renderOnce();
		expect(iframeIn(trackFor("sA")!, pack.id)).toBe(framePack);
		expect(framePack.isConnected).toBe(true);

		selectSession("sA");
		renderOnce();
		expect(iframeIn(trackFor("sA")!, pack.id)).toBe(framePack);
		expect(watch.count()).toBe(0);
		watch.stop();
	});

	// A terminated/archived session does NOT reliably leave `gatewaySessions`
	// (src/app/team-archived-bucket.ts documents the overlap), so membership alone
	// is not a liveness test.
	for (const [label, patch] of [
		["status=terminated", { status: "terminated" }],
		["status=archived", { status: "archived" }],
		["archived=true", { archived: true }],
	] as const) {
		it(`destroys a hidden retained pane when its owner becomes terminal (${label}) while still in gatewaySessions`, () => {
			const tabA = packTab("demo_pack", "a.panel", "sA");
			installSession("sA", [tabA]);
			installSession("sB", []);
			selectSession("sA");
			renderOnce();
			selectSession("sB");
			renderOnce();
			const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
			expect(frameA).toBeTruthy();

			state.gatewaySessions = state.gatewaySessions.map((session) =>
				session.id === "sA" ? ({ ...session, ...patch } as any) : session,
			);
			expect(state.gatewaySessions.some((session) => session.id === "sA")).toBe(true);
			renderOnce(); // exactly one render

			expect(trackFor("sA")).toBeNull();
			expect(frameA.isConnected).toBe(false);
			// With nothing retained and B holding no panel tabs, the shell falls back to
			// the bare-chat rendering in that same render — no slider at all.
			expect(tracks()).toHaveLength(0);
			expect(document.querySelector(".side-panel-slider")).toBeNull();
			expect(document.querySelector('[data-testid="chat-panel-stub"]')).toBeTruthy();
		});

		// The ACTIVE track does not project the retention plan's slots: it projects the
		// selected session's own tabs. So the plan pruning a terminal owner's key is
		// not enough on its own — the track has to apply the same liveness rule, or
		// the pane it dropped is immediately re-projected and its <iframe> stays
		// connected.
		it(`destroys the SELECTED session's pack pane when it becomes terminal (${label})`, () => {
			const tabA = packTab("demo_pack", "a.panel", "sA");
			installSession("sA", [tabA]);
			selectSession("sA");
			renderOnce();

			// Anti-vacuity: the pane must genuinely be mounted and connected first.
			const frameA = iframeIn(trackFor("sA")!, tabA.id)!;
			expect(frameA).toBeTruthy();
			expect(frameA.isConnected).toBe(true);
			expect((state as any).remoteAgent).not.toBeNull();

			// The selected session goes terminal while its RemoteAgent is still live, so
			// the shell keeps rendering the slider for it.
			state.gatewaySessions = state.gatewaySessions.map((session) =>
				session.id === "sA" ? ({ ...session, ...patch } as any) : session,
			);
			expect((state as any).selectedSessionId).toBe("sA");
			renderOnce(); // exactly one render

			expect(frameA.isConnected).toBe(false);
			const track = trackFor("sA");
			if (track) {
				expect(iframeIn(track, tabA.id)).toBeNull();
				expect(paneKeysIn(track)).toEqual([CHAT_PANE_KEY]);
			}
			expect(document.querySelector('[data-testid="stub-pack-iframe"]')).toBeNull();
		});
	}

	// LRU eviction bounds HIDDEN retention only. It must never suppress a live tab
	// of the selected session, so the active track cannot be filtered by
	// `retainedSlots`.
	it("renders every live pack tab of the selected session, even past the retention cap", () => {
		const tabs = Array.from({ length: PANEL_PANE_RETENTION_LIMIT + 2 }, (_unused, index) =>
			packTab("demo_pack", `p${index}.panel`, "sA"),
		);
		expect(tabs.length).toBeGreaterThan(PANEL_PANE_RETENTION_LIMIT);
		installSession("sA", tabs, tabs[0].id);
		selectSession("sA");
		renderOnce();

		const track = trackFor("sA")!;
		expect(track).toBeTruthy();
		for (const tab of tabs) {
			const frame = iframeIn(track, tab.id);
			expect(frame, `pane missing for ${tab.id}`).toBeTruthy();
			expect(frame!.isConnected).toBe(true);
		}
		// Chat pane plus every content tab, and the geometry counts all of them.
		expect(paneKeysIn(track)).toHaveLength(tabs.length + 1);
		expect(track.style.width).toBe(`${(tabs.length + 1) * 100}%`);
	});
});
