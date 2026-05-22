import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };

type Worktree = { path: string; branch: string };
type Session = { id: string; title?: string };
type Archives = { count: number; totalSizeBytes: number };

let worktrees: Worktree[] = [];
let sessions: Session[] = [];
let archives: Archives = { count: 0, totalSizeBytes: 0 };
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

function searchStatsBody() {
	return {
		lastRebuildAt: Date.now() - 60_000,
		rowCountsBySource: { goals: 3, sessions: 5, messages: 42, staff: 1 },
		datasetBytes: 12_345_678,
		engine: "flexsearch",
		engineVersion: "0.8.158",
		state: "ready",
	};
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	fetchLog.push({ url, method, body: parseBody(init) });

	if (url.startsWith("/api/search/stats")) return response(searchStatsBody());
	if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
	if (url.startsWith("/api/maintenance/orphaned-index-rows")) return response(orphanRows);
	if (url === "/api/maintenance/cleanup-index-rows" && method === "POST") {
		orphanRows = { count: 0, sample: [] };
		return response({ deleted: 0 });
	}
	if (url === "/api/maintenance/orphaned-worktrees") return response({ worktrees });
	if (url === "/api/maintenance/cleanup-worktrees" && method === "POST") {
		worktrees = [];
		return response({ cleaned: true });
	}
	if (url === "/api/maintenance/orphaned-sessions") return response({ sessions });
	if (url === "/api/maintenance/cleanup-sessions" && method === "POST") {
		sessions = [];
		return response({ cleaned: true });
	}
	if (url === "/api/maintenance/expired-archives") return response(archives);
	if (url === "/api/maintenance/purge-archives" && method === "POST") {
		archives = { count: 0, totalSizeBytes: 0 };
		return response({ purged: true });
	}
	return response({});
}) as typeof window.fetch;

function doRender(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderSettingsPage(), app);
}

setRenderApp(doRender);
window.addEventListener("hashchange", doRender);

(window as any).__setMaintenanceFixture = (opts: {
	worktrees?: Worktree[];
	sessions?: Session[];
	archives?: Archives;
	orphanRows?: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> };
}) => {
	worktrees = opts.worktrees || [];
	sessions = opts.sessions || [];
	archives = opts.archives || { count: 0, totalSizeBytes: 0 };
	orphanRows = opts.orphanRows || { count: 0, sample: [] };
	fetchLog = [];
	state.activeProjectId = "fixture-project";
	window.location.hash = "#/settings/system/maintenance";
	doRender();
};

(window as any).__getMaintenanceFetchLog = () => fetchLog.slice();
(window as any).__maintenanceFixtureReady = true;
