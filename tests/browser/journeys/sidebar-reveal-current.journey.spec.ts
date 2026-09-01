import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../../../tests2/browser/fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-status-journey-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const GENERATED_ENTRY = path.join(BUNDLE_DIR, "sidebar-reveal-current-journey-entry.ts");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-reveal-current-journey-bundle.js");
const TREE_STATE_KEY = "bobbit-sidebar-tree-state:v1";
const MARK = "SIDEBAR_REVEAL_CURRENT_JOURNEY";

const IDS = {
	project: "sidebar-status-project",
	parentGoal: "reveal-parent-goal",
	teamGoal: "reveal-nested-team-goal",
	teamLead: "reveal-team-lead",
	delegate: "reveal-team-delegate",
	statusMember: "reveal-status-team-member",
	unrelatedGoal: "reveal-filler-00",
	unrelatedTeamGoal: "reveal-unrelated-team-goal",
	unrelatedTeamLead: "reveal-unrelated-team-lead",
	unrelatedTeamDelegate: "reveal-unrelated-team-delegate",
	unrelatedStatusMember: "reveal-unrelated-status-team-member",
	archived: "reveal-cold-archived",
	terminatedChild: "reveal-cached-terminated-child",
	unrelatedArchived: "reveal-unrelated-archived",
	deepProject: "reveal-deep-project",
	deepTeamGoal: "reveal-deep-team-goal",
	deepTeamLead: "reveal-deep-team-lead",
	deepSpawnedRoot: "reveal-deep-spawned-root",
	deepGoalPrefix: "reveal-deep-goal-",
	deepSession: "reveal-deep-session",
} as const;

const DEPS = [
	ENTRY,
	path.resolve("src/app/sidebar-reveal.ts"),
	path.resolve("src/app/sidebar.ts"),
	path.resolve("src/app/sidebar-tree-builder.ts"),
	path.resolve("src/app/sidebar-tree-state.ts"),
	path.resolve("src/app/sidebar-view-preferences.ts"),
	path.resolve("src/app/render.ts"),
	path.resolve("src/app/render-helpers.ts"),
	path.resolve("src/app/state.ts"),
	path.resolve("src/ui/components/sidebar-filters.ts"),
];

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	// The production control lazy-imports sidebar-reveal. Statically importing it
	// in the same IIFE keeps that click path executable from a file:// fixture
	// while retaining one canonical state module instance.
	fs.writeFileSync(GENERATED_ENTRY, [
		'import "../../../tests/ui-fixtures/sidebar-status-journey-fixture-entry.ts";',
		'import { revealCurrentSidebarSession } from "../../../src/app/sidebar-reveal.ts";',
		'import { buildSidebarTreeModel } from "../../../src/app/sidebar.ts";',
		'import { sidebarTreeKey } from "../../../src/app/sidebar-tree-builder.ts";',
		'import { setRenderApp, state } from "../../../src/app/state.ts";',
		'import { doRenderApp } from "../../../src/app/render.ts";',
		'import { clearArchivedSessionsState } from "../../../src/app/api.ts";',
		'(window as any).__clearRevealArchivedState = clearArchivedSessionsState;',
		'// Keep fixture-only canonical data/connecting state stable across async fixture fetches and transaction renders.',
		'let revealProjectionOccurrence = 0;',
		'const revealProjectionBarriers = new Map<number, { expected: boolean; archivedSessionId?: string; settled: boolean; joined: boolean; promise: Promise<void>; resolve: () => void }>();',
		'const renderRevealFixture = () => {',
		'  const fixtureSessions = (window as any).__revealCanonicalSessions;',
		'  const fixtureGoals = (window as any).__revealCanonicalGoals;',
		'  const fixtureArchivedSessions = (window as any).__revealCanonicalArchivedSessions;',
		'  if (fixtureSessions) state.gatewaySessions = fixtureSessions.map((value: any) => ({ ...value }));',
		'  if (fixtureGoals) state.goals = fixtureGoals.map((value: any) => ({ ...value }));',
		'  if (fixtureArchivedSessions) state.archivedSessions = fixtureArchivedSessions.map((value: any) => ({ ...value }));',
		'  if (state.selectedSessionId && !state.remoteAgent) state.connectingSessionId = state.selectedSessionId;',
		'  doRenderApp();',
		'  for (const barrier of revealProjectionBarriers.values()) {',
		'    const hasRequiredArchive = !barrier.archivedSessionId || state.archivedSessions.some((session: any) => session.id === barrier.archivedSessionId);',
		'    if (!barrier.settled && state.showArchived === barrier.expected && hasRequiredArchive) { barrier.settled = true; barrier.resolve(); }',
		'  }',
		'};',
		'setRenderApp(renderRevealFixture);',
		'// file:// cannot fetch the control\'s lazy chunk; expose that same production action to the fixture driver.',
		'(window as any).__revealCurrentSidebarSessionFixture = revealCurrentSidebarSession;',
		'(window as any).__renderRevealFixture = renderRevealFixture;',
		'(window as any).__armRevealArchivedProjection = (expected: boolean, archivedSessionId?: string) => {',
		'  const occurrence = ++revealProjectionOccurrence;',
		'  let resolve!: () => void;',
		'  const promise = new Promise<void>((done) => { resolve = done; });',
		'  revealProjectionBarriers.set(occurrence, { expected, archivedSessionId, settled: false, joined: false, promise, resolve });',
		'  return occurrence;',
		'};',
		'(window as any).__joinRevealArchivedProjection = async (occurrence: number) => {',
		'  const barrier = revealProjectionBarriers.get(occurrence);',
		'  if (!barrier) throw new Error(`Unknown reveal projection occurrence ${occurrence}`);',
		'  if (barrier.joined) throw new Error(`Reveal projection occurrence ${occurrence} was already joined`);',
		'  barrier.joined = true;',
		'  try { await barrier.promise; } finally { revealProjectionBarriers.delete(occurrence); }',
		'};',
		'(window as any).__revealTreeAncestors = (sessionId: string) => {',
		'  const model = buildSidebarTreeModel();',
		'  let node = model.flatByKey.get(sidebarTreeKey({ kind: "session", sessionId }));',
		'  const out: string[] = [];',
		'  while (node?.parentKey) { node = model.flatByKey.get(node.parentKey); if (node) out.push(node.key); }',
		'  return out;',
		'};',
		'(window as any).__revealTreeHas = (key: string) => buildSidebarTreeModel().flatByKey.has(key);',
	].join("\n"));
	buildBundle({ entry: GENERATED_ENTRY, outfile: BUNDLE, deps: [GENERATED_ENTRY, ...DEPS] });
});

test.afterEach(async ({ page }) => {
	await page.evaluate(async () => {
		localStorage.clear();
		window.history.replaceState({}, "", "#/settings");
		await (window as any).__resetSidebarStatusJourney?.();
	}).catch(() => {});
});

function treeKey(kind: "project" | "project-archived" | "goal" | "team-lead", id: string): string {
	return `sidebar-tree/v1/${kind}/${encodeURIComponent(id)}`;
}

function sessionChildrenKey(sessionId: string, childClass: "delegate" | "archived-delegate" = "delegate"): string {
	return `sidebar-tree/v1/session-children/${encodeURIComponent(sessionId)}?childClass=${childClass}`;
}

function navRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-nav-id="session:${sessionId}"]`).first();
}

function revealButton(page: Page): Locator {
	return page.getByTestId("sidebar-reveal-current-button");
}

async function activateReveal(page: Page): Promise<void> {
	// Invoke the rendered control's exact production action via the file-fixture
	// bridge; file:// cannot fetch the lazy JS chunk used by the real HTTP app.
	await page.evaluate(async () => {
		const state = (window as any).__bobbitState;
		const sessionId = (window as any).__revealActiveSessionId;
		if (sessionId) {
			state.selectedSessionId = sessionId;
			state.connectingSessionId = sessionId;
		}
		await (window as any).__revealCurrentSidebarSessionFixture();
		(window as any).__renderRevealFixture();
	});
}

async function openFixture(page: Page, viewport = { width: 1280, height: 420 }): Promise<void> {
	await page.setViewportSize(viewport);
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarStatusJourneyReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetSidebarStatusJourney());
	await installGeometryStyle(page);
	await expect(page.getByTestId("sidebar-expanded")).toBeVisible({ timeout: 5_000 });
}

async function reloadFixture(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarStatusJourneyReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetSidebarStatusJourney({ preserveStorage: true }));
	await installGeometryStyle(page);
}

async function installGeometryStyle(page: Page): Promise<void> {
	await page.addStyleTag({ content: `
		html, body, #app, .app-shell { height: 100%; max-height: 100vh; overflow: hidden; }
		.app-shell { display: flex; }
		.sidebar-edge { display: flex !important; flex-direction: column; height: 100vh; max-height: 100vh; width: 280px !important; }
		.sidebar-edge [data-project-reorder-list] { display: block !important; height: calc(100vh - 150px); min-height: 0; overflow-y: auto !important; }
		.sidebar-edge [data-nav-id] { min-height: 25px; box-sizing: border-box; }
		.hidden, [hidden] { display: none !important; }
	` });
}

async function renderInjectedView(page: Page, view: "project" | "status"): Promise<void> {
	if (view === "status") {
		await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
		return;
	}
	// Force a production render even when resetFixture already selected Project.
	await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
	await page.getByTestId("sidebar-view-project").evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByTestId("sidebar-view-project")).toHaveAttribute("aria-pressed", "true");
}

async function injectNestedTarget(page: Page, view: "project" | "status" = "project"): Promise<void> {
	await page.evaluate(({ ids, desiredView }) => {
		document.documentElement.dataset.subgoalsEnabled = "true";
		const state = (window as any).__bobbitState;
		const goal = (id: string, title: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
			id,
			title,
			cwd: "/tmp/sidebar-reveal-current",
			projectId: ids.project,
			state: "in-progress",
			spec: "Deterministic reveal-current browser journey fixture.",
			createdAt,
			updatedAt: createdAt,
			...extra,
		});
		const session = (id: string, title: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
			id,
			title,
			cwd: "/tmp/sidebar-reveal-current",
			projectId: ids.project,
			status: "idle",
			createdAt,
			lastActivity: createdAt,
			lastReadAt: createdAt + 1,
			clientCount: 0,
			server_tags: [],
			user_tags: [],
			...extra,
		});
		const fillers = Array.from({ length: 24 }, (_, index) =>
			goal(`reveal-filler-${String(index).padStart(2, "0")}`, `Reveal filler ${index}`, index + 1));
		state.goals = [
			...fillers,
			goal(ids.parentGoal, "Reveal nested parent", 1_000, { subgoalsAllowed: true, maxNestingDepth: 3 }),
			goal(ids.teamGoal, "Reveal nested team", 1_001, { parentGoalId: ids.parentGoal, team: true }),
			goal(ids.unrelatedTeamGoal, "Unrelated team", 1_004, { team: true }),
		];
		state.gatewaySessions = [
			session(ids.teamLead, "Reveal team lead", 1_002, { goalId: ids.teamGoal, role: "team-lead" }),
			session(ids.delegate, "Reveal current delegate", 1_003, { delegateOf: ids.teamLead, role: "coder" }),
			session(ids.unrelatedTeamLead, "Unrelated team lead", 1_005, { goalId: ids.unrelatedTeamGoal, role: "team-lead" }),
			session(ids.unrelatedTeamDelegate, "Unrelated team delegate", 1_006, { delegateOf: ids.unrelatedTeamLead, role: "coder" }),
		];
		state.archivedSessions = [session(ids.unrelatedArchived, "Unrelated archived session", 900, {
			status: "archived", archived: true, archivedAt: 1_900,
		})];
		(window as any).__revealCanonicalSessions = state.gatewaySessions.map((value: any) => ({ ...value }));
		(window as any).__revealCanonicalGoals = state.goals.map((value: any) => ({ ...value }));
		(window as any).__revealCanonicalArchivedSessions = state.archivedSessions.map((value: any) => ({ ...value }));
		(window as any).__revealActiveSessionId = ids.delegate;
		state.selectedSessionId = ids.delegate;
		state.connectingSessionId = ids.delegate;
		state.remoteAgent = null;
		state.keyboardNavActiveId = null;
		window.history.replaceState({}, "", `#/session/${ids.delegate}`);
		state.sidebarSessionView = desiredView === "project" ? "status" : "project";
	}, { ids: IDS, desiredView: view });
	await renderInjectedView(page, view);
	await expect(revealButton(page)).toBeEnabled();
}

async function injectStatusMemberTarget(page: Page): Promise<void> {
	await page.evaluate((ids) => {
		const state = (window as any).__bobbitState;
		const session = (id: string, title: string, createdAt: number, teamGoalId: string, teamLeadSessionId: string) => ({
			id,
			title,
			cwd: "/tmp/sidebar-reveal-current",
			projectId: ids.project,
			goalId: teamGoalId,
			teamGoalId,
			teamLeadSessionId,
			role: "coder",
			status: "idle",
			createdAt,
			lastActivity: createdAt,
			lastReadAt: createdAt + 1,
			clientCount: 0,
			server_tags: [],
			user_tags: [],
		});
		// These are ordinary team members with canonical ownership fields. Keep
		// the delegate-only Project target intact: delegateOf alone is deliberately
		// not team membership and must remain eligible when Show teams is off.
		const members = [
			session(ids.statusMember, "Reveal current team member", 1_007, ids.teamGoal, ids.teamLead),
			session(ids.unrelatedStatusMember, "Unrelated team member", 1_008, ids.unrelatedTeamGoal, ids.unrelatedTeamLead),
		];
		state.gatewaySessions = [
			...state.gatewaySessions.filter((value: any) => !members.some(member => member.id === value.id)),
			...members,
		];
		(window as any).__revealCanonicalSessions = state.gatewaySessions.map((value: any) => ({ ...value }));
		(window as any).__revealActiveSessionId = ids.statusMember;
		state.selectedSessionId = ids.statusMember;
		state.connectingSessionId = ids.statusMember;
		state.remoteAgent = null;
		state.keyboardNavActiveId = null;
		state.sidebarRevealSessionId = null;
		window.history.replaceState({}, "", `#/session/${ids.statusMember}`);
		(window as any).__renderRevealFixture();
	}, IDS);
	await expect(revealButton(page)).toBeEnabled();
}

async function injectTerminatedChildTarget(page: Page): Promise<void> {
	await injectNestedTarget(page);
	await page.evaluate((ids) => {
		const state = (window as any).__bobbitState;
		const terminated = {
			id: ids.terminatedChild,
			title: "Recently terminated delegate",
			cwd: "/tmp/sidebar-reveal-current",
			projectId: ids.project,
			delegateOf: ids.teamLead,
			role: "coder",
			status: "terminated",
			archived: false,
			createdAt: 1_009,
			lastActivity: 1_009,
			lastReadAt: 1_010,
			clientCount: 0,
			server_tags: [],
			user_tags: [],
		};
		state.gatewaySessions = [
			...state.gatewaySessions.filter((value: any) => value.id !== terminated.id),
			terminated,
		];
		// Let production own the terminal record's cache migration during the
		// action; the fixture renderer must not overwrite that canonical move.
		(window as any).__revealCanonicalSessions = null;
		(window as any).__revealCanonicalGoals = null;
		(window as any).__revealCanonicalArchivedSessions = null;
		(window as any).__revealTerminatedRequests = [];
		const originalFetch = window.fetch.bind(window);
		window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(raw, window.location.href);
			(window as any).__revealTerminatedRequests.push(`${init?.method || "GET"} ${url.pathname}${url.search}`);
			if (url.pathname.endsWith(`/api/sessions/${ids.terminatedChild}`)) return Response.json(terminated);
			return originalFetch(input, init);
		}) as typeof window.fetch;
		(window as any).__revealActiveSessionId = ids.terminatedChild;
		state.selectedSessionId = ids.terminatedChild;
		state.connectingSessionId = ids.terminatedChild;
		state.remoteAgent = null;
		state.keyboardNavActiveId = null;
		state.sidebarRevealSessionId = null;
		window.history.replaceState({}, "", `#/session/${ids.terminatedChild}`);
		(window as any).__renderRevealFixture();
	}, IDS);
	await expect(revealButton(page)).toBeEnabled();
}

async function injectArchivedTarget(page: Page): Promise<void> {
	await page.evaluate((ids) => {
		const state = (window as any).__bobbitState;
		(window as any).__clearRevealArchivedState();
		const archived = {
			id: ids.archived,
			title: "Cold terminated session",
			cwd: "/tmp/sidebar-reveal-current",
			projectId: ids.project,
			status: "archived",
			archived: true,
			archivedAt: 2_000,
			createdAt: 1_000,
			lastActivity: 1_000,
			lastReadAt: 1_001,
			clientCount: 0,
			server_tags: [],
			user_tags: [],
		};
		const unrelatedArchived = {
			...archived,
			id: ids.unrelatedArchived,
			title: "Unrelated cold archived session",
			archivedAt: 1_900,
			createdAt: 900,
			lastActivity: 900,
			lastReadAt: 901,
		};
		const originalFetch = window.fetch.bind(window);
		(window as any).__revealCanonicalSessions = null;
		(window as any).__revealCanonicalGoals = null;
		(window as any).__revealCanonicalArchivedSessions = null;
		(window as any).__revealArchivedRequests = [];
		window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(raw, window.location.href);
			(window as any).__revealArchivedRequests.push(`${init?.method || "GET"} ${url.pathname}${url.search}`);
			if (url.pathname.endsWith(`/api/sessions/${ids.archived}`)) return Response.json(archived);
			if (url.pathname.endsWith("/api/sessions") && url.searchParams.get("include") === "archived") {
				return Response.json({ sessions: [archived, unrelatedArchived], archivedDelegates: [], total: 2, hasMore: false, nextCursor: null });
			}
			if (url.pathname.endsWith("/api/goals") && url.searchParams.get("archived") === "true") {
				return Response.json({ goals: [], total: 0, hasMore: false, nextCursor: null });
			}
			return originalFetch(input, init);
		}) as typeof window.fetch;
		state.gatewaySessions = [];
		state.archivedSessions = [];
		state.goals = [];
		(window as any).__revealActiveSessionId = ids.archived;
		state.selectedSessionId = ids.archived;
		state.connectingSessionId = ids.archived;
		state.remoteAgent = null;
		state.sidebarSessionView = "status";
		window.history.replaceState({}, "", `#/session/${ids.archived}`);
	}, IDS);
	await renderInjectedView(page, "project");
	await expect(revealButton(page)).toBeEnabled();
}

async function injectDeepTarget(page: Page): Promise<string[]> {
	const goalIds = Array.from({ length: 7 }, (_, index) => `${IDS.deepGoalPrefix}${index}`);
	await page.evaluate(({ ids, deepGoalIds }) => {
		document.documentElement.dataset.subgoalsEnabled = "true";
		const state = (window as any).__bobbitState;
		const project = {
			id: ids.deepProject,
			name: "Deep Reveal Project",
			rootPath: "/tmp/sidebar-reveal-deep",
			colorLight: "#2563eb",
			colorDark: "#60a5fa",
		};
		const goal = (id: string, title: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
			id,
			title,
			cwd: project.rootPath,
			projectId: project.id,
			state: "in-progress",
			spec: "Seven-level spawned-goal reveal fixture.",
			createdAt,
			updatedAt: createdAt,
			...extra,
		});
		const session = (id: string, title: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
			id,
			title,
			cwd: project.rootPath,
			projectId: project.id,
			status: "idle",
			createdAt,
			lastActivity: createdAt,
			lastReadAt: createdAt + 1,
			clientCount: 0,
			server_tags: [],
			user_tags: [],
			...extra,
		});
		const fillers = Array.from({ length: 24 }, (_, index) =>
			goal(`reveal-deep-filler-${String(index).padStart(2, "0")}`, `Deep filler ${index}`, index + 1));
		const teamGoal = goal(ids.deepTeamGoal, "Deep spawning team", 900, {
			team: true,
			teamLeadSessionId: ids.deepTeamLead,
			subgoalsAllowed: true,
			maxNestingDepth: 9,
		});
		const spawnedRoot = goal(ids.deepSpawnedRoot, "Deep spawned root", 1_000, {
			parentGoalId: ids.deepTeamGoal,
			spawnedBySessionId: ids.deepTeamLead,
			subgoalsAllowed: true,
		});
		const chain = deepGoalIds.map((id, index) => goal(id, `Deep descendant ${index + 1}`, 1_001 + index, {
			parentGoalId: index === 0 ? ids.deepSpawnedRoot : deepGoalIds[index - 1],
			subgoalsAllowed: true,
		}));
		state.projects = [...state.projects.filter((value: any) => value.id !== project.id), project];
		state.goals = [...fillers, teamGoal, spawnedRoot, ...chain];
		state.gatewaySessions = [
			session(ids.deepTeamLead, "Deep spawning lead", 901, {
				goalId: ids.deepTeamGoal,
				teamGoalId: ids.deepTeamGoal,
				role: "team-lead",
			}),
			session(ids.deepSession, "Deepest current session", 2_000, { goalId: deepGoalIds.at(-1) }),
		];
		state.archivedSessions = [];
		(window as any).__revealCanonicalSessions = state.gatewaySessions.map((value: any) => ({ ...value }));
		(window as any).__revealCanonicalGoals = state.goals.map((value: any) => ({ ...value }));
		(window as any).__revealCanonicalArchivedSessions = [];
		(window as any).__revealActiveSessionId = ids.deepSession;
		state.selectedSessionId = ids.deepSession;
		state.connectingSessionId = ids.deepSession;
		state.remoteAgent = null;
		state.keyboardNavActiveId = null;
		state.sidebarSessionView = "status";
		window.history.replaceState({}, "", `#/session/${ids.deepSession}`);
	}, { ids: IDS, deepGoalIds: goalIds });
	await renderInjectedView(page, "project");
	await expect(revealButton(page)).toBeEnabled();
	return goalIds;
}

async function setFilters(page: Page, values: Partial<Record<"archived" | "busy" | "read" | "teams", boolean>>): Promise<void> {
	await page.evaluate((next) => {
		const state = (window as any).__bobbitState;
		const status = state.sidebarSessionView === "status";
		const stateKeys = status
			? { archived: "statusShowArchived", busy: "statusShowBusy", read: "statusShowRead", teams: "statusShowTeams" }
			: { archived: "showArchived", busy: "showBusy", read: "showRead", teams: "statusShowTeams" };
		const storageKeys = status
			? { archived: "bobbit-status-show-archived", busy: "bobbit-status-show-busy", read: "bobbit-status-show-read", teams: "bobbit-status-show-teams" }
			: { archived: "bobbit-show-archived", busy: "bobbit-show-busy", read: "bobbit-show-read", teams: "bobbit-status-show-teams" };
		for (const [key, value] of Object.entries(next)) {
			state[stateKeys[key as keyof typeof stateKeys]] = value;
			localStorage.setItem(storageKeys[key as keyof typeof storageKeys], String(value));
		}
		(window as any).__renderRevealFixture();
	}, values);
}

async function expectFilters(page: Page, values: Partial<Record<"archived" | "busy" | "read" | "teams", boolean>>): Promise<void> {
	const actual = await page.evaluate(() => {
		const state = (window as any).__bobbitState;
		return state.sidebarSessionView === "status"
			? { archived: state.statusShowArchived, busy: state.statusShowBusy, read: state.statusShowRead, teams: state.statusShowTeams }
			: { archived: state.showArchived, busy: state.showBusy, read: state.showRead };
	});
	for (const [id, checked] of Object.entries(values)) expect(actual[id as keyof typeof actual], `${MARK}: ${id} reset`).toBe(checked);
}

async function armArchivedProjection(page: Page, expected: boolean, archivedSessionId?: string): Promise<number> {
	return page.evaluate(
		({ value, sessionId }) => (window as any).__armRevealArchivedProjection(value, sessionId),
		{ value: expected, sessionId: archivedSessionId },
	);
}

async function joinArchivedProjection(page: Page, occurrence: number): Promise<void> {
	await page.evaluate((value) => (window as any).__joinRevealArchivedProjection(value), occurrence);
}

async function storedExpansion(page: Page, key: string): Promise<string | undefined> {
	return page.evaluate(({ storageKey, key }) => {
		try { return JSON.parse(localStorage.getItem(storageKey) || "{}").expansion?.[key]; }
		catch { return undefined; }
	}, { storageKey: TREE_STATE_KEY, key });
}

async function clickTreeToggle(page: Page, key: string): Promise<void> {
	const node = page.locator(`[data-tree-key="${key}"]`).first();
	await expect(node, `${MARK}: tree node ${key} is rendered`).toBeVisible();
	if (key.includes("/project/")) await node.getByTestId("project-header").click();
	else await node.locator(".sidebar-chevron-slot").first().click();
}

async function installRevealProbes(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((targetNavId) => {
		const matchesTarget = (node: Node): node is HTMLElement => node instanceof HTMLElement && node.dataset.navId === targetNavId;
		(window as any).__revealEmphasisCount = 0;
		(window as any).__revealReducedCount = 0;
		(window as any).__revealScrollCalls = [];
		new MutationObserver((records) => {
			for (const record of records) {
				if (!matchesTarget(record.target) || !record.target.classList.contains("sidebar-reveal-emphasis")) continue;
				(window as any).__revealEmphasisCount++;
				if (record.target.classList.contains("sidebar-reveal-emphasis--reduced")) (window as any).__revealReducedCount++;
			}
		}).observe(document.documentElement, { attributes: true, attributeFilter: ["class"], subtree: true });
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function patched(options?: boolean | ScrollIntoViewOptions) {
			if (matchesTarget(this)) {
				const container = document.querySelector<HTMLElement>(".sidebar-edge [data-project-reorder-list]");
				const rowRect = this.getBoundingClientRect();
				const containerRect = container?.getBoundingClientRect();
				(window as any).__revealScrollCalls.push({
					options: options ?? null,
					wasWithin: !!containerRect && rowRect.top >= containerRect.top - 1 && rowRect.bottom <= containerRect.bottom + 1,
					overflowing: !!container && container.scrollHeight - container.clientHeight > 4,
				});
			}
			return original.call(this, options as any);
		};
	}, `session:${sessionId}`);
}

async function waitForEmphasisToFinish(page: Page, sessionId: string): Promise<void> {
	await expect(navRow(page, sessionId)).not.toHaveClass(/sidebar-reveal-emphasis/, { timeout: 2_000 });
}

async function expectRowWithinSidebar(page: Page, sessionId: string): Promise<void> {
	await expect.poll(() => page.evaluate((navId) => {
		const container = document.querySelector<HTMLElement>(".sidebar-edge [data-project-reorder-list]");
		const row = document.querySelector<HTMLElement>(`.sidebar-edge [data-nav-id="${navId}"]`);
		if (!container || !row) return false;
		const outer = container.getBoundingClientRect();
		const inner = row.getBoundingClientRect();
		return inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
	}, `session:${sessionId}`), { timeout: 3_000 }).toBe(true);
}

test.describe("Journey: Reveal current sidebar session", () => {
	test("desktop Project and Status reveal the collapsed off-screen nested delegate and persist only its path", async ({ page }) => {
		await openFixture(page);
		await expect(revealButton(page), `${MARK}: desktop control is beside Filters`).toBeVisible();
		await expect(revealButton(page), `${MARK}: settings route has no active session`).toBeDisabled();
		await expect(revealButton(page)).toHaveAttribute("title", /open a session/i);

		await injectNestedTarget(page);
		await expect(revealButton(page)).toHaveAttribute("title", "Reveal current session in sidebar");

		// First reveal materializes the full production path. Collapse it through
		// production UI toggles so the second click proves explicit force-expand.
		await activateReveal(page);
		await expect(navRow(page, IDS.delegate)).toBeVisible({ timeout: 3_000 });
		await waitForEmphasisToFinish(page, IDS.delegate);
		const pathKeys = [
			treeKey("project", IDS.project),
			treeKey("goal", IDS.parentGoal),
			treeKey("goal", IDS.teamGoal),
			treeKey("team-lead", IDS.teamLead),
			sessionChildrenKey(IDS.teamLead),
		];
		const resolvedPath = await page.evaluate((sessionId) => (window as any).__revealTreeAncestors(sessionId), IDS.delegate);
		expect(resolvedPath).toEqual([...pathKeys].reverse());
		const unrelatedKey = treeKey("goal", IDS.unrelatedGoal);
		await clickTreeToggle(page, unrelatedKey);
		await clickTreeToggle(page, unrelatedKey);
		await clickTreeToggle(page, treeKey("goal", IDS.teamGoal));
		await clickTreeToggle(page, treeKey("goal", IDS.parentGoal));
		const container = page.locator(".sidebar-edge [data-project-reorder-list]");
		await container.evaluate(element => { (element as HTMLElement).scrollTop = 0; });
		await clickTreeToggle(page, treeKey("project", IDS.project));
		await expect(navRow(page, IDS.delegate)).toHaveCount(0);

		await setFilters(page, { busy: false, read: false });
		const search = page.locator("input[data-search]");
		await search.fill("query-that-cannot-match-current-delegate");
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("query-that-cannot-match-current-delegate");
		await page.evaluate(() => { (window as any).__bobbitState.keyboardNavActiveId = "goal:elsewhere"; });
		await installRevealProbes(page, IDS.delegate);

		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("");
		for (const key of pathKeys) await expect.poll(() => storedExpansion(page, key), { message: key }).toBe("expanded");
		await expect(search).toHaveValue("");
		await expectFilters(page, { archived: false, busy: true, read: true });
		const canonicalIds = await page.evaluate(() => ({
			goals: (window as any).__bobbitState.goals.map((goal: any) => goal.id),
			sessions: (window as any).__bobbitState.gatewaySessions.map((session: any) => session.id),
		}));
		expect(canonicalIds.goals).toContain(IDS.teamGoal);
		expect(canonicalIds.sessions).toContain(IDS.delegate);
		const renderedNavIds = await page.locator(".sidebar-edge [data-nav-id]").evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.navId));
		expect(renderedNavIds).toContain(`session:${IDS.delegate}`);
		const target = navRow(page, IDS.delegate);
		await expect(target).toBeVisible({ timeout: 3_000 });
		await expect(target).toHaveAttribute("data-nav-active", "true");
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.keyboardNavActiveId)).toBe(`session:${IDS.delegate}`);
		await expectRowWithinSidebar(page, IDS.delegate);
		for (const key of pathKeys) expect(await storedExpansion(page, key), key).toBe("expanded");
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: unrelated collapse is unchanged`).toBe("collapsed");
		await expect.poll(() => page.evaluate(() => (window as any).__revealEmphasisCount)).toBeGreaterThanOrEqual(1);
		const firstScroll = await page.evaluate(() => (window as any).__revealScrollCalls.at(-1));
		expect(firstScroll).toMatchObject({ options: { behavior: "smooth", block: "nearest" }, wasWithin: false, overflowing: true });

		await waitForEmphasisToFinish(page, IDS.delegate);
		const scrollBeforeRepeat = await container.evaluate(element => (element as HTMLElement).scrollTop);
		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__revealEmphasisCount)).toBeGreaterThanOrEqual(2);
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		expect(await container.evaluate(element => (element as HTMLElement).scrollTop), `${MARK}: nearest repeat does not jump`).toBe(scrollBeforeRepeat);

		// A real document reload reloads tree-state from localStorage. Reinjecting
		// only canonical data mirrors gateway hydration without gateway process cost.
		await reloadFixture(page);
		await injectNestedTarget(page);
		await expect(navRow(page, IDS.delegate), `${MARK}: explicit path survives reload`).toBeVisible({ timeout: 3_000 });
		for (const key of pathKeys) expect(await storedExpansion(page, key), key).toBe("expanded");
		expect(await storedExpansion(page, unrelatedKey)).toBe("collapsed");

		// Status categorical coverage needs a canonical member. The nested Project
		// target above intentionally has only delegateOf, which is not team membership.
		await injectStatusMemberTarget(page);
		await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
		await expectFilters(page, { archived: false, busy: true, read: true, teams: false });
		await expect(navRow(page, IDS.statusMember), `${MARK}: default Status categories hide the active canonical team member before reveal`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedStatusMember), `${MARK}: default Status categories hide an unrelated canonical team member`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedArchived), `${MARK}: default Status categories hide unrelated archives`).toHaveCount(0);
		await expect(navRow(page, IDS.delegate), `${MARK}: delegateOf alone remains visible when Show teams is off`).toBeVisible();

		await activateReveal(page);
		const statusRow = navRow(page, IDS.statusMember);
		await expect(statusRow, `${MARK}: explicit Status reveal narrowly includes the active canonical team member`).toBeVisible();
		await expect(navRow(page, IDS.unrelatedStatusMember), `${MARK}: explicit Status reveal does not include an unrelated canonical team member`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedArchived), `${MARK}: explicit Status reveal does not include unrelated archives`).toHaveCount(0);
		await expect(navRow(page, IDS.delegate), `${MARK}: exact inclusion leaves the non-member delegate eligible`).toBeVisible();

		// A real categorical filter gesture ends the one-action inclusion. Turning
		// archives on proves normal filter authority: the archive appears while the
		// still-filtered canonical team target disappears.
		await page.getByTestId("sidebar-filters-button").click();
		await page.getByTestId("sidebar-filter-archived").locator("input").check();
		await expect(navRow(page, IDS.statusMember), `${MARK}: manual category interaction clears narrow inclusion`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedStatusMember), `${MARK}: manual category interaction keeps unrelated members filtered`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedArchived), `${MARK}: manual category interaction restores normal filter authority`).toBeVisible();
		await page.getByTestId("sidebar-filter-archived").locator("input").uncheck();
		await page.keyboard.press("Escape");

		await activateReveal(page);
		await expect(statusRow).toBeVisible();
		const statusSection = await statusRow.evaluate(element => element.closest<HTMLElement>("[data-status-section]")?.dataset.statusSection);
		expect(statusSection).toMatch(/^(pinned|unread|read)$/);
		const heading = page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`);
		await heading.click();
		await expect(heading).toHaveAttribute("aria-expanded", "false");
		await setFilters(page, { archived: true, busy: false, read: false, teams: true });
		await search.fill("status-query-that-cannot-match-current-member");
		await page.evaluate(() => { (window as any).__bobbitState.keyboardNavActiveId = "session:elsewhere"; });

		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("");
		await expectFilters(page, { archived: false, busy: true, read: true, teams: false });
		await expect(page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`)).toHaveAttribute("aria-expanded", "true");
		await expect(navRow(page, IDS.statusMember)).toHaveAttribute("data-nav-active", "true");
		const collapsed = await page.evaluate(() => JSON.parse(localStorage.getItem("bobbit-status-collapsed-sections") || "[]"));
		expect(collapsed).not.toContain(statusSection);
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: Status leaves unrelated Project state alone`).toBe("collapsed");
	});

	test("explicit reveal exceeds the spawned-goal depth cap and persists only the seven-level team path", async ({ page }) => {
		await openFixture(page);
		const deepGoalIds = await injectDeepTarget(page);
		const unrelatedProjectKey = treeKey("project", IDS.project);
		await clickTreeToggle(page, unrelatedProjectKey);
		expect(await storedExpansion(page, unrelatedProjectKey)).toBe("collapsed");

		// This is canonical team ownership, not a plain forest: the root is stamped
		// to its team's lead and is rendered beneath that lead. The spawned subtree's
		// default cap is five, so descendant level six and the deepest session clip.
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), treeKey("goal", IDS.deepTeamGoal))).toBe(true);
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), treeKey("team-lead", IDS.deepTeamLead))).toBe(true);
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), treeKey("goal", IDS.deepSpawnedRoot))).toBe(true);
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), treeKey("goal", deepGoalIds[4]))).toBe(true);
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), treeKey("goal", deepGoalIds[5]))).toBe(false);
		expect(await page.evaluate((key) => (window as any).__revealTreeHas(key), `sidebar-tree/v1/session/${encodeURIComponent(IDS.deepSession)}`)).toBe(false);
		await expect(navRow(page, IDS.deepSession)).toHaveCount(0);

		const container = page.locator(".sidebar-edge [data-project-reorder-list]");
		await container.evaluate(element => { (element as HTMLElement).scrollTop = 0; });
		await installRevealProbes(page, IDS.deepSession);
		await activateReveal(page);

		const pathKeys = [
			treeKey("project", IDS.deepProject),
			treeKey("goal", IDS.deepTeamGoal),
			treeKey("team-lead", IDS.deepTeamLead),
			treeKey("goal", IDS.deepSpawnedRoot),
			...deepGoalIds.map(id => treeKey("goal", id)),
		];
		const resolvedPath = await page.evaluate((sessionId) => (window as any).__revealTreeAncestors(sessionId), IDS.deepSession);
		expect(resolvedPath, `${MARK}: canonical project/team-lead/spawned/goal path`).toEqual([...pathKeys].reverse());
		await expect(navRow(page, IDS.deepSession), `${MARK}: explicit reveal renders the clipped spawned target`).toBeVisible({ timeout: 3_000 });
		await expect(navRow(page, IDS.deepSession)).toHaveAttribute("data-nav-active", "true");
		await expectRowWithinSidebar(page, IDS.deepSession);
		await expect.poll(() => page.evaluate(() => (window as any).__revealEmphasisCount)).toBeGreaterThanOrEqual(1);
		for (const key of pathKeys) {
			expect(await storedExpansion(page, key), `${MARK}: target path persists ${key}`).toBe("expanded");
		}
		expect(await storedExpansion(page, unrelatedProjectKey), `${MARK}: reveal preserves the unrelated project sentinel`).toBe("collapsed");
		const deepScroll = await page.evaluate(() => (window as any).__revealScrollCalls.at(-1));
		expect(deepScroll).toMatchObject({ options: { behavior: "smooth", block: "nearest" }, wasWithin: false, overflowing: true });

		// Reload creates fresh module-local depth state. Reinject only the static
		// canonical gateway fixture; the durable reveal depth and ancestor path
		// must be sufficient to render the clipped target without another reveal.
		await reloadFixture(page);
		expect(await injectDeepTarget(page)).toEqual(deepGoalIds);
		await expect(navRow(page, IDS.deepSession), `${MARK}: persisted depth renders the deepest target after reload`).toBeVisible({ timeout: 3_000 });
		await expect(navRow(page, IDS.deepSession)).toHaveAttribute("data-nav-active", "true");
		const rehydratedPath = await page.evaluate((sessionId) => (window as any).__revealTreeAncestors(sessionId), IDS.deepSession);
		expect(rehydratedPath, `${MARK}: reload restores the exact deep ancestor path`).toEqual([...pathKeys].reverse());
		for (const key of pathKeys) {
			expect(await storedExpansion(page, key), `${MARK}: reload preserves target path ${key}`).toBe("expanded");
		}
		expect(await storedExpansion(page, unrelatedProjectKey), `${MARK}: reload preserves unrelated collapsed sentinel`).toBe("collapsed");
	});

	test("terminated child and cold archived reveals use archived hierarchy, reduced motion, and mobile cleanup", async ({ page }) => {
		await openFixture(page, { width: 1280, height: 430 });

		await injectTerminatedChildTarget(page);
		const unrelatedKey = treeKey("goal", IDS.unrelatedGoal);
		await clickTreeToggle(page, unrelatedKey);
		await clickTreeToggle(page, unrelatedKey);
		expect(await storedExpansion(page, unrelatedKey)).toBe("collapsed");
		await expect(navRow(page, IDS.terminatedChild), `${MARK}: cached terminated child is filtered before reveal`).toHaveCount(0);
		const container = page.locator(".sidebar-edge [data-project-reorder-list]");
		await container.evaluate(element => { (element as HTMLElement).scrollTop = 0; });
		await installRevealProbes(page, IDS.terminatedChild);

		await activateReveal(page);
		const terminatedPath = [
			treeKey("project", IDS.project),
			treeKey("goal", IDS.parentGoal),
			treeKey("goal", IDS.teamGoal),
			treeKey("team-lead", IDS.teamLead),
			sessionChildrenKey(IDS.teamLead, "archived-delegate"),
		];
		const terminatedRow = navRow(page, IDS.terminatedChild);
		await expect(terminatedRow, `${MARK}: status=terminated archived=false child is revealed`).toBeVisible({ timeout: 3_000 });
		await expect(terminatedRow).toHaveAttribute("data-nav-active", "true");
		await expectRowWithinSidebar(page, IDS.terminatedChild);
		const terminatedAncestors = await page.evaluate((sessionId) => (window as any).__revealTreeAncestors(sessionId), IDS.terminatedChild);
		expect(terminatedAncestors, `${MARK}: terminated child uses archived-child hierarchy`).toEqual([...terminatedPath].reverse());
		for (const key of terminatedPath) expect(await storedExpansion(page, key), key).toBe("expanded");
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: terminated reveal preserves unrelated collapse`).toBe("collapsed");
		await expect.poll(() => page.evaluate(() => (window as any).__revealEmphasisCount)).toBeGreaterThanOrEqual(1);
		const terminatedScroll = await page.evaluate(() => (window as any).__revealScrollCalls.at(-1));
		expect(terminatedScroll).toMatchObject({ options: { behavior: "smooth", block: "nearest" }, wasWithin: false, overflowing: true });
		const terminatedCache = await page.evaluate((id) => {
			const state = (window as any).__bobbitState;
			return {
				live: state.gatewaySessions.some((session: any) => session.id === id),
				archived: state.archivedSessions.some((session: any) => session.id === id),
				requests: (window as any).__revealTerminatedRequests as string[],
			};
		}, IDS.terminatedChild);
		expect(terminatedCache).toMatchObject({ live: false, archived: true });
		expect(terminatedCache.requests.some(value => value.includes(`/api/sessions/${IDS.terminatedChild}`)), `${MARK}: terminal target exact hydration`).toBe(true);

		// Keep the genuinely archived cold-load case separate from the cached
		// status=terminated child path above while reusing the same fixture boot.
		await injectArchivedTarget(page);
		await clickTreeToggle(page, treeKey("project", IDS.project));
		await expect(navRow(page, IDS.archived), `${MARK}: cold target is absent before reveal`).toHaveCount(0);
		await setFilters(page, { busy: false, read: false });
		const search = page.locator("input[data-search]");
		await search.fill("cold-archive-query-with-no-match");
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("cold-archive-query-with-no-match");
		await installRevealProbes(page, IDS.archived);

		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("");
		const requests = await page.evaluate(() => (window as any).__revealArchivedRequests as string[]);
		expect(requests.some(value => value.includes(`/api/sessions/${IDS.archived}`)), `${MARK}: exact target hydration`).toBe(true);
		expect(requests.some(value => value.includes("/api/sessions?") && value.includes("include=archived")), `${MARK}: archived page hydration`).toBe(true);
		expect(requests.some(value => value.includes("/api/goals?") && value.includes("archived=true")), `${MARK}: archived goals hydration`).toBe(true);
		const archivedRow = navRow(page, IDS.archived);
		await expect(archivedRow).toBeVisible({ timeout: 3_000 });
		await expect(archivedRow).toHaveAttribute("data-nav-active", "true");
		await expect(navRow(page, IDS.unrelatedArchived), `${MARK}: archived reveal includes exactly the cold target`).toHaveCount(0);
		expect(await storedExpansion(page, treeKey("project", IDS.project))).toBe("expanded");
		expect(await storedExpansion(page, treeKey("project-archived", IDS.project))).toBe("expanded");

		// Exercise the actual categorical control rather than mutating fixture
		// state: after Show archived is toggled on then off, the explicit one-shot
		// inclusion is gone and the default filter hides the active archive again.
		await page.getByTestId("sidebar-filters-button").click();
		const archivedCheckbox = page.getByTestId("sidebar-filter-archived").locator("input");
		const shownProjection = await armArchivedProjection(page, true, IDS.unrelatedArchived);
		await archivedCheckbox.check();
		const archivedFilterState = await page.evaluate((unrelatedArchivedId) => {
			const state = (window as any).__bobbitState;
			return {
				showArchived: state.showArchived,
				cachedUnrelatedArchived: state.archivedSessions.some((session: any) => session.id === unrelatedArchivedId),
			};
		}, IDS.unrelatedArchived);
		expect(archivedFilterState, `${MARK}: archive filter handler updates canonical state`).toEqual({
			showArchived: true,
			cachedUnrelatedArchived: true,
		});
		// Join the exact fixture render occurrence that committed the handler's
		// true-state projection before inspecting the newly eligible DOM row.
		await joinArchivedProjection(page, shownProjection);
		await expect(navRow(page, IDS.unrelatedArchived)).toBeVisible();
		const hiddenProjection = await armArchivedProjection(page, false);
		await archivedCheckbox.uncheck();
		await joinArchivedProjection(page, hiddenProjection);
		await expect(navRow(page, IDS.archived), `${MARK}: manual archive interaction restores default filter authority`).toHaveCount(0);
		await expect(navRow(page, IDS.unrelatedArchived)).toHaveCount(0);
		await page.keyboard.press("Escape");
		await activateReveal(page);
		await expect(archivedRow).toBeVisible();
		await expect(navRow(page, IDS.unrelatedArchived)).toHaveCount(0);

		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.evaluate(() => { (window as any).__revealScrollCalls = []; });
		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__revealReducedCount)).toBeGreaterThanOrEqual(1);
		const reducedScroll = await page.evaluate(() => (window as any).__revealScrollCalls.at(-1));
		expect(reducedScroll.options).toMatchObject({ behavior: "auto", block: "nearest" });
		const reducedAnimation = await archivedRow.evaluate(element => {
			const style = getComputedStyle(element);
			return { name: style.animationName, duration: style.animationDuration };
		});
		expect(reducedAnimation.name === "none" || reducedAnimation.duration.split(",").every(value => Number.parseFloat(value) === 0)).toBe(true);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => (window as any).__renderMobileSidebarStatusJourney());
		await expect(revealButton(page), `${MARK}: mobile omits target control entirely`).toHaveCount(0);

		const cleanup = await page.evaluate(async () => {
			localStorage.clear();
			window.history.replaceState({}, "", "#/settings");
			await (window as any).__resetSidebarStatusJourney();
			return { search: (window as any).__bobbitState.searchQuery, hash: window.location.hash };
		});
		expect(cleanup).toEqual({ search: "", hash: "#/settings" });
	});
});
