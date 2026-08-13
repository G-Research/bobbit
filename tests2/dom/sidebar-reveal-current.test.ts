import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearArchivedSessionsState,
} from "../../src/app/api.js";
import {
	SIDEBAR_TREE_STATE_STORAGE_KEY,
	clearSidebarTreePreference,
	isSidebarTreeExpanded,
	setSidebarTreeExpanded,
} from "../../src/app/sidebar-tree-state.js";
import { sidebarTreeKey, type SidebarTreeNodeKey } from "../../src/app/sidebar-tree-builder.js";
import {
	SIDEBAR_PROJECT_FILTER_STORAGE_KEYS,
	SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY,
	SIDEBAR_STATUS_FILTER_STORAGE_KEYS,
	setSidebarStatusSectionExpanded,
} from "../../src/app/sidebar-view-preferences.js";
import { renderSidebarViewControls } from "../../src/app/sidebar.js";
import { revealCurrentSidebarSession } from "../../src/app/sidebar-reveal.js";
import {
	setRenderApp,
	state,
	type GatewaySession,
	type Goal,
	type Project,
} from "../../src/app/state.js";

const touchedTreeKeys: SidebarTreeNodeKey[] = [];

function project(id: string): Project {
	return {
		id,
		name: id,
		rootPath: `/tmp/${id}`,
		colorLight: "",
		colorDark: "",
	};
}

function goal(id: string, over: Partial<Goal> = {}): Goal {
	return {
		id,
		title: id,
		cwd: "/tmp",
		projectId: "p",
		state: "todo",
		spec: "test",
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

function session(id: string, over: Partial<GatewaySession> = {}): GatewaySession {
	return {
		id,
		title: id,
		cwd: "/tmp",
		projectId: "p",
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		...over,
	};
}

function setTreeExpanded(key: SidebarTreeNodeKey, expanded: boolean): void {
	touchedTreeKeys.push(key);
	setSidebarTreeExpanded(key, expanded);
}

function mountSessionRow(id: string): HTMLElement {
	document.body.innerHTML = `<aside class="sidebar-edge"><div data-nav-id="session:${id}"></div></aside>`;
	const row = document.querySelector(`[data-nav-id="session:${id}"]`);
	if (!(row instanceof HTMLElement)) throw new Error("session row was not mounted");
	return row;
}

function openSession(id: string): void {
	window.location.hash = `#/session/${id}`;
	state.selectedSessionId = id;
	state.connectingSessionId = id;
	state.remoteAgent = null;
}

function stubMotion(reduced: boolean): void {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
		matches: reduced && query === "(prefers-reduced-motion: reduce)",
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})));
}

beforeEach(() => {
	localStorage.clear();
	clearArchivedSessionsState();
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.goals = [];
	state.projects = [];
	state.staffList = [];
	state.activeProjectId = null;
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.remoteAgent = null;
	state.keyboardNavActiveId = null;
	state.sidebarSessionView = "project";
	state.showArchived = false;
	state.showBusy = true;
	state.showRead = true;
	state.statusShowArchived = false;
	state.statusShowBusy = true;
	state.statusShowRead = true;
	state.statusShowTeams = false;
	state.statusCollapsedSections = new Set();
	state.filtersPopoverOpen = false;
	state.searchQuery = "";
	state.archivedSearchDemand = false;
	setRenderApp(() => {});
	stubMotion(false);
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	})));
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	for (const key of touchedTreeKeys.splice(0)) clearSidebarTreePreference(key);
	setRenderApp(() => {});
	document.body.innerHTML = "";
	window.location.hash = "";
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("reveal current sidebar session control", () => {
	it("is desktop-only, explains its disabled state, and a no-session reveal is a no-op", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		render(renderSidebarViewControls("desktop"), host);
		const button = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-reveal-current-button"]');
		expect(button).not.toBeNull();
		expect(button!.disabled).toBe(true);
		expect(button!.getAttribute("aria-label")).toBe("Reveal current session in sidebar");
		expect(button!.title || button!.parentElement?.title).toMatch(/open a session/i);

		render(renderSidebarViewControls("mobile"), host);
		expect(host.querySelector('[data-testid="sidebar-reveal-current-button"]')).toBeNull();

		state.searchQuery = "must stay";
		state.showArchived = true;
		state.filtersPopoverOpen = true;
		await expect(revealCurrentSidebarSession()).resolves.toBeUndefined();
		expect(state.searchQuery).toBe("must stay");
		expect(state.showArchived).toBe(true);
		expect(state.filtersPopoverOpen).toBe(true);
		expect(state.keyboardNavActiveId).toBeNull();

		openSession("active");
		render(renderSidebarViewControls("desktop"), host);
		const enabled = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-reveal-current-button"]');
		expect(enabled?.disabled).toBe(false);
		expect(enabled?.title).toBe("Reveal current session in sidebar");
	});

	it("clears search, resets only Project filters, force-expands and persists the exact path, and restores the highlight", async () => {
		state.projects = [project("p"), project("unrelated")];
		state.goals = [
			goal("root"),
			goal("child", { parentGoalId: "root", createdAt: 2 }),
		];
		state.gatewaySessions = [
			session("parent", { goalId: "child", createdAt: 3 }),
			session("target", { delegateOf: "parent", createdAt: 4 }),
		];
		openSession("target");
		state.searchQuery = "hidden by search";
		state.showArchived = true;
		state.showBusy = false;
		state.showRead = false;
		state.statusShowArchived = true;
		state.statusShowBusy = false;
		state.statusShowRead = false;
		state.statusShowTeams = true;
		state.filtersPopoverOpen = true;
		state.keyboardNavActiveId = "goal:elsewhere";

		const path: SidebarTreeNodeKey[] = [
			{ kind: "project", projectId: "p" },
			{ kind: "goal", goalId: "root" },
			{ kind: "goal", goalId: "child" },
			{ kind: "session-children", sessionId: "parent", childClass: "delegate" },
		];
		const unrelated: SidebarTreeNodeKey = { kind: "project", projectId: "unrelated" };
		for (const key of path) setTreeExpanded(key, false);
		setTreeExpanded(unrelated, false);

		const row = mountSessionRow("target");
		const scroll = vi.mocked(row.scrollIntoView);
		await revealCurrentSidebarSession();

		expect(state.searchQuery).toBe("");
		expect({ archived: state.showArchived, busy: state.showBusy, read: state.showRead }).toEqual({
			archived: false,
			busy: true,
			read: true,
		});
		expect({
			archived: state.statusShowArchived,
			busy: state.statusShowBusy,
			read: state.statusShowRead,
			teams: state.statusShowTeams,
		}).toEqual({ archived: true, busy: false, read: false, teams: true });
		expect(state.filtersPopoverOpen).toBe(false);
		expect(state.keyboardNavActiveId).toBe("session:target");
		for (const key of path) expect(isSidebarTreeExpanded(key), sidebarTreeKey(key)).toBe(true);
		expect(isSidebarTreeExpanded(unrelated)).toBe(false);

		const persisted = JSON.parse(localStorage.getItem(SIDEBAR_TREE_STATE_STORAGE_KEY) || "{}") as {
			expansion?: Record<string, string>;
		};
		for (const key of path) expect(persisted.expansion?.[sidebarTreeKey(key)]).toBe("expanded");
		expect(persisted.expansion?.[sidebarTreeKey(unrelated)]).toBe("collapsed");
		expect(localStorage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showArchived)).toBe("false");
		expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);
	});

	it("opens only the active Status section and restarts emphasis on every click", async () => {
		state.projects = [project("p")];
		state.gatewaySessions = [session("target")];
		openSession("target");
		state.sidebarSessionView = "status";
		state.searchQuery = "filtered";
		state.statusShowArchived = true;
		state.statusShowBusy = false;
		state.statusShowRead = false;
		state.statusShowTeams = true;
		state.showArchived = true;
		state.showBusy = false;
		state.showRead = false;
		state.filtersPopoverOpen = true;
		setSidebarStatusSectionExpanded(state, "read", false);
		setSidebarStatusSectionExpanded(state, "pinned", false);

		const row = mountSessionRow("target");
		const addClass = vi.spyOn(row.classList, "add");
		await revealCurrentSidebarSession();
		await revealCurrentSidebarSession();

		expect(state.searchQuery).toBe("");
		expect({
			archived: state.statusShowArchived,
			busy: state.statusShowBusy,
			read: state.statusShowRead,
			teams: state.statusShowTeams,
		}).toEqual({ archived: false, busy: true, read: true, teams: false });
		expect({ archived: state.showArchived, busy: state.showBusy, read: state.showRead }).toEqual({
			archived: true,
			busy: false,
			read: false,
		});
		expect(state.statusCollapsedSections.has("read")).toBe(false);
		expect(state.statusCollapsedSections.has("pinned")).toBe(true);
		expect(localStorage.getItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY)).toBe('["pinned"]');
		expect(localStorage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams)).toBe("false");
		expect(state.keyboardNavActiveId).toBe("session:target");
		expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
		expect(addClass.mock.calls.filter(args => args.includes("sidebar-reveal-emphasis")).length).toBe(2);
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);
	});

	it("cold-loads an exact archived session and canonical archive pages before revealing it", async () => {
		state.projects = [project("p")];
		openSession("cold-archived");
		const archived = session("cold-archived", { archived: true, status: "archived" });
		const requested: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			requested.push(url);
			if (url.includes("/api/sessions/cold-archived")) return Response.json(archived);
			if (url.includes("/api/sessions?")) return Response.json({ sessions: [archived], total: 1, hasMore: false });
			if (url.includes("/api/goals?")) return Response.json({ goals: [], total: 0, hasMore: false });
			return Response.json({ error: "not found" }, { status: 404 });
		}));
		const row = mountSessionRow("cold-archived");

		await expect(revealCurrentSidebarSession()).resolves.toBeUndefined();

		expect(requested.some(url => url.includes("/api/sessions/cold-archived"))).toBe(true);
		expect(requested.some(url => url.includes("/api/sessions?") && url.includes("include=archived"))).toBe(true);
		expect(requested.some(url => url.includes("/api/goals?") && url.includes("archived=true"))).toBe(true);
		expect(state.archivedSessions.filter(value => value.id === "cold-archived")).toHaveLength(1);
		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
	});

	it("fails safely when exact cold-session hydration is unavailable", async () => {
		state.projects = [project("p")];
		openSession("missing");
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		const row = mountSessionRow("missing");

		await expect(revealCurrentSidebarSession()).resolves.toBeUndefined();

		expect(state.archivedSessions).toEqual([]);
		expect(state.gatewaySessions).toEqual([]);
		expect(row.scrollIntoView).not.toHaveBeenCalled();
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(false);
	});

	it("uses immediate scrolling and a non-animated emphasis treatment for reduced motion", async () => {
		stubMotion(true);
		state.projects = [project("p")];
		state.gatewaySessions = [session("target")];
		openSession("target");
		const row = mountSessionRow("target");

		await revealCurrentSidebarSession();

		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);
		expect(row.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(true);
	});
});
