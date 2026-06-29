import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };
type Session = { id: string; title?: string };
type Archives = { count: number; totalSizeBytes: number };
type WorktreeInventory = Record<string, any>;

let worktreeInventory: WorktreeInventory = emptyWorktreeInventory();
let worktreeCleanup: WorktreeInventory = cleanupResponse({});
let worktreeNextInventory: WorktreeInventory | null = null;
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
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

function emptyWorktreeInventory(): WorktreeInventory {
	return {
		items: [],
		counts: {
			total: 0,
			readyToClean: 0,
			protectedInUse: 0,
			archivedOwned: 0,
			unownedGitWorktrees: 0,
			poolEntries: 0,
			alreadyCleaned: 0,
			needsAttention: 0,
			scanErrors: 0,
			defaultSelected: 0,
			byClassification: {},
			byReason: {},
			bySource: {},
		},
		generatedAt: Date.now(),
		scanned: { projects: 1, repos: 1, worktreeRoots: 1 },
	};
}

function cleanupResponse(counts: Record<string, number>, results: any[] = []): WorktreeInventory {
	return {
		counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts },
		results,
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
	if (url === "/api/maintenance/worktrees" && method === "GET") return response(worktreeInventory);
	if (url === "/api/maintenance/cleanup-worktrees" && method === "POST") {
		const cleanup = worktreeCleanup;
		if (worktreeNextInventory) {
			worktreeInventory = worktreeNextInventory;
			worktreeNextInventory = null;
		}
		return response(cleanup);
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
	worktreeInventory?: WorktreeInventory;
	worktreeCleanup?: WorktreeInventory;
	worktreeNextInventory?: WorktreeInventory;
	sessions?: Session[];
	archives?: Archives;
	orphanRows?: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> };
}) => {
	worktreeInventory = opts.worktreeInventory || emptyWorktreeInventory();
	worktreeCleanup = opts.worktreeCleanup || cleanupResponse({});
	worktreeNextInventory = opts.worktreeNextInventory || null;
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
