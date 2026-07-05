import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/search-preview-maintenance.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled tests/ui-fixtures/search-preview-maintenance-entry.ts,
// which renders the REAL renderSettingsPage() Maintenance tab (worktree cleanup +
// orphaned sessions + expired archives) into #app and drives it via a mocked
// /api/maintenance/*. This port imports the SAME real modules and replicates the
// entry's window helpers + fetch mock as module functions. Playwright `:visible`
// has no meaning under happy-dom (no layout); hidden/diagnostic rows are gated by
// conditional rendering, so we assert element presence/absence + fetchLog instead.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let render: typeof import("lit").render;
let renderSettingsPage: typeof import("../../../src/app/settings-page.js").renderSettingsPage;
let setRenderApp: typeof import("../../../src/app/state.js").setRenderApp;
let state: any;

type WT = Record<string, any>;
let worktreeInventoryState: WT = emptyWorktreeInventory();
let worktreeCleanupState: WT = cleanupResponse({});
let worktreeNextInventory: WT | null = null;
let sessions: Array<{ id: string; title?: string }> = [];
let archives: { count: number; totalSizeBytes: number } = { count: 0, totalSizeBytes: 0 };
let orphanRows: any = { count: 0, sample: [] };
let fetchLog: Array<{ url: string; method: string; body: unknown }> = [];

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const url = new URL(raw, "http://fixture.test"); return `${url.pathname}${url.search}`; } catch { return raw; }
}
function parseBody(init?: any): unknown {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}
function searchStatsBody() {
	return { lastRebuildAt: Date.now() - 60_000, rowCountsBySource: { goals: 3, sessions: 5, messages: 42, staff: 1 }, datasetBytes: 12_345_678, engine: "flexsearch", engineVersion: "0.8.158", state: "ready" };
}
function emptyWorktreeInventory(): WT {
	return {
		items: [], counts: { total: 0, readyToClean: 0, protectedInUse: 0, archivedOwned: 0, unownedGitWorktrees: 0, poolEntries: 0, alreadyCleaned: 0, needsAttention: 0, scanErrors: 0, defaultSelected: 0, byClassification: {}, byReason: {}, bySource: {} },
		generatedAt: Date.now(), scanned: { projects: 1, repos: 1, worktreeRoots: 1 },
	};
}
function cleanupResponse(counts: Record<string, number>, results: any[] = []): WT {
	return { counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts }, results };
}
function installFetchMock() {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = requestPath(input);
		const method = (init?.method || "GET").toUpperCase();
		fetchLog.push({ url, method, body: parseBody(init) });
		if (url.includes("/side-panel-workspace")) return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (url.startsWith("/api/search/stats")) return response(searchStatsBody());
		if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
		if (url.startsWith("/api/maintenance/orphaned-index-rows")) return response(orphanRows);
		if (url === "/api/maintenance/cleanup-index-rows" && method === "POST") { orphanRows = { count: 0, sample: [] }; return response({ deleted: 0 }); }
		if (url === "/api/maintenance/worktrees" && method === "GET") return response(worktreeInventoryState);
		if (url === "/api/maintenance/cleanup-worktrees" && method === "POST") {
			const cleanup = worktreeCleanupState;
			if (worktreeNextInventory) { worktreeInventoryState = worktreeNextInventory; worktreeNextInventory = null; }
			return response(cleanup);
		}
		if (url === "/api/maintenance/orphaned-sessions") return response({ sessions });
		if (url === "/api/maintenance/cleanup-sessions" && method === "POST") { sessions = []; return response({ cleaned: true }); }
		if (url === "/api/maintenance/expired-archives") return response(archives);
		if (url === "/api/maintenance/purge-archives" && method === "POST") { archives = { count: 0, totalSizeBytes: 0 }; return response({ purged: true }); }
		return response({});
	});
}

// ── spec builder helpers (copied verbatim) ─────────────────────────────────
function worktreeItem(overrides: Record<string, any>): Record<string, any> {
	const actionable = overrides.actionable ?? overrides.disposition === "ready-to-clean";
	return {
		id: overrides.id, projectId: "fixture-project", projectName: "Fixture Project", repo: ".", repoPath: "C:/repo", repoDisplayName: "app",
		path: `C:/repo-wt/${overrides.id}`, branch: `session/${overrides.id}`, sources: ["git-worktree"], owners: [],
		classification: overrides.classification, disposition: overrides.disposition, reason: overrides.reason,
		detail: actionable ? "No live or durable Bobbit record references this path." : "Not removable in this fixture category.",
		actionable, selectable: actionable, defaultSelected: actionable, pathExists: actionable, gitWorktreeMetadataExists: actionable,
		localBranchExists: actionable, willDeleteBranch: actionable, ...overrides,
	};
}
function worktreeInventory(items: Record<string, any>[]) {
	const counts: Record<string, any> = {
		total: items.length,
		readyToClean: items.filter((i) => i.disposition === "ready-to-clean").length,
		protectedInUse: items.filter((i) => i.disposition === "protected" || i.classification === "protected-in-use" || i.classification === "pool-entry").length,
		archivedOwned: items.filter((i) => i.classification === "archived-owned").length,
		unownedGitWorktrees: items.filter((i) => i.classification === "unowned-git-worktree").length,
		poolEntries: items.filter((i) => i.classification === "pool-entry").length,
		alreadyCleaned: items.filter((i) => i.disposition === "already-cleaned").length,
		needsAttention: items.filter((i) => i.disposition === "needs-attention" || i.disposition === "failed").length,
		scanErrors: items.filter((i) => i.classification === "scan-error").length,
		defaultSelected: items.filter((i) => i.defaultSelected !== false && i.disposition === "ready-to-clean").length,
		byClassification: {}, byReason: {}, bySource: {},
	};
	for (const item of items) {
		counts.byClassification[item.classification] = (counts.byClassification[item.classification] || 0) + 1;
		counts.byReason[item.reason] = (counts.byReason[item.reason] || 0) + 1;
		for (const source of item.sources || []) counts.bySource[source] = (counts.bySource[source] || 0) + 1;
	}
	return { items, counts, generatedAt: Date.now(), scanned: { projects: 1, repos: 2, worktreeRoots: 1 } };
}
function cleanupResp(counts: Record<string, number>, results: any[] = []): any {
	return { counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts }, results };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
function doRender(): void {
	const app = document.getElementById("app");
	if (!app) return;
	render(renderSettingsPage(), app);
}
const settle = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const qa = (sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel));
const testid = (id: string, root: ParentNode = document) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
function headingByText(text: string | RegExp, root: ParentNode = document): Element | undefined {
	return qa("h1,h2,h3,h4,h5,h6", root).find((h) => {
		const t = (h.textContent || "").trim();
		return typeof text === "string" ? t === text : text.test(t);
	});
}
function buttonByText(text: string | RegExp, root: ParentNode = document): HTMLButtonElement | undefined {
	return (qa("button", root) as HTMLButtonElement[]).find((b) => {
		const t = (b.textContent || "").trim();
		return typeof text === "string" ? t === text : text.test(t);
	});
}
function cardByHeading(heading: string | RegExp): HTMLElement {
	const h = headingByText(heading);
	if (!h) throw new Error(`no heading ${heading}`);
	let el: HTMLElement | null = h as HTMLElement;
	while (el && !(el.classList && el.classList.contains("border"))) el = el.parentElement;
	if (!el) throw new Error(`no bordered card for ${heading}`);
	return el;
}
const worktreeCard = () => testid("worktree-cleanup-maintenance")!;
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
	throw new Error("timeout waiting for condition");
}
const bodyText = () => document.body.textContent || "";

async function setupMaintenance(opts: Record<string, any> = {}): Promise<void> {
	worktreeInventoryState = opts.worktreeInventory || emptyWorktreeInventory();
	worktreeCleanupState = opts.worktreeCleanup || cleanupResponse({});
	worktreeNextInventory = opts.worktreeNextInventory || null;
	sessions = opts.sessions || [];
	archives = opts.archives || { count: 0, totalSizeBytes: 0 };
	orphanRows = opts.orphanRows || { count: 0, sample: [] };
	fetchLog = [];
	state.activeProjectId = "fixture-project";
	window.location.hash = "#/settings/system/maintenance";
	doRender();
	await settle();
	await waitFor(() => !!testid("worktree-cleanup-maintenance"));
}

beforeAll(async () => {
	localStorage.setItem("gateway.url", "http://fixture.test");
	localStorage.setItem("gateway.token", "fixture-token");
	await import("../../../src/app/session-manager.js");
	({ render } = await import("lit"));
	({ renderSettingsPage } = await import("../../../src/app/settings-page.js"));
	({ setRenderApp, state } = await import("../../../src/app/state.js"));
	(window as any).WebSocket = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} send() {} close() {} };
	window.confirm = () => true;
	setRenderApp(doRender);
	window.addEventListener("hashchange", doRender);
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

describe("Maintenance tab fixture (v2-dom)", () => {
	it("renders maintenance sections with worktree cleanup disabled before scan", async () => {
		await setupMaintenance();

		expect(bodyText()).toContain("Orphaned Sessions");
		expect(bodyText()).toContain("Expired Archives");
		expect(headingByText("Worktree Cleanup", worktreeCard())).toBeTruthy();
		expect(headingByText("Orphaned Worktrees")).toBeUndefined();
		expect(headingByText("Archived Session Worktrees")).toBeUndefined();
		expect(window.location.hash).toMatch(/#\/settings\/system\/maintenance/);
		expect(testid("worktree-cleanup-clean-all", worktreeCard())!.hasAttribute("disabled")).toBe(true);
		expect(testid("worktree-cleanup-clean-selected", worktreeCard())!.hasAttribute("disabled")).toBe(true);
		expect(buttonByText(/Terminate/, cardByHeading("Orphaned Sessions"))!.disabled).toBe(true);
		expect(buttonByText(/Purge/, cardByHeading("Expired Archives"))!.disabled).toBe(true);
	});

	// NOTE ON ORDERING: settings-page keeps worktreeInventoryReport at module scope
	// (shared across files under vitest isolate:false). The default-selection logic
	// only applies on the FIRST scan (previousScan === null); later scans preserve
	// the prior selection. So the "defaults" test must be the first scan in the
	// file — the empty-inventory "scan buttons" test is moved to the end.
	it("worktree scan defaults to actionable rows and exposes diagnostics on demand", async () => {
		await setupMaintenance({
			worktreeInventory: worktreeInventory([
				worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", repo: "packages/web", repoDisplayName: "packages/web", repoPath: "C:/repo/packages/web", path: "C:/repo-wt/session-archived-alpha/packages/web", branch: "session/archived-alpha", sources: ["archived-session", "git-worktree"], owners: [{ type: "archived-session", id: "arch-1", title: "Archived cleanup target", archived: true }] }),
				worktreeItem({ id: "git-orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree", branch: "session/orphan" }),
				worktreeItem({ id: "pool-1", classification: "pool-entry", disposition: "protected", reason: "safe-pool-entry", actionable: false, selectable: false, defaultSelected: false, sources: ["pool", "filesystem"] }),
				worktreeItem({ id: "skip-live", classification: "protected-in-use", disposition: "protected", reason: "referenced-by-live-team", actionable: false, selectable: false, defaultSelected: false, branchDeleteBlockedReason: "branch-referenced-by-live-record", willDeleteBranch: false }),
				worktreeItem({ id: "already-cleaned", classification: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", actionable: false, selectable: false, defaultSelected: false, pathExists: false, gitWorktreeMetadataExists: false, willDeleteBranch: false }),
			]),
		});

		const card = worktreeCard();
		testid("worktree-cleanup-scan", card)!.click();
		await waitFor(() => /Ready to clean:\s*2/.test(testid("worktree-cleanup-summary-ready", worktreeCard())?.textContent || ""));
		expect(testid("worktree-cleanup-summary-protected", worktreeCard())!.textContent).toMatch(/Protected\/in use:\s*2/);
		expect(worktreeCard().textContent).toMatch(/Pool entries:\s*1/);
		expect(qa('[data-testid="worktree-cleanup-row"][data-disposition="ready-to-clean"]', worktreeCard()).length).toBe(2);

		const removableRow = worktreeCard().querySelector('[data-worktree-id="arch-alpha"]') as HTMLElement;
		expect(removableRow.textContent).toContain("repo: packages/web");
		expect(removableRow.textContent).toContain("branch: session/archived-alpha");
		expect(removableRow.textContent).toContain("Branch will be deleted");
		expect(removableRow.textContent).toContain("worktree: C:/repo-wt/session-archived-alpha/packages/web");
		expect(removableRow.textContent).toContain("repo path: C:/repo/packages/web");
		const cbSel = '[data-worktree-id="arch-alpha"] input[type="checkbox"]';
		await waitFor(() => (worktreeCard().querySelector(cbSel) as HTMLInputElement | null)?.checked === true);
		const rowCheckbox = worktreeCard().querySelector(cbSel) as HTMLInputElement;
		expect(rowCheckbox.disabled).toBe(false);
		expect(rowCheckbox.checked).toBe(true);

		expect(worktreeCard().querySelector('[data-worktree-id="skip-live"]')).toBeNull();
		testid("worktree-cleanup-show-diagnostics", worktreeCard())!.click();
		await waitFor(() => !!testid("worktree-cleanup-group-pool-entry", worktreeCard()));
		const skippedRow = worktreeCard().querySelector('[data-worktree-id="skip-live"]') as HTMLElement;
		expect(skippedRow).toBeTruthy();
		expect(skippedRow.textContent).toContain("Protected/in use");
		expect(skippedRow.getAttribute("data-reason")).toBe("referenced-by-live-team");
		expect(skippedRow.textContent).toContain("Branch will be kept: branch-referenced-by-live-record");
		expect(skippedRow.querySelector('input[type="checkbox"]')).toBeNull();
	});

	it("selected cleanup posts item ids, shows counts, clears cleaned rows, and rescans", async () => {
		const readyOne = worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session", "git-worktree"] });
		const readyTwo = worktreeItem({ id: "git-orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" });
		await setupMaintenance({
			worktreeInventory: worktreeInventory([readyOne, readyTwo]),
			worktreeCleanup: cleanupResp({ requested: 1, cleaned: 1, branchDeleted: 0 }, [{ itemId: "arch-alpha", status: "cleaned", worktreeRemoved: true, branchDeleted: false }]),
			worktreeNextInventory: worktreeInventory([readyTwo]),
		});
		const card = worktreeCard();

		const cbSel = (id: string) => `[data-worktree-id="${id}"] input[type="checkbox"]`;
		const getScans = () => fetchLog.filter((e) => e.method === "GET" && e.url === "/api/maintenance/worktrees").length;
		testid("worktree-cleanup-scan", card)!.click();
		// worktreeInventoryReport is module-scoped (shared across this file's tests under
		// isolate:false), so setupMaintenance renders the PRIOR test's stale rows before
		// this scan's GET resolves. Waiting only for arch-alpha's presence would pass
		// immediately on that stale row and let the scan's late-resolving GET clobber the
		// post-cleanup rescan (re-adding arch-alpha). Wait for THIS scan's GET to be issued
		// and its report/selection update to fully settle first.
		await waitFor(() => getScans() >= 1);
		await settle();
		await settle();
		await waitFor(() => !!worktreeCard().querySelector(cbSel("arch-alpha")));
		// Clear any (default) selection, then select ONLY arch-alpha, so the POST
		// carries exactly its id regardless of the shared default-selection state.
		testid("worktree-cleanup-clear-selection", worktreeCard())!.click();
		await waitFor(() => (worktreeCard().querySelector(cbSel("arch-alpha")) as HTMLInputElement | null)?.checked === false);
		// The row checkbox is bound to the @change handler (toggleWorktreeInventorySelection).
		// happy-dom's HTMLInputElement.click() flips `.checked` but does NOT fire the
		// `change` event, so the selection Set would stay empty and cleanup-selected
		// would no-op. Drive the real handler explicitly (guide's checkbox pattern).
		const archCb = worktreeCard().querySelector(cbSel("arch-alpha")) as HTMLInputElement;
		archCb.checked = true;
		archCb.dispatchEvent(new Event("change", { bubbles: true }));
		// Let the @change handler's debounced renderApp() flush so the selection is
		// stable and reflected in the card before we trigger the cleanup POST.
		await settle();
		await waitFor(() => (worktreeCard().querySelector(cbSel("arch-alpha")) as HTMLInputElement | null)?.checked === true);
		(worktreeCard().querySelector('[data-action="cleanup-selected-worktrees"]') as HTMLElement).click();

		await waitFor(() => !worktreeCard().querySelector('[data-worktree-id="arch-alpha"]'));
		await waitFor(() => /cleaned\D+1/i.test(worktreeCard().textContent || ""));

		const cleanupPost = fetchLog.find((e) => e.method === "POST" && e.url === "/api/maintenance/cleanup-worktrees");
		expect(cleanupPost?.body).toEqual({ mode: "selected", itemIds: ["arch-alpha"] });
		expect(fetchLog.filter((e) => e.method === "GET" && e.url === "/api/maintenance/worktrees").length).toBe(2);
	});

	it("cleanup actions POST and then rescan", async () => {
		await setupMaintenance({
			worktreeInventory: worktreeInventory([worktreeItem({ id: "orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" })]),
			worktreeCleanup: cleanupResp({ requested: 1, cleaned: 1 }),
			worktreeNextInventory: worktreeInventory([]),
			sessions: [{ id: "12345678-aaaa-bbbb-cccc-123456789abc", title: "Verifier orphan" }],
			archives: { count: 1, totalSizeBytes: 2048 },
		});

		testid("worktree-cleanup-scan", worktreeCard())!.click();
		await waitFor(() => !testid("worktree-cleanup-clean-all", worktreeCard())!.hasAttribute("disabled"));
		testid("worktree-cleanup-clean-all", worktreeCard())!.click();
		await waitFor(() => !!buttonByText("Clean worktrees"));
		buttonByText("Clean worktrees")!.click();
		await waitFor(() => !!testid("worktree-cleanup-empty-state", worktreeCard()));

		const orphanedSessionsCard = cardByHeading("Orphaned Sessions");
		buttonByText("Scan", orphanedSessionsCard)!.click();
		await waitFor(() => !!buttonByText(/Terminate \(1\)/, cardByHeading("Orphaned Sessions")) && !buttonByText(/Terminate \(1\)/, cardByHeading("Orphaned Sessions"))!.disabled);
		buttonByText(/Terminate \(1\)/, cardByHeading("Orphaned Sessions"))!.click();
		await waitFor(() => /No orphaned sessions found/.test(bodyText()));

		const expiredArchivesCard = cardByHeading("Expired Archives");
		buttonByText("Scan", expiredArchivesCard)!.click();
		await waitFor(() => !!buttonByText(/Purge \(1\)/, cardByHeading("Expired Archives")) && !buttonByText(/Purge \(1\)/, cardByHeading("Expired Archives"))!.disabled);
		buttonByText(/Purge \(1\)/, cardByHeading("Expired Archives"))!.click();
		await waitFor(() => /No expired archives found/.test(bodyText()));

		const log = fetchLog.map((e) => `${e.method} ${e.url}`);
		expect(log).toEqual(expect.arrayContaining([
			"POST /api/maintenance/cleanup-worktrees",
			"POST /api/maintenance/cleanup-sessions",
			"POST /api/maintenance/purge-archives",
		]));
	});

	it("worktree scan state persists when switching tabs and back", async () => {
		await setupMaintenance({
			worktreeInventory: worktreeInventory([worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session"] })]),
		});

		testid("worktree-cleanup-scan", worktreeCard())!.click();
		await waitFor(() => !!worktreeCard().querySelector('[data-worktree-id="arch-alpha"]'));

		buttonByText("General")!.click();
		await waitFor(() => bodyText().includes("Show message timestamps"));

		buttonByText("Maintenance")!.click();
		await waitFor(() => !!testid("worktree-cleanup-maintenance") && !!headingByText("Worktree Cleanup", worktreeCard()));
		await waitFor(() => !!worktreeCard().querySelector('[data-worktree-id="arch-alpha"]'));
	});

	it("scan buttons call APIs and render empty worktree cleanup", async () => {
		await setupMaintenance();

		testid("worktree-cleanup-scan", worktreeCard())!.click();
		await waitFor(() => /Nothing safe to clean right now/i.test(testid("worktree-cleanup-empty-state", worktreeCard())?.textContent || ""));

		buttonByText("Scan", cardByHeading("Orphaned Sessions"))!.click();
		await waitFor(() => /No orphaned sessions found/.test(bodyText()));

		buttonByText("Scan", cardByHeading("Expired Archives"))!.click();
		await waitFor(() => /No expired archives found/.test(bodyText()));

		const urls = fetchLog.map((e) => e.url);
		expect(urls).toEqual(expect.arrayContaining(["/api/maintenance/worktrees", "/api/maintenance/orphaned-sessions", "/api/maintenance/expired-archives"]));
	});
});
