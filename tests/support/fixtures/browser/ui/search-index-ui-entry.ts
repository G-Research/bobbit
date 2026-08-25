import { render } from "lit";
import { renderSettingsPage } from "../../../../../src/app/settings-page.js";
import { commitGatewayConnection } from "../../../../../src/app/gateway-fetch.js";
import { setRenderApp, state } from "../../../../../src/app/state.js";

const FIXTURE_GATEWAY_BASE_URL = "https://fixture.test/team/bobbit";

type FetchLogEntry = { url: string; method: string; body: any };

type SearchStatsFixture = {
	lastRebuildAt?: number | null;
	rowCountsBySource?: Record<string, number>;
	datasetBytes?: number;
	engine?: string;
	engineVersion?: string;
	state?: string;
	degraded?: boolean;
	unavailableReason?: string | null;
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
commitGatewayConnection(FIXTURE_GATEWAY_BASE_URL, "fixture-token");

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: RequestInfo | URL): URL {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(raw);
}

function mountedRoute(url: URL): string {
	const gateway = new URL(FIXTURE_GATEWAY_BASE_URL);
	if (url.origin !== gateway.origin || !url.pathname.startsWith(`${gateway.pathname}/`)) return "";
	return `${url.pathname.slice(gateway.pathname.length)}${url.search}`;
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
		degraded: stats.degraded ?? false,
		unavailableReason: stats.unavailableReason ?? null,
	};
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = requestUrl(input);
	const route = mountedRoute(request);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url: request.href, method, body });

	if (route.startsWith("/api/search/stats")) return response(searchStatsBody());
	if (route === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
	if (route === "/api/search/compact" && method === "POST") return response({ ok: true });
	if (route.startsWith("/api/maintenance/orphaned-index-rows")) return response(orphanRows);
	if (route === "/api/maintenance/cleanup-index-rows" && method === "POST") return response({ deleted: 0 });
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
