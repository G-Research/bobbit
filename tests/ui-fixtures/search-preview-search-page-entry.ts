import { render } from "lit";
import { initSearchPage, renderSearchPage, resetSearchPage, type SearchResultItem } from "../../src/app/search-page.js";
import { setRenderApp } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };

let results: SearchResultItem[] = [];
let total = 0;
let fetchLog: FetchLogEntry[] = [];

class FixtureWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {}
	send(): void {}
	close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

(window as any).WebSocket = FixtureWebSocket;
localStorage.setItem("gateway.url", "http://fixture.test");
localStorage.setItem("gateway.token", "fixture-token");

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, window.location.href);
		return `${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

function parseBody(init?: RequestInit): unknown {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	fetchLog.push({ url, method, body: parseBody(init) });
	if (url.startsWith("/api/search?")) {
		return response({ results, total: total || results.length });
	}
	if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
	return response({});
}) as typeof window.fetch;

function doRender(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderSearchPage(), app);
}

setRenderApp(doRender);

(window as any).__setSearchPageFixture = (opts: {
	query?: string;
	results?: SearchResultItem[];
	total?: number;
}) => {
	results = opts.results || [];
	total = opts.total ?? results.length;
	fetchLog = [];
	resetSearchPage();
	window.location.hash = opts.query ? `#/search?q=${encodeURIComponent(opts.query)}` : "#/search";
	initSearchPage();
	doRender();
};

(window as any).__getSearchPageFetchLog = () => fetchLog.slice();
(window as any).__searchPageFixtureReady = true;
