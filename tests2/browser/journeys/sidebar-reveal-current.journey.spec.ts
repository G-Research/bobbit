import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

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
	unrelatedGoal: "reveal-filler-00",
	archived: "reveal-cold-archived",
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
		'const renderRevealFixture = () => {',
		'  const fixtureSessions = (window as any).__revealCanonicalSessions;',
		'  const fixtureGoals = (window as any).__revealCanonicalGoals;',
		'  if (fixtureSessions) state.gatewaySessions = fixtureSessions.map((value: any) => ({ ...value }));',
		'  if (fixtureGoals) state.goals = fixtureGoals.map((value: any) => ({ ...value }));',
		'  if (state.selectedSessionId && !state.remoteAgent) state.connectingSessionId = state.selectedSessionId;',
		'  doRenderApp();',
		'};',
		'setRenderApp(renderRevealFixture);',
		'// file:// cannot fetch the control\'s lazy chunk; expose that same production action to the fixture driver.',
		'(window as any).__revealCurrentSidebarSessionFixture = revealCurrentSidebarSession;',
		'(window as any).__renderRevealFixture = renderRevealFixture;',
		'(window as any).__revealTreeAncestors = (sessionId: string) => {',
		'  const model = buildSidebarTreeModel();',
		'  let node = model.flatByKey.get(sidebarTreeKey({ kind: "session", sessionId }));',
		'  const out: string[] = [];',
		'  while (node?.parentKey) { node = model.flatByKey.get(node.parentKey); if (node) out.push(node.key); }',
		'  return out;',
		'};',
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

function sessionChildrenKey(sessionId: string): string {
	return `sidebar-tree/v1/session-children/${encodeURIComponent(sessionId)}?childClass=delegate`;
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
		];
		state.gatewaySessions = [
			session(ids.teamLead, "Reveal team lead", 1_002, { goalId: ids.teamGoal, role: "team-lead" }),
			session(ids.delegate, "Reveal current delegate", 1_003, { delegateOf: ids.teamLead, role: "coder" }),
		];
		state.archivedSessions = [];
		(window as any).__revealCanonicalSessions = state.gatewaySessions.map((value: any) => ({ ...value }));
		(window as any).__revealCanonicalGoals = state.goals.map((value: any) => ({ ...value }));
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
		const originalFetch = window.fetch.bind(window);
		(window as any).__revealCanonicalSessions = null;
		(window as any).__revealCanonicalGoals = null;
		(window as any).__revealArchivedRequests = [];
		window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(raw, window.location.href);
			(window as any).__revealArchivedRequests.push(`${init?.method || "GET"} ${url.pathname}${url.search}`);
			if (url.pathname.endsWith(`/api/sessions/${ids.archived}`)) return Response.json(archived);
			if (url.pathname.endsWith("/api/sessions") && url.searchParams.get("include") === "archived") {
				return Response.json({ sessions: [archived], archivedDelegates: [], total: 1, hasMore: false, nextCursor: null });
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

		await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
		await setFilters(page, { teams: true });
		const statusRow = navRow(page, IDS.delegate);
		await expect(statusRow).toBeVisible();
		const statusSection = await statusRow.evaluate(element => element.closest<HTMLElement>("[data-status-section]")?.dataset.statusSection);
		expect(statusSection).toMatch(/^(pinned|unread|read)$/);
		const heading = page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`);
		await heading.click();
		await expect(heading).toHaveAttribute("aria-expanded", "false");
		await setFilters(page, { archived: true, busy: false, read: false, teams: true });
		await search.fill("status-query-that-cannot-match-current-delegate");
		await page.evaluate(() => { (window as any).__bobbitState.keyboardNavActiveId = "session:elsewhere"; });

		await activateReveal(page);
		await expect.poll(() => page.evaluate(() => (window as any).__bobbitState.searchQuery)).toBe("");
		await expectFilters(page, { archived: false, busy: true, read: true, teams: false });
		await expect(page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`)).toHaveAttribute("aria-expanded", "true");
		await expect(navRow(page, IDS.delegate)).toHaveAttribute("data-nav-active", "true");
		const collapsed = await page.evaluate(() => JSON.parse(localStorage.getItem("bobbit-status-collapsed-sections") || "[]"));
		expect(collapsed).not.toContain(statusSection);
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: Status leaves unrelated Project state alone`).toBe("collapsed");
	});

	test("cold archived reveal loads the terminated row, honors reduced motion, omits mobile control, and cleans fixture state", async ({ page }) => {
		await openFixture(page, { width: 1280, height: 430 });
		await injectArchivedTarget(page);
		await clickTreeToggle(page, treeKey("project", IDS.project));
		await expect(navRow(page, IDS.archived), `${MARK}: cold target is absent before reveal`).toHaveCount(0);
		await setFilters(page, { busy: false, read: false });
		const search = page.locator("input[data-search]");
		await search.fill("cold-archive-query-with-no-match");
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
		expect(await storedExpansion(page, treeKey("project", IDS.project))).toBe("expanded");
		expect(await storedExpansion(page, treeKey("project-archived", IDS.project))).toBe("expanded");

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
