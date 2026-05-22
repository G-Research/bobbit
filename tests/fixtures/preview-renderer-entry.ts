// Test entry — bundles PreviewOpenRenderer for a file:// fixture.
import { html, render } from "lit";
import { state as appState } from "../../src/app/state.js";
import { PreviewOpenRenderer } from "../../src/ui/tools/renderers/PreviewRenderer.js";
import { renderTool } from "../../src/ui/tools/index.js";
import "../../src/ui/components/Messages.js";

function renderPreview(
	container: HTMLElement,
	params: { html?: string; file?: string; assets?: string[]; manifest?: string } | undefined,
	result: any = undefined,
	isStreaming = false,
	ctx: any = { sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-1" },
) {
	const r = new PreviewOpenRenderer();
	const out = r.render(params, result, isStreaming, ctx);
	render(out.content, container);
}

(window as any).__renderPreview = renderPreview;
void renderTool;

// Mount a real <tool-message> for preview_open so the lazy registry's
// placeholder → resolve flow runs end-to-end (placeholder card, then the
// real Open button materialising inside the SAME card via the
// bobbit-tool-renderer-loaded event → requestUpdate path).
(window as any).__mountPreviewToolMessage = (
	container: HTMLElement,
	params: any,
	result: any,
	toolUseId: string = "tool-1",
	sessionId: string = "11111111-1111-1111-1111-111111111111",
) => {
	const toolCall = { id: toolUseId, name: "preview_open", arguments: params || {} };
	render(
		html`<tool-message
			.toolCall=${toolCall}
			.tool=${{ name: "preview_open" }}
			.result=${result}
			.pending=${false}
			.aborted=${false}
			.isStreaming=${false}
		></tool-message>`,
		container,
	);
	void sessionId;
};

(window as any).__waitForRendererLoaded = (toolName: string, timeoutMs = 3000): Promise<void> => {
	return new Promise((resolve, reject) => {
		const onLoad = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.toolName === toolName) {
				document.removeEventListener("bobbit-tool-renderer-loaded", onLoad);
				clearTimeout(timer);
				resolve();
			}
		};
		const timer = setTimeout(() => {
			document.removeEventListener("bobbit-tool-renderer-loaded", onLoad);
			reject(new Error(`timeout waiting for renderer ${toolName}`));
		}, timeoutMs);
		document.addEventListener("bobbit-tool-renderer-loaded", onLoad);
	});
};
(window as any).__setMessages = async (messages: any[]) => {
	// Inject a fake remoteAgent state so locateToolResultBlock() succeeds.
	const { state } = await import("../../src/app/state.js");
	(state as any).remoteAgent = { state: { messages } };
};
(window as any).__setPreviewWorkspace = async (sessionId: string, hash: string) => {
	const { state } = await import("../../src/app/state.js");
	(state as any).previewPanelEntry = "inline.html";
	(state as any).previewPanelMtime = 123;
	(state as any).previewPanelContentHash = hash;
	(state as any).isPreviewSession = true;
	(state as any).panelTabsBySession = {
		[sessionId]: [{
			id: "preview:live",
			kind: "preview",
			title: "Preview: inline.html",
			label: "Preview: inline.html",
			legacyTab: "preview",
			source: { type: "preview", entry: "inline.html", sessionId, live: true, contentHash: hash },
			state: { entry: "inline.html", contentHash: hash },
		}],
	};
	(state as any).panelTabs = (state as any).panelTabsBySession[sessionId];
	(state as any).panelWorkspaceActiveBySession = { [sessionId]: "preview:live" };
	(state as any).activePanelTabId = "preview:live";
};
(window as any).__setLivePreviewHash = (sessionId: string, hash: string) => {
	(appState as any).previewPanelContentHash = hash;
	const tabs = (appState as any).panelTabsBySession?.[sessionId];
	const live = Array.isArray(tabs) ? tabs.find((tab: any) => tab?.id === "preview:live" || tab?.id === "preview") : undefined;
	if (live) {
		live.source = { ...(live.source || {}), contentHash: hash };
		live.state = { ...(live.state || {}), contentHash: hash };
	}
};
(window as any).__markLivePreviewRestorable = (sessionId: string, html: string) => {
	const tabs = (appState as any).panelTabsBySession?.[sessionId];
	const live = Array.isArray(tabs) ? tabs.find((tab: any) => tab?.id === "preview:live" || tab?.id === "preview") : undefined;
	if (live) {
		live.source = { ...(live.source || {}), snapshotKind: "inline" };
		live.state = { ...(live.state || {}), snapshotKind: "inline", snapshotHtml: html };
	}
};
(window as any).__clearLivePreviewRestorable = (sessionId: string) => {
	const tabs = (appState as any).panelTabsBySession?.[sessionId];
	const live = Array.isArray(tabs) ? tabs.find((tab: any) => tab?.id === "preview:live" || tab?.id === "preview") : undefined;
	if (live) {
		const { snapshotKind: _sourceKind, ...source } = live.source || {};
		const { snapshotKind: _stateKind, snapshotHtml: _html, snapshotFile: _file, ...state } = live.state || {};
		void _sourceKind;
		void _stateKind;
		void _html;
		void _file;
		live.source = source;
		live.state = state;
	}
};
(window as any).__getPreviewState = async () => {
	const { state } = await import("../../src/app/state.js");
	return {
		previewPanelEntry: (state as any).previewPanelEntry,
		previewPanelMtime: (state as any).previewPanelMtime,
		previewPanelContentHash: (state as any).previewPanelContentHash,
		panelTabsBySession: (state as any).panelTabsBySession,
		activePanelTabId: (state as any).activePanelTabId,
		panelWorkspaceActiveBySession: (state as any).panelWorkspaceActiveBySession,
	};
};
(window as any).__resetPreviewState = async () => {
	const { state } = await import("../../src/app/state.js");
	(state as any).previewPanelEntry = "";
	(state as any).previewPanelMtime = 0;
	(state as any).previewPanelContentHash = "";
	(state as any).panelTabsBySession = {};
	(state as any).panelTabs = [];
	(state as any).activePanelTabId = "chat";
	(state as any).panelWorkspaceActiveBySession = {};
};
(window as any).__getFetchCalls = () => (window as any).__fetchCalls || [];
(window as any).__resetFetchCalls = () => {
	(window as any).__fetchCalls = [];
};
(window as any).__setFetchResponse = (fn: (url: string, init: any, idx: number) => { status: number; body: any }) => {
	(window as any).__fetchResponder = fn;
};
(window as any).__PREVIEW_MARKER = "__preview_snapshot_v1__\n";

// Install a fetch mock
(window as any).__fetchCalls = [];
const origFetch = window.fetch;
window.fetch = async (url: any, init: any = {}) => {
	const idx = (window as any).__fetchCalls.length;
	(window as any).__fetchCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
	const responder = (window as any).__fetchResponder as undefined | ((u: string, i: any, idx: number) => { status: number; body: any });
	const resp = responder
		? responder(String(url), init, idx)
		: { status: 200, body: { ok: true } };
	return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "Content-Type": "application/json" } });
};
void origFetch;

(window as any).__ready = true;
