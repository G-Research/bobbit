import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };

type Worktree = { path: string; branch: string };
type Session = { id: string; title?: string };
type Archives = { count: number; totalSizeBytes: number };
type ArchivedWorktreeStatus = "removable" | "skipped" | "already-cleaned";
type ArchivedWorktreeItem = {
	key: string;
	sessionId: string;
	repo: string;
	repoPath: string;
	path: string;
	branch?: string;
	pathExists: boolean;
	gitWorktreeMetadataExists: boolean;
	localBranchExists: boolean;
	status: ArchivedWorktreeStatus;
	reason: string;
	detail: string;
	willDeleteBranch: boolean;
	branchDeleteBlockedReason?: string;
};
type ArchivedWorktreeSession = {
	id: string;
	title: string;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
	goalId?: string;
	teamGoalId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	sandboxed?: boolean;
	branch?: string;
	repoPath?: string;
	worktreePath?: string;
	worktrees: ArchivedWorktreeItem[];
};
type ArchivedWorktreeScan = {
	sessions: ArchivedWorktreeSession[];
	counts: {
		archivedSessions: number;
		sessionsWithWorktrees: number;
		removableWorktrees: number;
		skippedWorktrees: number;
		alreadyCleanedWorktrees: number;
	};
};

type CleanupArchivedWorktreeRequest = {
	mode?: "all" | "selected";
	sessionIds?: string[];
	worktrees?: Array<{ sessionId: string; repo?: string; path?: string; key?: string }>;
};

let worktrees: Worktree[] = [];
let sessions: Session[] = [];
let archives: Archives = { count: 0, totalSizeBytes: 0 };
let orphanRows: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> } = { count: 0, sample: [] };
let archivedWorktreeScan: ArchivedWorktreeScan = emptyArchivedWorktreeScan();
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

function emptyArchivedWorktreeScan(): ArchivedWorktreeScan {
	return {
		sessions: [],
		counts: {
			archivedSessions: 0,
			sessionsWithWorktrees: 0,
			removableWorktrees: 0,
			skippedWorktrees: 0,
			alreadyCleanedWorktrees: 0,
		},
	};
}

function archivedCounts(sessions: ArchivedWorktreeSession[]): ArchivedWorktreeScan["counts"] {
	return {
		archivedSessions: sessions.length,
		sessionsWithWorktrees: sessions.filter(session => session.worktrees.length > 0).length,
		removableWorktrees: sessions.reduce((sum, session) => sum + session.worktrees.filter(wt => wt.status === "removable").length, 0),
		skippedWorktrees: sessions.reduce((sum, session) => sum + session.worktrees.filter(wt => wt.status === "skipped").length, 0),
		alreadyCleanedWorktrees: sessions.reduce((sum, session) => sum + session.worktrees.filter(wt => wt.status === "already-cleaned").length, 0),
	};
}

function normalizeArchivedWorktreeScan(scan?: ArchivedWorktreeScan): ArchivedWorktreeScan {
	if (!scan) return emptyArchivedWorktreeScan();
	const sessions = scan.sessions.map(session => ({
		...session,
		worktrees: session.worktrees.map(wt => ({ ...wt, sessionId: wt.sessionId || session.id })),
	}));
	return { sessions, counts: scan.counts || archivedCounts(sessions) };
}

function matchesSelectedArchivedWorktree(item: ArchivedWorktreeItem, selector: { sessionId: string; repo?: string; path?: string; key?: string }): boolean {
	if (selector.key) return selector.key === item.key;
	if (selector.sessionId !== item.sessionId) return false;
	if (selector.repo && selector.repo !== item.repo) return false;
	if (selector.path && selector.path !== item.path) return false;
	return true;
}

function cleanupArchivedWorktrees(body: unknown): unknown {
	const request = (body && typeof body === "object" ? body : {}) as CleanupArchivedWorktreeRequest;
	const allRows = archivedWorktreeScan.sessions.flatMap(session => session.worktrees.map(item => ({ session, item })));
	const selected = request.mode === "all"
		? allRows.filter(({ item }) => item.status === "removable")
		: Array.isArray(request.worktrees)
			? allRows.filter(({ item }) => request.worktrees!.some(selector => matchesSelectedArchivedWorktree(item, selector)))
			: Array.isArray(request.sessionIds)
				? allRows.filter(({ item }) => request.sessionIds!.includes(item.sessionId))
				: [];
	const cleanedKeys = new Set<string>();
	const results = selected.map(({ session, item }) => {
		const cleaned = item.status === "removable";
		if (cleaned) cleanedKeys.add(item.key);
		return {
			key: item.key,
			sessionId: session.id,
			title: session.title,
			repo: item.repo,
			repoPath: item.repoPath,
			path: item.path,
			branch: item.branch,
			status: cleaned ? "cleaned" : item.status,
			reason: cleaned ? undefined : item.reason,
			worktreeRemoved: cleaned,
			branchDeleted: cleaned && item.willDeleteBranch,
		};
	});
	const remainingSessions = archivedWorktreeScan.sessions
		.map(session => ({ ...session, worktrees: session.worktrees.filter(item => !cleanedKeys.has(item.key)) }))
		.filter(session => session.worktrees.length > 0);
	archivedWorktreeScan = { sessions: remainingSessions, counts: archivedCounts(remainingSessions) };
	return {
		counts: {
			requested: selected.length,
			cleaned: results.filter(result => result.status === "cleaned").length,
			branchDeleted: results.filter(result => result.branchDeleted).length,
			skipped: results.filter(result => result.status === "skipped").length,
			alreadyCleaned: results.filter(result => result.status === "already-cleaned").length,
			failed: 0,
		},
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
	if (url === "/api/maintenance/orphaned-worktrees") return response({ worktrees });
	if (url === "/api/maintenance/cleanup-worktrees" && method === "POST") {
		worktrees = [];
		return response({ cleaned: true });
	}
	if (url.startsWith("/api/maintenance/archived-session-worktrees")) return response(archivedWorktreeScan);
	if (url === "/api/maintenance/cleanup-archived-session-worktrees" && method === "POST") {
		return response(cleanupArchivedWorktrees(parseBody(init)));
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
	archivedWorktreeScan?: ArchivedWorktreeScan;
}) => {
	worktrees = opts.worktrees || [];
	sessions = opts.sessions || [];
	archives = opts.archives || { count: 0, totalSizeBytes: 0 };
	orphanRows = opts.orphanRows || { count: 0, sample: [] };
	archivedWorktreeScan = normalizeArchivedWorktreeScan(opts.archivedWorktreeScan);
	fetchLog = [];
	state.activeProjectId = "fixture-project";
	window.location.hash = "#/settings/system/maintenance";
	doRender();
};

(window as any).__getMaintenanceFetchLog = () => fetchLog.slice();
(window as any).__maintenanceFixtureReady = true;
