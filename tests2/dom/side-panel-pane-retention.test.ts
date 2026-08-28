import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Desktop side-panel pane retention (docs/design/keep-side-panels-mounted.md).
//
// Acceptance criteria 1–9 (including 3a, 3b, 5a): a retained pack pane must keep
// its DOM position — and therefore its live <iframe> — across collapse/expand,
// split↔fullscreen, session switch and tab switch, while still being destroyed
// for real on tab close, pack uninstall, session archive and LRU eviction.
//
// IFRAME IDENTITY: `tests2/dom/pack-panels-reconcile.test.ts` documents that
// happy-dom cannot execute a pack panel's Blob-URL ESM import, so a REAL pack
// panel never reaches `panel.render()` here and never emits an iframe. We
// therefore stub the single projection chokepoint `renderPackPanelContent` with
// a template that emits one `<iframe src>` per pack tab. That keeps the
// assertions meaningful for what this change actually owns: the LIFETIME of the
// wrapping element. Identity is asserted by holding the element reference and
// comparing with `===`, plus a MutationObserver on `attributes: ["src"]` that
// must record ZERO mutations (a re-created iframe fails the `===` check; a
// re-committed `src` on a surviving element fails the observer check).
//
// What this tier CANNOT prove: that the framed document does not re-navigate.
// Only the real-browser tier can (design criterion 14).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";

vi.mock("../../src/app/pack-panels.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/app/pack-panels.js")>();
	return {
		...actual,
		renderPackPanelContent: (packId: string, panelId: string, params?: Record<string, unknown>, boundSessionId?: string) => {
			// Record every projection so a test can prove a FOREIGN project's module is
			// never invoked with another project's tab params (cross-project exposure).
			// Kept on globalThis because a `vi.mock` factory is hoisted above the module
			// scope it would otherwise close over.
			((globalThis as any).__packProjectionCalls ||= []).push({ packId, panelId, params, boundSessionId });
			return html`<iframe
				data-testid="stub-pack-iframe"
				data-pack-id=${packId}
				data-panel-id=${panelId}
				data-bound-session=${boundSessionId ?? ""}
				src=${`about:blank#${packId}/${panelId}?session=${boundSessionId ?? ""}`}
			></iframe>`;
		},
	};
});

type ProjectionCall = { packId: string; panelId: string; params?: Record<string, unknown>; boundSessionId?: string };
const projectionCalls = (): ProjectionCall[] => ((globalThis as any).__packProjectionCalls ||= []) as ProjectionCall[];
const clearProjectionCalls = (): void => { (globalThis as any).__packProjectionCalls = []; };

type StateModule = typeof import("../../src/app/state.js");
type RenderModule = typeof import("../../src/app/render.js");
type PanelWorkspaceModule = typeof import("../../src/app/panel-workspace.js");
type RetentionModule = typeof import("../../src/app/panel-pane-retention.js");
type PackPanelsModule = typeof import("../../src/app/pack-panels.js");

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let doRenderApp!: RenderModule["doRenderApp"];
let packPanelTabId!: PanelWorkspaceModule["packPanelTabId"];
let setPanelTabsForSession!: PanelWorkspaceModule["setPanelTabsForSession"];
let setActivePanelTabIdForSession!: PanelWorkspaceModule["setActivePanelTabIdForSession"];
let resetPanelPaneRetention!: RetentionModule["resetPanelPaneRetention"];
let PANEL_PANE_RETENTION_LIMIT!: RetentionModule["PANEL_PANE_RETENTION_LIMIT"];
let registerPackPanels!: PackPanelsModule["registerPackPanels"];
let packPanelProjectId!: PackPanelsModule["packPanelProjectId"];
let connectToSession!: typeof import("../../src/app/session-manager.js")["connectToSession"];
let HEADQUARTERS_PROJECT_ID!: string;

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
let raceProjectSequence = 0;

function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

function setViewportWidth(width: number): void {
	(window as any).innerWidth = width;
	window.dispatchEvent(new Event("resize"));
}

/** One render, synchronously. `renderApp()` is rAF-debounced; the criteria that
 *  say "asserted after exactly one render" need a direct call. */
function renderOnce(): void {
	doRenderApp();
}

function packTab(packId: string, panelId: string, sessionId: string, instanceKey = "default", params?: Record<string, unknown>) {
	return {
		id: packPanelTabId(packId, panelId, instanceKey),
		kind: "pack" as const,
		title: `${panelId}`,
		label: `${panelId}`,
		source: { type: "pack" as const, packId, panelId, sessionId, ...(params ? { params } : {}) },
	};
}

function previewTab(sessionId: string) {
	return {
		id: "preview:entry:index.html",
		kind: "preview" as const,
		title: "index.html",
		label: "index.html",
		source: { type: "preview" as const, entry: "index.html", sessionId },
	};
}

/** Install a session with a server-authoritative workspace holding `tabs`. */
function installSession(sessionId: string, tabs: any[], activeTabId?: string, sizeMode: "collapsed" | "split" | "fullscreen" = "split", projectId?: string): void {
	if (!state.gatewaySessions.some((session) => session.id === sessionId)) {
		state.gatewaySessions = [...state.gatewaySessions, { id: sessionId, title: sessionId, projectId } as any];
	}
	(state as any).sidePanelWorkspaceBySession[sessionId] = { version: 1, revision: 1, sessionId, tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? "", sizeMode };
	setPanelTabsForSession(state, sessionId, tabs as any);
	if (activeTabId ?? tabs[0]?.id) setActivePanelTabIdForSession(state, sessionId, activeTabId ?? tabs[0].id);
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

function setSizeMode(sessionId: string, mode: "collapsed" | "split" | "fullscreen"): void {
	const workspace = (state as any).sidePanelWorkspaceBySession[sessionId];
	if (workspace) workspace.sizeMode = mode;
}

const workspaceEl = () => document.querySelector<HTMLElement>('[data-panel-workspace="content"]');
const packHostEl = () => document.querySelector<HTMLElement>("[data-panel-pane-host]");
const slotEls = () => [...document.querySelectorAll<HTMLElement>("[data-panel-pane-key]")];
const slotForTab = (tabId: string) => document.querySelector<HTMLElement>(`[data-panel-pane-key][data-panel-tab-id="${tabId}"]`);
/** Two sessions can hold the same tab id (it is derived from {packId,panelId,
 *  instanceKey}), so cross-session assertions must key off the retention key. */
const slotForSession = (sessionKey: string) =>
	slotEls().find((slot) => (slot.dataset.panelPaneKey ?? "").startsWith(`${sessionKey}\u0000`)) ?? null;
const iframeForSession = (sessionKey: string) => slotForSession(sessionKey)?.querySelector<HTMLIFrameElement>("iframe") ?? null;
const iframeForTab = (tabId: string) => slotForTab(tabId)?.querySelector<HTMLIFrameElement>("iframe") ?? null;
const mobilePaneForSession = (sessionKey: string, tabId: string) => {
	const track = document.querySelector<HTMLElement>(`[data-mobile-pane-track][data-mobile-track-session-key="${sessionKey}"]`);
	return [...(track?.querySelectorAll<HTMLElement>("[data-mobile-pane-key]") ?? [])]
		.find((pane) => pane.dataset.mobilePaneKey === tabId) ?? null;
};
const mobileIframeForSession = (sessionKey: string, tabId: string) =>
	mobilePaneForSession(sessionKey, tabId)?.querySelector<HTMLIFrameElement>("iframe") ?? null;
const splitLayoutEl = () => document.querySelector<HTMLElement>(".side-panel-split-layout");
const restoreButtonEls = () => [...document.querySelectorAll('[data-testid="side-panel-restore"]')];

/** The chat pane is the first child of the split row. In fullscreen the row has
 *  no `.side-panel-split-layout` class, so this is intentionally null there. */
function mainRowChatPane(): HTMLElement | null {
	return (splitLayoutEl()?.firstElementChild as HTMLElement | null) ?? null;
}

/** Observe `src` attribute mutations on a live iframe. */
function watchSrc(iframe: HTMLIFrameElement): { count: () => number; stop: () => void } {
	let count = 0;
	const observer = new MutationObserver((records) => {
		for (const record of records) if (record.attributeName === "src") count += 1;
	});
	observer.observe(iframe, { attributes: true, attributeFilter: ["src"] });
	return {
		count: () => {
			// MutationObserver delivers asynchronously; takeRecords() drains synchronously.
			for (const record of observer.takeRecords()) if (record.attributeName === "src") count += 1;
			return count;
		},
		stop: () => observer.disconnect(),
	};
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
	const packPanelsMod = await import("../../src/app/pack-panels.js");
	registerPackPanels = packPanelsMod.registerPackPanels;
	packPanelProjectId = packPanelsMod.packPanelProjectId;
	connectToSession = (await import("../../src/app/session-manager.js")).connectToSession;
	HEADQUARTERS_PROJECT_ID = (await import("../../src/app/headquarters.js")).HEADQUARTERS_PROJECT_ID;
	__syncCE();
});

beforeEach(() => {
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
	document.body.innerHTML = `<div id="app"></div>`;
	setViewportWidth(DESKTOP_WIDTH);
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
	// The viewport-flip guard is module state; render once at desktop width so
	// the first assertion render never trips it.
	renderOnce();
	clearProjectionCalls();
});

afterEach(() => {
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("desktop side-panel pane retention", () => {
	it("self-check: the src observer actually fires on a real src mutation", () => {
		// Guards every zero-mutation assertion below from being vacuous.
		const tab = packTab("demo_pack", "demo.panel", "s1");
		installSession("s1", [tab]);
		selectSession("s1");
		renderOnce();
		const frame = iframeForTab(tab.id)!;
		const watch = watchSrc(frame);
		expect(watch.count()).toBe(0);
		frame.setAttribute("src", "about:blank#changed");
		expect(watch.count()).toBe(1);
		watch.stop();
	});

	it("keeps the same iframe across collapse and re-expand (criterion 1)", () => {
		const tab = packTab("demo_pack", "demo.panel", "s1");
		installSession("s1", [tab]);
		selectSession("s1");
		renderOnce();

		const before = iframeForTab(tab.id);
		expect(before).toBeTruthy();
		const srcWatch = watchSrc(before!);

		setSizeMode("s1", "collapsed");
		renderOnce();
		// Collapsed: same element, still mounted, workspace hidden, restore button back.
		expect(iframeForTab(tab.id)).toBe(before);
		expect(workspaceEl()!.style.display).toBe("none");
		expect(restoreButtonEls()).toHaveLength(1);

		setSizeMode("s1", "split");
		renderOnce();
		expect(iframeForTab(tab.id)).toBe(before);
		expect(workspaceEl()!.style.display).not.toBe("none");
		expect(restoreButtonEls()).toHaveLength(0);
		expect(srcWatch.count()).toBe(0);
		srcWatch.stop();
	});

	it("keeps both sessions' slots across A → B → A (criterion 2)", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("demo_pack", "other.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		const watchA = watchSrc(frameA);

		selectSession("sB");
		renderOnce();
		const frameB = iframeForTab(tabB.id)!;
		const watchB = watchSrc(frameB);
		expect(slotEls()).toHaveLength(2);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("true");
		expect(slotForTab(tabB.id)!.dataset.panelPaneHidden).toBe("false");

		selectSession("sA");
		renderOnce();
		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(iframeForTab(tabB.id)).toBe(frameB);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("false");
		expect(slotForTab(tabB.id)!.dataset.panelPaneHidden).toBe("true");
		expect(slotEls().filter((slot) => slot.dataset.panelPaneHidden === "false")).toHaveLength(1);
		expect(watchA.count()).toBe(0);
		expect(watchB.count()).toBe(0);
		watchA.stop();
		watchB.stop();
	});

	it("switching to a session with no panel tabs keeps A hidden and gives B plain-chat geometry (criterion 3)", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		const watchA = watchSrc(frameA);

		selectSession("sB");
		renderOnce(); // exactly one render

		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("true");
		const workspace = workspaceEl()!;
		expect(workspace.style.display).toBe("none");
		expect(workspace.hasAttribute("hidden")).toBe(true);
		const chatPane = mainRowChatPane()!;
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(false);
		expect(chatPane.classList.contains("flex-1")).toBe(true);
		expect(chatPane.style.display).not.toBe("none");
		expect(watchA.count()).toBe(0);
		watchA.stop();
	});

	it("a stored fullscreen mode with no active tab still yields plain-chat geometry (criterion 3a)", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", [], undefined, "fullscreen");
		selectSession("sA");
		renderOnce();

		selectSession("sB");
		renderOnce(); // exactly one render

		const workspace = workspaceEl()!;
		expect(workspace.style.display).toBe("none");
		const chatPane = mainRowChatPane()!;
		expect(chatPane.style.display).not.toBe("none");
		expect(chatPane.hasAttribute("hidden")).toBe(false);
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(false);
		// No empty fullscreen main area: the split row keeps its layout classes.
		expect(splitLayoutEl()).toBeTruthy();
	});

	it("switching from a pack tab to a non-pack tab hides the host and retains the iframe (criterion 3b)", () => {
		const pack = packTab("demo_pack", "demo.panel", "sA");
		const preview = previewTab("sA");
		installSession("sA", [pack, preview], pack.id);
		selectSession("sA");
		renderOnce();
		const frame = iframeForTab(pack.id)!;
		const watch = watchSrc(frame);

		setActivePanelTabIdForSession(state, "sA", preview.id);
		(state as any).sidePanelWorkspaceBySession.sA.activeTabId = preview.id;
		renderOnce();

		const host = packHostEl()!;
		expect(host.style.display).toBe("none");
		expect(host.hasAttribute("hidden")).toBe(true);
		expect(host.hasAttribute("inert")).toBe(true);
		expect(host.getAttribute("aria-hidden")).toBe("true");
		expect(iframeForTab(pack.id)).toBe(frame);

		setActivePanelTabIdForSession(state, "sA", pack.id);
		(state as any).sidePanelWorkspaceBySession.sA.activeTabId = pack.id;
		renderOnce();
		expect(packHostEl()!.style.display).toBe("flex");
		expect(iframeForTab(pack.id)).toBe(frame);
		expect(watch.count()).toBe(0);
		watch.stop();
	});

	it("switching between two pack tabs retains both iframes (criterion 4)", () => {
		const first = packTab("demo_pack", "one.panel", "sA");
		const second = packTab("demo_pack", "two.panel", "sA");
		installSession("sA", [first, second], first.id);
		selectSession("sA");
		renderOnce();
		const frameOne = iframeForTab(first.id)!;
		const watchOne = watchSrc(frameOne);

		setActivePanelTabIdForSession(state, "sA", second.id);
		(state as any).sidePanelWorkspaceBySession.sA.activeTabId = second.id;
		renderOnce();
		const frameTwo = iframeForTab(second.id)!;
		const watchTwo = watchSrc(frameTwo);
		expect(slotEls()).toHaveLength(2);

		setActivePanelTabIdForSession(state, "sA", first.id);
		(state as any).sidePanelWorkspaceBySession.sA.activeTabId = first.id;
		renderOnce();
		expect(iframeForTab(first.id)).toBe(frameOne);
		expect(iframeForTab(second.id)).toBe(frameTwo);
		expect(watchOne.count()).toBe(0);
		expect(watchTwo.count()).toBe(0);
		watchOne.stop();
		watchTwo.stop();
	});

	it("split → fullscreen → split retains the iframe and hides the chat pane (criterion 5)", () => {
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab], tab.id, "collapsed");
		selectSession("sA");
		renderOnce();
		expect(restoreButtonEls()).toHaveLength(1);
		const frame = iframeForTab(tab.id)!;
		const watch = watchSrc(frame);

		setSizeMode("sA", "fullscreen");
		renderOnce();
		expect(workspaceEl()!.getAttribute("data-side-panel-mode")).toBe("fullscreen");
		expect(workspaceEl()!.style.display).not.toBe("none");
		expect(mainRowChatPane()).toBeNull(); // fullscreen drops the split-layout class
		const fullscreenChat = document.querySelector<HTMLElement>('[data-testid="chat-panel-stub"]')!.parentElement!;
		expect(fullscreenChat.style.display).toBe("none");
		expect(fullscreenChat.hasAttribute("inert")).toBe(true);
		// No restore button in fullscreen even though the stored mode was collapsed.
		expect(restoreButtonEls()).toHaveLength(0);
		expect(iframeForTab(tab.id)).toBe(frame);

		setSizeMode("sA", "split");
		renderOnce();
		expect(iframeForTab(tab.id)).toBe(frame);
		expect(mainRowChatPane()!.style.display).not.toBe("none");
		expect(watch.count()).toBe(0);
		watch.stop();
	});

	it("a retained foreign slot never makes the workspace space-occupying (criterion 5a)", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();

		expect(slotEls()).toHaveLength(1);
		expect(packHostEl()!.style.display).toBe("none");
		expect(workspaceEl()!.style.display).toBe("none");
		expect(workspaceEl()!.hasAttribute("inert")).toBe(true);
	});

	it("closing the tab, uninstalling the pack, archiving the session and exceeding the cap each tear down in one render (criterion 6)", () => {
		// Tab close.
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		expect(slotEls()).toHaveLength(1);
		selectSession("sB");
		renderOnce();
		expect(slotEls()).toHaveLength(1);
		setPanelTabsForSession(state, "sA", []);
		renderOnce(); // exactly one render
		expect(slotEls()).toHaveLength(0);
		expect(workspaceEl()).toBeNull();
		expect(document.querySelector(".side-panel-split-layout")).toBeNull();

		// Session archived / terminated: it leaves gatewaySessions.
		installSession("sA", [tab]);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		expect(slotEls()).toHaveLength(1);
		state.gatewaySessions = state.gatewaySessions.filter((session) => session.id !== "sA");
		renderOnce(); // exactly one render
		expect(slotEls()).toHaveLength(0);
		expect(workspaceEl()).toBeNull();
	});

	it("exceeding the retention cap evicts the least-recently-active slot (criterion 6, cap)", () => {
		const sessions = ["r1", "r2", "r3", "r4"];
		const tabs = sessions.map((sid) => packTab("demo_pack", `p${sid}`, sid));
		sessions.forEach((sid, index) => installSession(sid, [tabs[index]]));

		sessions.forEach((sid) => {
			selectSession(sid);
			renderOnce();
		});

		expect(slotEls()).toHaveLength(PANEL_PANE_RETENTION_LIMIT);
		// r1 was least recently active, so it is the eviction victim.
		expect(slotForTab(tabs[0].id)).toBeNull();
		expect(slotForTab(tabs[3].id)).toBeTruthy();
	});

	it("hidden slots and hidden hosts are inert (criterion 7)", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("demo_pack", "other.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();

		const hiddenSlots = slotEls().filter((slot) => slot.dataset.panelPaneHidden === "true");
		expect(hiddenSlots).toHaveLength(1);
		for (const slot of hiddenSlots) {
			expect(slot.style.display).toBe("none");
			expect(slot.hasAttribute("hidden")).toBe(true);
			expect(slot.hasAttribute("inert")).toBe(true);
			expect(slot.getAttribute("aria-hidden")).toBe("true");
		}
		// A visible slot must not carry a stale aria-hidden="false".
		const visible = slotEls().filter((slot) => slot.dataset.panelPaneHidden === "false");
		expect(visible).toHaveLength(1);
		expect(visible[0].hasAttribute("aria-hidden")).toBe(false);
		expect(visible[0].hasAttribute("inert")).toBe(false);
		expect(packHostEl()!.hasAttribute("aria-hidden")).toBe(false);
	});

	it("the popout route renders one pane with no retention host (criterion 8)", () => {
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab]);
		selectSession("sA");
		renderOnce();
		expect(packHostEl()).toBeTruthy();

		window.location.hash = `#/session/sA/panel/${encodeURIComponent(tab.id)}`;
		renderOnce();

		expect(document.querySelector('[data-testid="side-panel-route-content"]')).toBeTruthy();
		expect(packHostEl()).toBeNull();
		expect(document.querySelectorAll('[data-testid="stub-pack-iframe"]')).toHaveLength(1);
		expect(document.querySelectorAll("[data-mobile-pane-track]")).toHaveLength(0);

		window.location.hash = "";
	});

	it("does not surface a cached pane for a tab the popout route did not validate (criterion 8)", () => {
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab]);
		selectSession("sA");
		renderOnce();

		window.location.hash = `#/session/sA/panel/${encodeURIComponent("pack:demo_pack:gone.panel:default")}`;
		renderOnce();

		expect(document.querySelector('[data-testid="side-panel-route-missing"]')).toBeTruthy();
		expect(document.querySelectorAll('[data-testid="stub-pack-iframe"]')).toHaveLength(0);

		window.location.hash = "";
	});

	it("keeps the collapsed layout unchanged: chat pane is full width, restore button in place (criterion 9)", () => {
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab], tab.id, "collapsed");
		selectSession("sA");
		renderOnce();

		const row = splitLayoutEl()!;
		const chatPane = row.firstElementChild as HTMLElement;
		expect(chatPane.classList.contains("flex-1")).toBe(true);
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(false);
		expect(chatPane.classList.contains("goal-chat-panel")).toBe(false);
		// Restore button sits between the chat pane and the (hidden) workspace.
		const children = [...row.children] as HTMLElement[];
		const restoreIndex = children.findIndex((child) => child.getAttribute("data-testid") === "side-panel-restore");
		const workspaceIndex = children.findIndex((child) => child.getAttribute("data-panel-workspace") === "content");
		expect(restoreIndex).toBe(1);
		expect(workspaceIndex).toBe(2);
		expect(children[workspaceIndex].style.display).toBe("none");
	});

	// ---------------------------------------------------------------------------
	// Review findings: defects in the merged feature.
	// ---------------------------------------------------------------------------

	it("keeps A's pane mounted through the cold session-switch loader frame", () => {
		// The instant-loader gate used to return a BARE loader as the whole main
		// area, which is a different `html` call site at that ChildPart — lit
		// therefore cleared the panel shell and detached every live <iframe>.
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("demo_pack", "other.panel", "sB");
		installSession("sA", [tabA]);
		installSession("sB", [tabB]);
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		expect(frameA).toBeTruthy();
		const watchA = watchSrc(frameA);

		beginColdSwitch("sB");
		renderOnce(); // exactly one render

		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(frameA.isConnected).toBe(true);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("true");
		// The loading affordance still shows, in the incoming chat position.
		expect(document.querySelector('[data-testid="bobbit-loader"]')).toBeTruthy();
		// Selected-session-no-active-tab geometry: workspace hidden, chat full width.
		const workspace = workspaceEl()!;
		expect(workspace.style.display).toBe("none");
		expect(workspace.hasAttribute("inert")).toBe(true);
		expect(restoreButtonEls()).toHaveLength(0);
		const chatPane = mainRowChatPane()!;
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(false);
		// The outgoing chat panel must not be shown as if it were the incoming one.
		expect(document.querySelector('[data-testid="chat-panel-stub"]')).toBeNull();
		expect(watchA.count()).toBe(0);

		// The connection completes.
		selectSession("sB");
		renderOnce();
		const frameB = iframeForTab(tabB.id)!;
		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(frameB).toBeTruthy();

		// And back to A, through the loader frame again.
		beginColdSwitch("sA");
		renderOnce();
		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(iframeForTab(tabB.id)).toBe(frameB);
		selectSession("sA");
		renderOnce();
		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(iframeForTab(tabB.id)).toBe(frameB);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("false");
		expect(watchA.count()).toBe(0);
		watchA.stop();
	});

	it("shows the bare loader when there is no live retained pane", () => {
		installSession("sB", []);
		beginColdSwitch("sB");
		renderOnce();

		const loader = document.querySelector<HTMLElement>('[data-testid="bobbit-loader"]')!;
		expect(loader).toBeTruthy();
		expect(workspaceEl()).toBeNull();
		expect(splitLayoutEl()).toBeNull();
		expect(document.querySelector(".side-panel-slider")).toBeNull();
	});

	it("a tabless session whose stored mode is collapsed renders no restore rail", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", [], undefined, "collapsed");
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		const watchA = watchSrc(frameA);

		selectSession("sB");
		renderOnce(); // exactly one render

		expect(iframeForTab(tabA.id)).toBe(frameA);
		expect(slotForTab(tabA.id)!.dataset.panelPaneHidden).toBe("true");
		const workspace = workspaceEl()!;
		expect(workspace.style.display).toBe("none");
		expect(workspace.hasAttribute("inert")).toBe(true);
		// The rail would consume width in the split row and could reveal nothing.
		expect(restoreButtonEls()).toHaveLength(0);
		const row = splitLayoutEl()!;
		const chatPane = row.firstElementChild as HTMLElement;
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(false);
		const spaceOccupyingSiblings = [...row.children]
			.filter((child) => child !== chatPane && (child as HTMLElement).style.display !== "none");
		expect(spaceOccupyingSiblings).toHaveLength(0);
		expect(watchA.count()).toBe(0);
		watchA.stop();

		// The restore rail still renders when the selected session HAS an active tab.
		setSizeMode("sA", "collapsed");
		selectSession("sA");
		renderOnce();
		expect(restoreButtonEls()).toHaveLength(1);
	});

	it.each([
		{ label: "desktop", width: DESKTOP_WIDTH },
		{ label: "mobile", width: MOBILE_WIDTH },
	])("prunes project A on the first real cross-project transition render ($label)", async ({ label, width }) => {
		const scenarioId = raceProjectSequence++;
		const projectA = `first-render-A-${label}-${scenarioId}`;
		const projectB = `first-render-B-${label}-${scenarioId}`;
		const contributionsGate = deferred();
		let projectBContributionRequests = 0;
		const contributionBody = JSON.stringify({
			packs: [{
				packId: "demo_pack",
				packName: "demo_pack",
				panels: [{ id: "demo.panel", title: "Demo" }],
				entrypoints: [],
				routeNames: [],
			}],
		});
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/api/ext/contributions") && url.includes(`projectId=${encodeURIComponent(projectB)}`)) {
				projectBContributionRequests += 1;
				await contributionsGate.promise;
				return new Response(contributionBody, { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});
		class FailingWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = FailingWebSocket.CONNECTING;
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			constructor(_url: string) {
				queueMicrotask(() => {
					this.readyState = FailingWebSocket.CLOSED;
					this.onerror?.(new Event("error"));
				});
			}
			send(): void {}
			close(): void { this.readyState = FailingWebSocket.CLOSED; }
		}
		vi.stubGlobal("WebSocket", FailingWebSocket);

		if (width !== DESKTOP_WIDTH) {
			setViewportWidth(width);
			renderOnce(); // settle the deliberate desktop/mobile retention reset
		}
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], projectA);
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("demo_pack", "demo.panel", "sB");
		installSession("sA", [tabA], undefined, "split", projectA);
		installSession("sB", [tabB], undefined, "split", projectB);
		selectSession("sA");
		renderOnce();
		const frameA = width === DESKTOP_WIDTH
			? iframeForSession("sA")!
			: mobileIframeForSession("sA", tabA.id)!;
		expect(frameA).toBeTruthy();
		clearProjectionCalls();
		(state.remoteAgent as any).disconnect = vi.fn();

		// The canonical switch selects B and starts B's real async reconcile before
		// returning, but B's contributions deliberately remain unresolved.
		const pendingConnect = connectToSession("sB", true);
		expect(state.selectedSessionId).toBe("sB");
		expect(state.connectingSessionId).toBe("sB");
		expect(projectBContributionRequests).toBeGreaterThan(0);
		expect(packPanelProjectId("demo_pack", "demo.panel")).toBe(projectA);
		renderOnce(); // first scheduled transition frame, while the registry is still A

		const paneA = width === DESKTOP_WIDTH
			? slotForSession("sA")
			: mobilePaneForSession("sA", tabA.id);
		const frameB = width === DESKTOP_WIDTH
			? iframeForSession("sB")
			: mobileIframeForSession("sB", tabB.id);
		expect(paneA).toBeNull();
		expect(frameA.isConnected).toBe(false);
		expect(frameB).toBeNull();
		expect(projectionCalls().some((call) => call.boundSessionId === "sA")).toBe(false);

		// Make the deliberately failing socket stale so its async cleanup cannot
		// replace B's first-render state, then let B's real reconcile apply.
		state.switchGeneration += 1;
		contributionsGate.release();
		await pendingConnect;
		await vi.waitFor(() => {
			expect(packPanelProjectId("demo_pack", "demo.panel")).toBe(projectB);
		});
		// The socket is deliberately failed to keep this DOM test isolated; project
		// B's normal connected projection can now render against the reconciled registry.
		selectSession("sB");
		renderOnce();
		expect(width === DESKTOP_WIDTH
			? iframeForSession("sB")
			: mobileIframeForSession("sB", tabB.id)).toBeTruthy();
		registerPackPanels([]);
	});

	it("prunes a retained pane on a cross-project switch with disjoint panel keys", () => {
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "projA");
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("other_pack", "other.panel", "sB");
		installSession("sA", [tabA], undefined, "split", "projA");
		installSession("sB", [tabB], undefined, "split", "projB");
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		expect(frameA).toBeTruthy();

		// A canonical switch re-registers panels for the TARGET session's project.
		registerPackPanels([{ packId: "other_pack", panelId: "other.panel" }], "projB");
		selectSession("sB");
		renderOnce(); // exactly one render

		expect(slotForTab(tabA.id)).toBeNull();
		expect(frameA.isConnected).toBe(false);
		expect(iframeForTab(tabB.id)).toBeTruthy();
		expect(slotEls()).toHaveLength(1);
		registerPackPanels([]);
	});

	it("prunes a retained pane on a cross-project switch that shares the panel key", () => {
		// Both projects expose demo_pack/demo.panel. The global registry is
		// "last requested project wins", so re-projecting A's hidden pane after the
		// switch would render project B's module. Retention must prune instead.
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "projA");
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		const tabB = packTab("demo_pack", "demo.panel", "sB");
		installSession("sA", [tabA], undefined, "split", "projA");
		installSession("sB", [tabB], undefined, "split", "projB");
		selectSession("sA");
		renderOnce();
		const frameA = iframeForTab(tabA.id)!;
		expect(frameA).toBeTruthy();

		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "projB");
		selectSession("sB");
		renderOnce(); // exactly one render

		// A's tab still exists (nothing uninstalled it), but its pane is not retained.
		expect(slotEls()).toHaveLength(1);
		expect(slotEls()[0].dataset.panelPaneKey).toContain("sB");
		expect(frameA.isConnected).toBe(false);
		registerPackPanels([]);
	});

	it("canonicalises an unscoped selected target to Headquarters before registry reconciliation", () => {
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "scoped-owner-project");
		const tabScoped = packTab("demo_pack", "demo.panel", "sScopedOwner");
		const tabHq = packTab("demo_pack", "demo.panel", "sHqTarget");
		installSession("sScopedOwner", [tabScoped], undefined, "split", "scoped-owner-project");
		installSession("sHqTarget", [tabHq]); // no projectId → Headquarters-effective
		selectSession("sScopedOwner");
		renderOnce();
		const scopedFrame = iframeForSession("sScopedOwner")!;

		selectSession("sHqTarget");
		renderOnce(); // registry is deliberately still scoped to the outgoing project
		expect(slotForSession("sScopedOwner")).toBeNull();
		expect(scopedFrame.isConnected).toBe(false);
		expect(slotForSession("sHqTarget")).toBeNull();

		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], HEADQUARTERS_PROJECT_ID);
		renderOnce();
		expect(iframeForSession("sHqTarget")).toBeTruthy();
		registerPackPanels([]);
	});

	it("prunes an UNSCOPED session's retained pane when the shared key re-registers for another project", () => {
		// `GatewaySession.projectId` is OPTIONAL, and a session without one is
		// canonically reconciled against HEADQUARTERS (`reconcilePackPanelsForProject`
		// registers with `projectId || HEADQUARTERS_PROJECT_ID`). A scope check that
		// required BOTH ids to be truthy skipped such a session entirely, so project
		// B's module would be invoked with the Headquarters-effective session's own
		// tab params and bound session id.
		//
		// Session ids are unique to this test: the trailing `registerPackPanels([])`
		// cleanup closes tabs asynchronously and bumps the workspace revision of
		// whatever session ids it touched.
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], HEADQUARTERS_PROJECT_ID);
		const secret = "hq-only-param";
		const tabHq = packTab("demo_pack", "demo.panel", "sHq", "default", { sentinel: secret });
		const tabScoped = packTab("demo_pack", "demo.panel", "sScoped");
		installSession("sHq", [tabHq]); // no projectId → Headquarters-effective
		installSession("sScoped", [tabScoped], undefined, "split", "projB");
		selectSession("sHq");
		renderOnce();
		// Both tabs share one tab id (it is derived from {packId,panelId,instanceKey}),
		// so slots must be identified by their SESSION-qualified retention key.
		expect(slotForSession("sHq")).toBeTruthy();
		const frameHq = iframeForSession("sHq")!;
		expect(projectionCalls().some((call) => call.params?.sentinel === secret)).toBe(true);

		// A canonical switch re-registers the SAME {packId,panelId} for project B.
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "projB");
		clearProjectionCalls();
		selectSession("sScoped");
		renderOnce(); // exactly one render

		expect(slotForSession("sHq")).toBeNull();
		expect(frameHq.isConnected).toBe(false);
		expect(slotEls()).toHaveLength(1);
		expect(slotForSession("sScoped")).toBeTruthy();
		// Project B's module was never handed the other session's params, nor bound to it.
		expect(projectionCalls().some((call) => call.params?.sentinel === secret)).toBe(false);
		expect(projectionCalls().some((call) => call.boundSessionId === "sHq")).toBe(false);
		registerPackPanels([]);
	});

	it("keeps a retained pane whose panel has no KNOWN scope (unregistered or global)", () => {
		// Retention must NOT be coupled to registration: an `undefined` registered
		// project means either "not registered yet" (the post-reload window before
		// contributions reconcile) or "registered for the global/no-project scope".
		// Neither may drop a live pane.
		const tabGlobal = packTab("demo_pack", "demo.panel", "sGlobal");
		const tabOther = packTab("other_pack", "other.panel", "sOther");
		installSession("sGlobal", [tabGlobal]); // no projectId → Headquarters-effective
		installSession("sOther", [tabOther]); // same effective project isolates unknown registry scope

		// 1. Nothing registered at all (cold post-reload window).
		selectSession("sGlobal");
		renderOnce();
		const frameGlobal = iframeForSession("sGlobal")!;
		expect(frameGlobal).toBeTruthy();
		const watchGlobal = watchSrc(frameGlobal);
		// A reload/new-session window can select an id before either canonical
		// session collection contains it. That unknown target must not prune.
		selectSession("sUnknownTarget");
		renderOnce();
		expect(iframeForSession("sGlobal")).toBe(frameGlobal);
		selectSession("sOther");
		renderOnce();
		expect(iframeForSession("sGlobal")).toBe(frameGlobal);
		expect(slotForSession("sGlobal")!.dataset.panelPaneHidden).toBe("true");

		// 2. Registered for the GLOBAL scope (no project id).
		registerPackPanels([
			{ packId: "demo_pack", panelId: "demo.panel" },
			{ packId: "other_pack", panelId: "other.panel" },
		]);
		renderOnce();
		expect(iframeForSession("sGlobal")).toBe(frameGlobal);
		expect(slotForSession("sGlobal")!.dataset.panelPaneHidden).toBe("true");
		selectSession("sGlobal");
		renderOnce();
		expect(iframeForSession("sGlobal")).toBe(frameGlobal);
		expect(watchGlobal.count()).toBe(0);
		watchGlobal.stop();
		registerPackPanels([]);
	});

	it("a same-project uninstall removes only the uninstalled pack's pane", () => {
		registerPackPanels([
			{ packId: "demo_pack", panelId: "demo.panel" },
			{ packId: "other_pack", panelId: "other.panel" },
		], "projA");
		const tabOne = packTab("demo_pack", "demo.panel", "s1");
		const tabTwo = packTab("other_pack", "other.panel", "s2");
		installSession("s1", [tabOne], undefined, "split", "projA");
		installSession("s2", [tabTwo], undefined, "split", "projA");
		selectSession("s1");
		renderOnce();
		selectSession("s2");
		renderOnce();
		expect(slotEls()).toHaveLength(2);

		registerPackPanels([{ packId: "other_pack", panelId: "other.panel" }], "projA");
		renderOnce(); // exactly one render

		expect(slotForTab(tabOne.id)).toBeNull();
		expect(slotForTab(tabTwo.id)).toBeTruthy();
		registerPackPanels([]);
	});

	it("a visible panel keeps the split layout classes (criterion 9)", () => {
		const tab = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tab]);
		selectSession("sA");
		renderOnce();

		const row = splitLayoutEl()!;
		expect(row.classList.contains("goal-split-layout")).toBe(true);
		const chatPane = row.firstElementChild as HTMLElement;
		expect(chatPane.classList.contains("side-panel-chat-pane")).toBe(true);
		expect(chatPane.classList.contains("goal-chat-panel")).toBe(true);
		expect(workspaceEl()!.classList.contains("border-l")).toBe(true);
		expect(workspaceEl()!.hasAttribute("hidden")).toBe(false);
		expect(workspaceEl()!.hasAttribute("inert")).toBe(false);
	});

	// A terminated/archived session does NOT reliably leave `gatewaySessions`:
	// src/app/team-archived-bucket.ts documents the overlap ("a session may appear
	// in both gatewaySessions with status=terminated AND in archivedSessions").
	// Membership alone therefore let a hidden pane outlive its owner until an
	// unrelated eviction, which the goal forbids.
	for (const [label, patch] of [
		["status=terminated", { status: "terminated" }],
		["status=archived", { status: "archived" }],
		["archived=true", { archived: true }],
	] as const) {
		it(`destroys a hidden retained pane when its owner becomes terminal (${label}) while still in gatewaySessions`, () => {
			const tabA = packTab("demo_pack", "demo.panel", "sA");
			installSession("sA", [tabA]);
			installSession("sB", []);
			selectSession("sA");
			renderOnce();
			selectSession("sB");
			renderOnce();
			const frameA = iframeForSession("sA")!;
			expect(frameA).toBeTruthy();
			expect(slotEls()).toHaveLength(1);

			// The owner goes terminal but stays cached in the live session list.
			state.gatewaySessions = state.gatewaySessions.map((session) =>
				session.id === "sA" ? ({ ...session, ...patch } as any) : session,
			);
			expect(state.gatewaySessions.some((session) => session.id === "sA")).toBe(true);
			renderOnce(); // exactly one render

			expect(slotEls()).toHaveLength(0);
			expect(frameA.isConnected).toBe(false);
			// B falls back to plain-chat geometry in that same render.
			expect(workspaceEl()).toBeNull();
			expect(splitLayoutEl()).toBeNull();
		});
	}

	it("destroys a retained pane when its owner is terminal in BOTH gatewaySessions and archivedSessions", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		const frameA = iframeForSession("sA")!;

		const owner = state.gatewaySessions.find((session) => session.id === "sA")!;
		state.gatewaySessions = state.gatewaySessions.map((session) =>
			session.id === "sA" ? ({ ...session, status: "terminated" } as any) : session,
		);
		state.archivedSessions = [...state.archivedSessions, { ...owner, status: "terminated" } as any];
		renderOnce(); // exactly one render

		expect(slotEls()).toHaveLength(0);
		expect(frameA.isConnected).toBe(false);
	});

	it("keeps retaining a live owner that is neither archived nor terminated", () => {
		const tabA = packTab("demo_pack", "demo.panel", "sA");
		installSession("sA", [tabA]);
		installSession("sB", []);
		selectSession("sA");
		renderOnce();
		selectSession("sB");
		renderOnce();
		const frameA = iframeForSession("sA")!;

		state.gatewaySessions = state.gatewaySessions.map((session) =>
			session.id === "sA" ? ({ ...session, status: "idle", archived: false } as any) : session,
		);
		renderOnce();

		expect(iframeForSession("sA")).toBe(frameA);
		expect(frameA.isConnected).toBe(true);
	});
});
