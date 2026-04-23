// Test entry for the Settings > Models tab redesign fixture.
// Renders `renderModelsTab()` into #container. Tests drive state via
// `__resetModelsTab(opts)` and control HTTP via a patched window.fetch.
import { render } from "lit";
import { __testResetModelsTab, renderModelsTab } from "../../src/app/settings-page.js";
import { setRenderApp } from "../../src/app/state.js";

// ── Fetch stub ────────────────────────────────────────────────────────────────
type StubResponseInit = { ok: boolean; status?: number; body: any };
type Responder = StubResponseInit | ((url: string, method: string, body: any) => StubResponseInit);

const fetchLog: Array<{ url: string; method: string; body: any }> = [];
let responder: Responder = { ok: true, body: {} };

(window as any).__setNextFetchResponse = (r: Responder) => { responder = r; };
(window as any).__getFetchLog = () => fetchLog.slice();
(window as any).__clearFetchLog = () => { fetchLog.length = 0; };

const origFetch = window.fetch.bind(window);
window.fetch = (async (input: any, init?: RequestInit) => {
	const urlStr = typeof input === "string" ? input : (input as Request).url;
	// Strip any origin prefix that gatewayFetch prepends so tests can match on path.
	let pathOnly = urlStr;
	try {
		const u = new URL(urlStr, window.location.origin);
		pathOnly = u.pathname + u.search;
	} catch {}
	const method = (init?.method || "GET").toUpperCase();
	let body: any = null;
	if (init?.body && typeof init.body === "string") {
		try { body = JSON.parse(init.body); } catch { body = init.body; }
	}
	fetchLog.push({ url: pathOnly, method, body });
	const picked = typeof responder === "function" ? (responder as any)(pathOnly, method, body) : responder;
	return new Response(JSON.stringify(picked.body ?? {}), {
		status: picked.status ?? (picked.ok ? 200 : 500),
		headers: { "Content-Type": "application/json" },
	});
}) as any;
void origFetch; // silence unused

function doRender() {
	const el = document.getElementById("container")!;
	render(renderModelsTab(), el);
}
setRenderApp(doRender);

(window as any).__resetModelsTab = (opts: any) => {
	__testResetModelsTab(opts);
	doRender();
};
(window as any).__renderModelsTab = doRender;
(window as any).__ready = true;
