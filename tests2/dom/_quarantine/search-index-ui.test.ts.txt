import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/search-index-ui.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled tests/ui-fixtures/search-index-ui-entry.ts,
// which renders the REAL renderSettingsPage() maintenance tab (Search Index panel
// + search-status-dot) into #app and drives it via a mocked /api/search/* and
// window `bobbit-index-event` CustomEvents. This port imports the SAME real modules
// and replicates the entry's window helpers + fetch mock as module functions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let render: typeof import("lit").render;
let renderSettingsPage: typeof import("../../../src/app/settings-page.js").renderSettingsPage;
let setRenderApp: typeof import("../../../src/app/state.js").setRenderApp;
let state: any;

type SearchStatsFixture = Record<string, any>;
let stats: SearchStatsFixture = {};
let orphanRows: { count: number; sample: Array<{ id: string; source_id: string; parent_id?: string | null }> } = { count: 0, sample: [] };
let fetchLog: Array<{ url: string; method: string; body: any }> = [];

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const url = new URL(raw, "http://fixture"); return `${url.pathname}${url.search}`; } catch { return raw; }
}
function parseBody(init?: any): any {
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
function installFetchMock() {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = requestPath(input);
		const method = (init?.method || "GET").toUpperCase();
		fetchLog.push({ url, method, body: parseBody(init) });
		if (url.includes("/side-panel-workspace")) return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (url.startsWith("/api/search/stats")) return response(searchStatsBody());
		if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
		if (url === "/api/search/compact" && method === "POST") return response({ ok: true });
		if (url.startsWith("/api/maintenance/orphaned-index-rows")) return response(orphanRows);
		if (url === "/api/maintenance/cleanup-index-rows" && method === "POST") return response({ deleted: 0 });
		return response({});
	});
}

function doRender(): void {
	window.location.hash = "#/settings/system/maintenance";
	const app = document.getElementById("app");
	if (!app) return; // straggler after teardown — no-op
	render(renderSettingsPage(), app);
}

const settle = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function setupSearch(opts: { stats?: SearchStatsFixture; orphanRows?: any; projectId?: string } = {}): Promise<void> {
	stats = opts.stats || {};
	orphanRows = opts.orphanRows || { count: 0, sample: [] };
	fetchLog = [];
	state.activeProjectId = opts.projectId || "";
	doRender();
	await settle();
	await waitForHeading("Search Index");
}

const qa = (sel: string) => Array.from(document.querySelectorAll(sel));
function headingByText(text: string | RegExp): Element | undefined {
	return qa("h1,h2,h3,h4,h5,h6,[role='heading']").find((h) => {
		const t = (h.textContent || "").trim();
		return typeof text === "string" ? t === text : text.test(t);
	});
}
function buttonByText(text: string | RegExp): HTMLButtonElement | undefined {
	return (qa("button") as HTMLButtonElement[]).find((b) => {
		const t = (b.textContent || "").trim();
		return typeof text === "string" ? t === text : text.test(t);
	});
}
async function waitForHeading(text: string, timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (headingByText(text)) return;
		await settle();
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timeout waiting for heading "${text}"`);
}
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("timeout waiting for condition");
}
const bodyText = () => document.body.textContent || "";
function dispatchIndexEvent(detail: any): void {
	window.dispatchEvent(new CustomEvent("bobbit-index-event", { detail }));
}

beforeAll(async () => {
	localStorage.setItem("gateway.url", "http://fixture");
	localStorage.setItem("gateway.token", "fixture-token");
	await import("../../../src/app/session-manager.js");
	({ render } = await import("lit"));
	({ renderSettingsPage } = await import("../../../src/app/settings-page.js"));
	({ setRenderApp, state } = await import("../../../src/app/state.js"));
	(window as any).WebSocket = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} send() {} close() {} };
	window.confirm = () => true;
	setRenderApp(doRender);
	__syncCE();
});

beforeEach(() => {
	fetchLog = [];
	installFetchMock();
	document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

// The render callback is installed once in beforeAll, so it must be neutralized
// once here (not per-test) — otherwise a debounced straggler render scheduled by
// this file fires doRender into a torn-down / foreign container under
// isolate:false (the state module is shared across files).
afterAll(() => { setRenderApp(() => {}); });

describe("Search Index maintenance panel fixture (v2-dom)", () => {
	it("renders stats and section headings", async () => {
		await setupSearch();

		expect(headingByText("Orphaned Index Rows")).toBeTruthy();
		expect(document.querySelector("[data-search-state]")?.getAttribute("data-search-state")).toBe("ready");
		expect(bodyText()).toContain("flexsearch (0.8.158)");
		expect(bodyText()).toContain("goals: 3");
		expect(buttonByText("Rebuild Index")?.disabled).toBe(false);
		expect(buttonByText("Compact Dataset")).toBeUndefined();
	});

	it("Rebuild Index triggers yellow progress UI then green on complete", async () => {
		await setupSearch();

		buttonByText("Rebuild Index")!.click();
		await waitFor(() => fetchLog.some((e) => e.url === "/api/search/rebuild" && e.method === "POST"));

		await waitFor(() => !!document.querySelector('[data-status-dot="yellow"]'));

		// The optimistic {0,0} progress render settles first; wait for it so our
		// {40/100} event lands last. renderApp() is RAF-deferred, so assert by
		// polling the rendered text, not element presence.
		await waitFor(() => (document.querySelector("[data-search-progress]")?.textContent || "").includes("items"));
		dispatchIndexEvent({ type: "index:progress", projectId: "", phase: "rebuild", total: 100, completed: 40, backlog: 0 });
		await waitFor(() => (document.querySelector("[data-search-progress]")?.textContent || "").includes("40 / 100"));

		dispatchIndexEvent({ type: "index:complete", projectId: "", phase: "rebuild", durationMs: 1000, rowsWritten: 100 });
		await waitFor(() => document.querySelectorAll('[data-status-dot="yellow"]').length === 0);
	});

	it("index:error shows red pill with Retry that recovers", async () => {
		await setupSearch();

		dispatchIndexEvent({ type: "index:error", projectId: "", message: "embedding model download failed", recoverable: true });

		await waitFor(() => !!document.querySelector('[data-status-dot="red"]'));
		const redPill = document.querySelector('[data-status-dot="red"]') as HTMLElement;
		expect(redPill.textContent).toContain("Search unavailable");
		expect(document.querySelector("[data-search-error]")?.textContent).toContain("embedding model download failed");

		(redPill.querySelector("[data-status-dot-retry]") as HTMLElement).click();
		await waitFor(() => fetchLog.some((e) => e.url === "/api/search/rebuild" && e.method === "POST"));
		await waitFor(() => !!document.querySelector('[data-status-dot="yellow"]'));
	});

	it("Orphan Index Rows scan/cleanup buttons work", async () => {
		await setupSearch({
			orphanRows: {
				count: 2,
				sample: [
					{ id: "message:abc:1", source_id: "messages", parent_id: null },
					{ id: "goal:xyz", source_id: "goals", parent_id: null },
				],
			},
		});

		const cleanupBtn = document.querySelector('[data-action="cleanup-orphan-index-rows"]') as HTMLButtonElement;
		expect(cleanupBtn.disabled).toBe(true);

		(document.querySelector('[data-action="scan-orphan-index-rows"]') as HTMLElement).click();
		await waitFor(() => fetchLog.some((e) => e.url.startsWith("/api/maintenance/orphaned-index-rows")));

		await waitFor(() => bodyText().includes("2 orphaned rows."));
		expect(bodyText()).toContain("message:abc:1");
		expect((document.querySelector('[data-action="cleanup-orphan-index-rows"]') as HTMLButtonElement).disabled).toBe(false);
	});
});
