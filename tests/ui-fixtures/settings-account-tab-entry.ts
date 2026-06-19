// Test entry for the Settings > Account tab Google OAuth row.
// Renders `renderAccountTab()` into #container. Tests drive state via
// `__resetAccountTab(opts)` and control HTTP via a patched window.fetch.
import { render } from "lit";
import { renderAccountTab, __testResetAccountTab } from "../../src/app/settings-page.js";
import { setRenderApp } from "../../src/app/state.js";

localStorage.setItem("gateway.url", "https://fixture.local");
localStorage.setItem("gateway.token", "fixture-token");

// ── Fetch stub ────────────────────────────────────────────────────────────────
type StubResponseInit = { ok: boolean; status?: number; body: any };
type Responder = StubResponseInit | ((url: string, method: string, body: any) => StubResponseInit);

const fetchLog: Array<{ url: string; method: string; body: any }> = [];
let responder: Responder = { ok: true, body: { authenticated: false } };

(window as any).__setNextFetchResponse = (r: Responder) => { responder = r; };
(window as any).__getFetchLog = () => fetchLog.slice();
(window as any).__clearFetchLog = () => { fetchLog.length = 0; };

window.fetch = (async (input: any, init?: RequestInit) => {
	const urlStr = typeof input === "string" ? input : (input as Request).url;
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

function doRender() {
	const el = document.getElementById("container")!;
	render(renderAccountTab(), el);
}
setRenderApp(doRender);

(window as any).__resetAccountTab = (opts: any) => {
	__testResetAccountTab(opts ?? {});
	doRender();
};
(window as any).__renderAccountTab = doRender;
(window as any).__accountFixtureReady = true;
