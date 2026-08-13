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
	setSidebarViewFilter,
} from "../../src/app/sidebar-view-preferences.js";
import {
	buildSidebarStatusSections,
	buildSidebarTreeModel,
	renderSidebarViewControls,
} from "../../src/app/sidebar.js";
import { revealCurrentSidebarSession } from "../../src/app/sidebar-reveal.js";
import { _setSubgoalsEnabledForTesting } from "../../src/app/subgoals-flag.js";
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
	_setSubgoalsEnabledForTesting(true);
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
	(state as typeof state & { sidebarRevealSessionId?: string | null }).sidebarRevealSessionId = null;
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
	vi.useRealTimers();
	_setSubgoalsEnabledForTesting(false);
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

	it("scopes archived/team inclusion to the explicit Status reveal and returns control to manual filters", async () => {
		state.projects = [project("p")];
		state.archivedSessions = [
			session("target", {
				archived: true,
				status: "archived",
				teamLeadSessionId: "missing-lead",
				server_tags: ["team-kind=member", "read-state=read"],
			}),
			session("archived-other", { archived: true, status: "archived", server_tags: ["read-state=unread"] }),
		];
		state.gatewaySessions = [
			session("member-other", {
				teamLeadSessionId: "other-missing-lead",
				server_tags: ["team-kind=member", "read-state=unread"],
			}),
			session("visible", { server_tags: ["read-state=unread"] }),
		];
		openSession("target");
		state.sidebarSessionView = "status";
		state.searchQuery = "literal query";
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
		expect((state as typeof state & { sidebarRevealSessionId?: string | null }).sidebarRevealSessionId).toBe("target");
		const explicitlyRevealed = buildSidebarStatusSections();
		expect(explicitlyRevealed.read.map(value => value.session.id)).toEqual(["target"]);
		expect(explicitlyRevealed.unread.map(value => value.session.id)).toEqual(["visible"]);
		expect(state.statusCollapsedSections.has("read")).toBe(false);
		expect(state.statusCollapsedSections.has("pinned")).toBe(true);
		expect(localStorage.getItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY)).toBe('["pinned"]');
		expect(localStorage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams)).toBe("false");
		expect(state.keyboardNavActiveId).toBe("session:target");

		await revealCurrentSidebarSession();
		expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
		expect(addClass.mock.calls.filter(args => args.includes("sidebar-reveal-emphasis")).length).toBe(2);
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);

		setSidebarViewFilter(state, "status", "showArchived", false);
		expect((state as typeof state & { sidebarRevealSessionId?: string | null }).sidebarRevealSessionId).toBeNull();
		const manuallyFiltered = buildSidebarStatusSections();
		expect([...manuallyFiltered.pinned, ...manuallyFiltered.unread, ...manuallyFiltered.read]
			.map(value => value.session.id)).toEqual(["visible"]);
	});

	it("does not leak an explicit inclusion when the open session changes during hydration", async () => {
		state.projects = [project("p")];
		openSession("first");
		let releaseFetch!: (response: Response) => void;
		const pendingFetch = new Promise<Response>(resolve => { releaseFetch = resolve; });
		vi.stubGlobal("fetch", vi.fn(() => pendingFetch));

		const reveal = revealCurrentSidebarSession();
		expect((state as typeof state & { sidebarRevealSessionId?: string | null }).sidebarRevealSessionId).toBe("first");
		openSession("second");
		releaseFetch(Response.json(session("first")));
		await reveal;

		buildSidebarTreeModel();
		expect((state as typeof state & { sidebarRevealSessionId?: string | null }).sidebarRevealSessionId).not.toBe("first");
		expect(document.querySelector('[data-nav-id="session:first"]')).toBeNull();
	});

	it("materializes a capped spawned-goal path under its canonical team lead without changing another project", async () => {
		state.projects = [project("p"), project("unrelated")];
		state.goals = [
			goal("team", { projectId: "p", team: true, createdAt: 1 }),
			goal("spawned", { projectId: "p", parentGoalId: "team", spawnedBySessionId: "lead", createdAt: 2 }),
			...Array.from({ length: 7 }, (_, index) => goal(`deep-${index + 1}`, {
				projectId: "p",
				parentGoalId: index === 0 ? "spawned" : `deep-${index}`,
				createdAt: index + 3,
			})),
			goal("unrelated-team", { projectId: "unrelated", team: true, createdAt: 20 }),
			goal("unrelated-spawned", {
				projectId: "unrelated",
				parentGoalId: "unrelated-team",
				spawnedBySessionId: "unrelated-lead",
				createdAt: 21,
			}),
			...Array.from({ length: 7 }, (_, index) => goal(`unrelated-deep-${index + 1}`, {
				projectId: "unrelated",
				parentGoalId: index === 0 ? "unrelated-spawned" : `unrelated-deep-${index}`,
				createdAt: index + 22,
			})),
		];
		state.gatewaySessions = [
			session("lead", { projectId: "p", goalId: "team", teamGoalId: "team", role: "team-lead", createdAt: 30 }),
			session("target", { projectId: "p", goalId: "deep-7", createdAt: 31 }),
			session("unrelated-lead", {
				projectId: "unrelated",
				goalId: "unrelated-team",
				teamGoalId: "unrelated-team",
				role: "team-lead",
				createdAt: 32,
			}),
			session("unrelated-target", { projectId: "unrelated", goalId: "unrelated-deep-7", createdAt: 33 }),
		];
		openSession("target");
		state.keyboardNavActiveId = "session:unrelated-target";

		const targetPath: SidebarTreeNodeKey[] = [
			{ kind: "project", projectId: "p" },
			{ kind: "goal", goalId: "team" },
			{ kind: "team-lead", sessionId: "lead" },
			{ kind: "goal", goalId: "spawned" },
			...Array.from({ length: 7 }, (_, index): SidebarTreeNodeKey => ({ kind: "goal", goalId: `deep-${index + 1}` })),
		];
		const unrelatedProject: SidebarTreeNodeKey = { kind: "project", projectId: "unrelated" };
		for (const key of targetPath) setTreeExpanded(key, false);
		setTreeExpanded(unrelatedProject, false);

		const targetSessionKey = sidebarTreeKey({ kind: "session", sessionId: "target" });
		const unrelatedDeepGoalKey = sidebarTreeKey({ kind: "goal", goalId: "unrelated-deep-7" });
		const before = buildSidebarTreeModel();
		expect(before.flatByKey.has(targetSessionKey), "default cap must clip the target before explicit reveal").toBe(false);
		expect(before.flatByKey.has(unrelatedDeepGoalKey)).toBe(false);
		const row = mountSessionRow("target");

		await revealCurrentSidebarSession();

		const after = buildSidebarTreeModel();
		const targetNode = after.flatByKey.get(targetSessionKey);
		expect(targetNode, "explicit project cap must materialize the target session").toBeDefined();
		const actualAncestors: string[] = [];
		let parentKey = targetNode?.parentKey ?? null;
		while (parentKey) {
			actualAncestors.push(parentKey);
			parentKey = after.flatByKey.get(parentKey)?.parentKey ?? null;
		}
		expect(actualAncestors).toEqual([...targetPath].reverse().map(sidebarTreeKey));
		for (const key of targetPath) expect(isSidebarTreeExpanded(key), sidebarTreeKey(key)).toBe(true);
		expect(isSidebarTreeExpanded(unrelatedProject)).toBe(false);
		expect(after.flatByKey.has(unrelatedDeepGoalKey), "unrelated project cap must stay at its default").toBe(false);
		expect(state.keyboardNavActiveId).toBe("session:target");
		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);

		const persisted = JSON.parse(localStorage.getItem(SIDEBAR_TREE_STATE_STORAGE_KEY) || "{}") as {
			expansion?: Record<string, string>;
		};
		for (const key of targetPath) expect(persisted.expansion?.[sidebarTreeKey(key)]).toBe("expanded");
		expect(persisted.expansion?.[sidebarTreeKey(unrelatedProject)]).toBe("collapsed");
	});

	it("recreates all sidebar modules and restores only the explicitly revealed project's deep cap", async () => {
		const projects = [project("p"), project("unrelated")];
		const goals = [
			goal("team", { projectId: "p", team: true, createdAt: 1 }),
			goal("spawned", { projectId: "p", parentGoalId: "team", spawnedBySessionId: "lead", createdAt: 2 }),
			...Array.from({ length: 7 }, (_, index) => goal(`deep-${index + 1}`, {
				projectId: "p",
				parentGoalId: index === 0 ? "spawned" : `deep-${index}`,
				createdAt: index + 3,
			})),
			goal("unrelated-team", { projectId: "unrelated", team: true, createdAt: 20 }),
			goal("unrelated-spawned", {
				projectId: "unrelated",
				parentGoalId: "unrelated-team",
				spawnedBySessionId: "unrelated-lead",
				createdAt: 21,
			}),
			...Array.from({ length: 7 }, (_, index) => goal(`unrelated-deep-${index + 1}`, {
				projectId: "unrelated",
				parentGoalId: index === 0 ? "unrelated-spawned" : `unrelated-deep-${index}`,
				createdAt: index + 22,
			})),
		];
		const sessions = [
			session("lead", { projectId: "p", goalId: "team", teamGoalId: "team", role: "team-lead", createdAt: 30 }),
			session("target", { projectId: "p", goalId: "deep-7", createdAt: 31 }),
			session("unrelated-lead", {
				projectId: "unrelated",
				goalId: "unrelated-team",
				teamGoalId: "unrelated-team",
				role: "team-lead",
				createdAt: 32,
			}),
			session("unrelated-target", { projectId: "unrelated", goalId: "unrelated-deep-7", createdAt: 33 }),
		];
		const targetPath: SidebarTreeNodeKey[] = [
			{ kind: "project", projectId: "p" },
			{ kind: "goal", goalId: "team" },
			{ kind: "team-lead", sessionId: "lead" },
			{ kind: "goal", goalId: "spawned" },
			...Array.from({ length: 7 }, (_, index): SidebarTreeNodeKey => ({ kind: "goal", goalId: `deep-${index + 1}` })),
		];
		const unrelatedProject: SidebarTreeNodeKey = { kind: "project", projectId: "unrelated" };
		const targetSessionKey = sidebarTreeKey({ kind: "session", sessionId: "target" });
		const unrelatedDeepGoalKey = sidebarTreeKey({ kind: "goal", goalId: "unrelated-deep-7" });

		vi.resetModules();
		let freshStateModule = await import("../../src/app/state.js");
		let freshTreeState = await import("../../src/app/sidebar-tree-state.js");
		let freshSubgoals = await import("../../src/app/subgoals-flag.js");
		let freshSidebar = await import("../../src/app/sidebar.js");
		let freshReveal = await import("../../src/app/sidebar-reveal.js");
		freshSubgoals._setSubgoalsEnabledForTesting(true);
		freshStateModule.state.projects = projects;
		freshStateModule.state.goals = goals;
		freshStateModule.state.gatewaySessions = sessions;
		freshStateModule.state.archivedSessions = [];
		freshStateModule.state.sidebarSessionView = "project";
		freshStateModule.state.showArchived = false;
		freshStateModule.state.showBusy = true;
		freshStateModule.state.showRead = true;
		freshStateModule.state.selectedSessionId = "target";
		freshStateModule.state.connectingSessionId = "target";
		freshStateModule.state.remoteAgent = null;
		freshStateModule.setRenderApp(() => {});
		window.location.hash = "#/session/target";
		for (const key of targetPath) freshTreeState.setSidebarTreeExpanded(key, false);
		freshTreeState.setSidebarTreeExpanded(unrelatedProject, false);
		expect(freshSidebar.buildSidebarTreeModel().flatByKey.has(targetSessionKey)).toBe(false);
		mountSessionRow("target");

		await freshReveal.revealCurrentSidebarSession();
		expect(freshSidebar.buildSidebarTreeModel().flatByKey.has(targetSessionKey)).toBe(true);

		// Discard module memory and rebuild all canonical inputs from storage.
		vi.resetModules();
		freshStateModule = await import("../../src/app/state.js");
		freshTreeState = await import("../../src/app/sidebar-tree-state.js");
		freshSubgoals = await import("../../src/app/subgoals-flag.js");
		freshSidebar = await import("../../src/app/sidebar.js");
		freshSubgoals._setSubgoalsEnabledForTesting(true);
		freshStateModule.state.projects = projects;
		freshStateModule.state.goals = goals;
		freshStateModule.state.gatewaySessions = sessions;
		freshStateModule.state.archivedSessions = [];
		freshStateModule.state.sidebarSessionView = "project";
		freshStateModule.state.showArchived = false;
		freshStateModule.state.showBusy = true;
		freshStateModule.state.showRead = true;
		freshStateModule.state.sidebarRevealSessionId = null;
		freshStateModule.setRenderApp(() => {});

		const reloaded = freshSidebar.buildSidebarTreeModel();
		expect(reloaded.flatByKey.has(targetSessionKey), "durable target-project depth must survive module/state recreation").toBe(true);
		expect(reloaded.flatByKey.has(unrelatedDeepGoalKey), "unrelated project depth must remain at the default cap").toBe(false);
		for (const key of targetPath) expect(freshTreeState.isSidebarTreeExpanded(key), sidebarTreeKey(key)).toBe(true);
		expect(freshTreeState.isSidebarTreeExpanded(unrelatedProject)).toBe(false);
		freshSubgoals._setSubgoalsEnabledForTesting(false);
	});

	it("normalizes a cached terminated delegate after exact hydration fails and reveals its archived child path once", async () => {
		state.projects = [project("p")];
		state.gatewaySessions = [
			session("parent", { projectId: "p", createdAt: 1 }),
			session("target", {
				projectId: "p",
				delegateOf: "parent",
				status: "terminated",
				archived: false,
				createdAt: 2,
			}),
		];
		openSession("target");
		state.showArchived = true;
		state.searchQuery = "filtered";

		const expansionPath: SidebarTreeNodeKey[] = [
			{ kind: "project", projectId: "p" },
			{ kind: "project-sessions", projectId: "p" },
			{ kind: "session-children", sessionId: "parent", childClass: "archived-delegate" },
		];
		const ancestorPath: SidebarTreeNodeKey[] = [
			expansionPath[0],
			expansionPath[1],
			{ kind: "session", sessionId: "parent" },
			expansionPath[2],
		];
		for (const key of expansionPath) setTreeExpanded(key, false);

		const requests: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.includes("/api/sessions/target")) return Response.json({ error: "not found" }, { status: 404 });
			if (url.includes("/api/sessions?")) return Response.json({ sessions: [], total: 0, hasMore: false });
			if (url.includes("/api/goals?")) return Response.json({ goals: [], total: 0, hasMore: false });
			return Response.json({ error: "not found" }, { status: 404 });
		}));
		const row = mountSessionRow("target");

		await expect(revealCurrentSidebarSession()).resolves.toBeUndefined();

		expect(requests.some(url => url.includes("/api/sessions/target"))).toBe(true);
		expect(state.gatewaySessions.some(value => value.id === "target")).toBe(false);
		expect(state.archivedSessions.filter(value => value.id === "target")).toEqual([
			expect.objectContaining({ id: "target", status: "terminated", archived: false }),
		]);
		expect([...state.gatewaySessions, ...state.archivedSessions].filter(value => value.id === "target")).toHaveLength(1);
		expect(state.searchQuery).toBe("");
		expect(state.showArchived).toBe(false);
		for (const key of expansionPath) expect(isSidebarTreeExpanded(key), sidebarTreeKey(key)).toBe(true);

		const model = buildSidebarTreeModel();
		const targetNode = model.flatByKey.get(sidebarTreeKey({ kind: "session", sessionId: "target" }));
		expect(targetNode).toBeDefined();
		const actualAncestors: string[] = [];
		let parentKey = targetNode?.parentKey ?? null;
		while (parentKey) {
			actualAncestors.push(parentKey);
			parentKey = model.flatByKey.get(parentKey)?.parentKey ?? null;
		}
		expect(actualAncestors).toEqual([...ancestorPath].reverse().map(sidebarTreeKey));

		const persisted = JSON.parse(localStorage.getItem(SIDEBAR_TREE_STATE_STORAGE_KEY) || "{}") as {
			expansion?: Record<string, string>;
		};
		for (const key of expansionPath) expect(persisted.expansion?.[sidebarTreeKey(key)]).toBe("expanded");
		expect(persisted.expansion?.[sidebarTreeKey({ kind: "session", sessionId: "parent" })]).toBeUndefined();
		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
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

	it("cleans a superseded reduced-motion row without stripping the new target emphasis", async () => {
		vi.useFakeTimers();
		stubMotion(true);
		state.projects = [project("p")];
		state.gatewaySessions = [session("first"), session("second")];
		document.body.innerHTML = `
			<aside class="sidebar-edge">
				<div data-nav-id="session:first"></div>
				<div data-nav-id="session:second"></div>
			</aside>
		`;
		const first = document.querySelector<HTMLElement>('[data-nav-id="session:first"]')!;
		const second = document.querySelector<HTMLElement>('[data-nav-id="session:second"]')!;

		openSession("first");
		await revealCurrentSidebarSession();
		expect(first.classList.contains("sidebar-reveal-emphasis")).toBe(true);
		expect(first.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(true);

		vi.advanceTimersByTime(100);
		openSession("second");
		await revealCurrentSidebarSession();

		expect(first.classList.contains("sidebar-reveal-emphasis")).toBe(false);
		expect(first.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(false);
		expect(second.classList.contains("sidebar-reveal-emphasis")).toBe(true);
		expect(second.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(true);

		vi.advanceTimersByTime(140);
		expect(first.classList.contains("sidebar-reveal-emphasis")).toBe(false);
		expect(first.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(false);
		expect(second.classList.contains("sidebar-reveal-emphasis")).toBe(true);
		expect(second.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(true);
	});

	it("keeps a replayed row emphasized past the old cleanup and removes it with the new cleanup", async () => {
		vi.useFakeTimers();
		stubMotion(true);
		state.projects = [project("p")];
		state.gatewaySessions = [session("target")];
		openSession("target");
		const row = mountSessionRow("target");
		const addClass = vi.spyOn(row.classList, "add");

		await revealCurrentSidebarSession();
		vi.advanceTimersByTime(100);
		await revealCurrentSidebarSession();
		expect(addClass.mock.calls.filter(args => args.includes("sidebar-reveal-emphasis"))).toHaveLength(2);

		vi.advanceTimersByTime(140);
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(true);
		expect(row.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(true);

		vi.advanceTimersByTime(100);
		expect(row.classList.contains("sidebar-reveal-emphasis")).toBe(false);
		expect(row.classList.contains("sidebar-reveal-emphasis--reduced")).toBe(false);
	});
});
