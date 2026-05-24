import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: any };

type SearchStatsFixture = {
	lastRebuildAt?: number | null;
	rowCountsBySource?: Record<string, number>;
	datasetBytes?: number;
	engine?: string;
	engineVersion?: string;
	state?: string;
};

let stats: SearchStatsFixture = {};
let orphanRows: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> } = { count: 0, sample: [] };
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
window.confirm = () => true;

function response(body: any, status = 200): Response {
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

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

function searchStatsBody() {
	return {
		lastRebuildAt: stats.lastRebuildAt ?? Date.now() - 60_000,
		rowCountsBySource: stats.rowCountsBySource ?? { goals: 3, sessions: 5, messages: 42, staff: 1 },
		datasetBytes: stats.datasetBytes ?? 12_345_678,
		engine: stats.engine ?? "flexsearch",
		engineVersion: stats.engineVersion ?? "0.8.158",
		state: stats.state ?? "ready",
	};
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (url.startsWith("/api/search/stats")) return response(searchStatsBody());
	if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
	if (url === "/api/search/compact" && method === "POST") return response({ ok: true });
	if (url.startsWith("/api/maintenance/orphaned-index-rows")) return response(orphanRows);
	if (url === "/api/maintenance/cleanup-index-rows" && method === "POST") return response({ deleted: 0 });
	return response({});
}) as typeof window.fetch;

function doRender(): void {
	window.location.hash = "#/settings/system/maintenance";
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderSettingsPage(), app);
}

setRenderApp(doRender);

(window as any).__setSearchFixture = (opts: {
	stats?: SearchStatsFixture;
	orphanRows?: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> };
	projectId?: string;
}) => {
	stats = opts.stats || {};
	orphanRows = opts.orphanRows || { count: 0, sample: [] };
	fetchLog = [];
	state.activeProjectId = opts.projectId || "";
	doRender();
};

(window as any).__getSearchFetchLog = () => fetchLog.slice();
(window as any).__searchIndexReady = true;
