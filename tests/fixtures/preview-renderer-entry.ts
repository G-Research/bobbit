// Test entry — bundles PreviewOpenRenderer for a file:// fixture.
import { render } from "lit";
import { PreviewOpenRenderer } from "../../src/ui/tools/renderers/PreviewRenderer.js";

function renderPreview(
	container: HTMLElement,
	params: { html?: string; file?: string } | undefined,
	result: any = undefined,
	isStreaming = false,
	ctx: any = { sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-1" },
) {
	const r = new PreviewOpenRenderer();
	const out = r.render(params, result, isStreaming, ctx);
	render(out.content, container);
}

(window as any).__renderPreview = renderPreview;
(window as any).__setMessages = async (messages: any[]) => {
	// Inject a fake remoteAgent state so locateToolResultBlock() succeeds.
	const { state } = await import("../../src/app/state.js");
	(state as any).remoteAgent = { state: { messages } };
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
