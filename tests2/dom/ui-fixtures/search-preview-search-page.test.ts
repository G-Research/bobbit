import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/search-preview-search-page.spec.ts (v2-dom tier).
// Renders the REAL renderSearchPage()/initSearchPage() grouped-results UI under
// happy-dom (was an esbuild file:// bundle). searchApi → gatewayFetch → fetch is
// stubbed to serve fixture results; assertions match the same data-role/
// data-kind/data-key/data-expanded DOM facts the Chromium fixture asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { initSearchPage, renderSearchPage, resetSearchPage, type SearchResultItem } from "../../../src/app/search-page.js";
import { setRenderApp } from "../../../src/app/state.js";

const NOW = 1_777_000_000_000;

let results: SearchResultItem[] = [];
let total = 0;

class FixtureWebSocket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {}
	send(): void {}
	close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const u = new URL(raw, window.location.href); return `${u.pathname}${u.search}`; } catch { return raw; }
}

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = requestPath(input);
		const method = (init?.method || "GET").toUpperCase();
		if (url.startsWith("/api/search?")) return response({ results, total: total || results.length });
		if (url === "/api/search/rebuild" && method === "POST") return response({ queued: true }, 202);
		return response({});
	});
}

function container(): HTMLElement { return document.getElementById("app")!; }
function doRender(): void { render(renderSearchPage(), container()); }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

const q = (sel: string, root: ParentNode = container()) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = container()) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();

async function setupSearch(rows: SearchResultItem[], query = "fixture-token"): Promise<void> {
	results = rows;
	total = rows.length;
	resetSearchPage();
	window.location.hash = query ? `#/search?q=${encodeURIComponent(query)}` : "#/search";
	initSearchPage();
	doRender();
	await tick();
	const input = q("input[placeholder='Search everything...']") as HTMLInputElement;
	expect(input.value).toBe(query);
}

function clickFilterPill(label: string): void {
	const btn = qa("button").find((b) => text(b) === label);
	if (!btn) throw new Error(`filter pill not found: ${label}`);
	btn.click();
}

function goal(id: string, title: string, score = 5): SearchResultItem {
	return { type: "goal", id, title, snippet: `<b>${title}</b> goal snippet`, timestamp: NOW, archived: false, score } as SearchResultItem;
}
function session(id: string, title: string, score = 4): SearchResultItem {
	return { type: "session", id, title, snippet: `<b>${title}</b> session snippet`, timestamp: NOW - 1000, archived: false, score } as SearchResultItem;
}
function message(id: string, sessionId: string, token: string, score = 3, sessionTitle: string | undefined = "Grouped Session"): SearchResultItem {
	return { type: "message", id, title: `Message ${id}`, sessionId, sessionTitle, snippet: `<b>${token}</b> body ${id}`, timestamp: NOW - 2000, archived: false, score } as SearchResultItem;
}

beforeEach(() => {
	const div = document.createElement("div");
	div.id = "app";
	document.body.appendChild(div);
	(window as any).WebSocket = FixtureWebSocket;
	localStorage.setItem("gateway.url", "http://fixture.test");
	localStorage.setItem("gateway.token", "fixture-token");
	results = [];
	total = 0;
	installFetch();
	setRenderApp(doRender);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("Search page grouped-results fixture", () => {
	it("multiple message matches group into a single session card", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => message(`msg-${i}`, "session-1", "Quacker"));
		await setupSearch(rows, "Quacker");

		const cards = qa('[data-role="result-group"][data-kind="session"][data-key="session:session-1"]');
		expect(cards.length).toBe(1);
		expect(text(cards[0])).toMatch(/5\s*(in messages|matches)/i);
		expect(cards[0].getAttribute("data-expanded")).toBe("false");
	});

	it("expanding a grouped card reveals nested message rows", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => message(`expand-${i}`, "session-2", "ExpandTok"));
		await setupSearch(rows, "ExpandTok");

		let card = q('[data-role="result-group"][data-key="session:session-2"]')!;
		expect(card.getAttribute("data-expanded")).toBe("false");
		q('[data-role="group-chevron"]', card)!.click();
		await tick();
		card = q('[data-role="result-group"][data-key="session:session-2"]')!;
		expect(card.getAttribute("data-expanded")).toBe("true");
		expect(qa('[data-role="result-child"]', card).length).toBe(5);
	});

	it("message-only groups and rows use the resolved parent session title", async () => {
		const rows = [message("goal-message", "goal-session", "GoalTok", 3, "Fix Search Titles: Grouped Session")];
		await setupSearch(rows, "GoalTok");

		const card = q('[data-role="result-group"][data-key="session:goal-session"]')!;
		expect(card).toBeTruthy();
		expect(text(card)).toContain("Fix Search Titles: Grouped Session");
		expect(text(card)).not.toMatch(/Untitled(?: session)?/i);
		expect(text(q('[data-role="result-child"]', card))).toContain("Fix Search Titles: Grouped Session");
	});

	it("nested message rows inherit the direct parent session title context", async () => {
		const rows: SearchResultItem[] = [
			session("parent-session", "Grouped Session", 4),
			{ ...message("parent-message", "parent-session", "ParentTok", 3, undefined), title: "Raw Message Row Title", sessionTitle: undefined } as SearchResultItem,
		];
		await setupSearch(rows, "ParentTok");

		let card = q('[data-role="result-group"][data-key="session:parent-session"]')!;
		expect(card.getAttribute("data-expanded")).toBe("false");
		q('[data-role="group-chevron"]', card)!.click();
		await tick();
		card = q('[data-role="result-group"][data-key="session:parent-session"]')!;
		const child = q('[data-role="result-child"]', card)!;
		expect(text(child)).toContain("Grouped Session");
		expect(text(child)).not.toContain("Raw Message Row Title");
	});

	it("a group with exactly one total match auto-expands", async () => {
		await setupSearch([session("single-session", "UniqueTitleMatchOnly")], "UniqueTitleMatchOnly");

		const card = qa('[data-role="result-group"][data-kind="session"]').find((c) => text(c).includes("UniqueTitleMatchOnly"))!;
		expect(card).toBeTruthy();
		expect(card.getAttribute("data-expanded")).toBe("true");
	});

	it("type filter pills hide, show, and recompute grouped cards", async () => {
		const rows = [
			goal("goal-1", "Filter Goal", 10),
			session("session-3", "Grouped Session", 2),
			message("filter-1", "session-3", "FilterTok", 6),
			message("filter-2", "session-3", "FilterTok", 6),
			message("filter-3", "session-3", "FilterTok", 6),
		];
		await setupSearch(rows, "FilterTok");

		const goalCards = () => qa('[data-role="result-group"][data-kind="goal"]').filter((c) => text(c).includes("Filter Goal"));
		const sessionCards = () => qa('[data-role="result-group"][data-key="session:session-3"]');
		expect(goalCards().length).toBe(1);
		expect(sessionCards().length).toBe(1);

		for (const label of ["Goals", "Sessions", "Staff"]) { clickFilterPill(label); await tick(); }
		expect(goalCards().length).toBe(0);
		expect(sessionCards().length).toBe(1);
		expect(text(sessionCards()[0])).toMatch(/3\s*(in messages|matches)/i);

		clickFilterPill("Goals"); await tick();
		clickFilterPill("Messages"); await tick();
		expect(goalCards().length).toBe(1);
		expect(sessionCards().length).toBe(0);

		clickFilterPill("Messages"); await tick();
		expect(goalCards().length).toBe(1);
		expect(sessionCards().length).toBe(1);
	});

	it("stale-click shows an inline toast, not a modal", async () => {
		await setupSearch([], "");
		window.dispatchEvent(new CustomEvent("search-result-stale", {
			detail: { kind: "session", id: "00000000-0000-0000-0000-000000000000" },
		}));
		await tick();

		const toast = q('[data-role="stale-toast"]')!;
		expect(toast).toBeTruthy();
		expect(text(toast)).toMatch(/no longer available/i);
		expect(qa('[role="dialog"]').length).toBe(0);

		toast.querySelector("button")!.click();
		await tick();
		expect(qa('[data-role="stale-toast"]').length).toBe(0);
	});
});
