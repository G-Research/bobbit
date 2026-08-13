import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	startTeam,
	teardownTeam,
	waitForHealth,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "../fixtures/ui-helpers.js";

const TREE_STATE_KEY = "bobbit-sidebar-tree-state:v1";
const MARK = "SIDEBAR_REVEAL_CURRENT_JOURNEY";
const SPEC = "Browser journey fixture for explicitly revealing the current session in a deeply collapsed sidebar tree.";
const FILLER_GOAL_COUNT = 8;

type Fixture = {
	projectId: string;
	parentGoalId: string;
	teamGoalId: string;
	teamLeadSessionId: string;
	delegateSessionId: string;
	archivedCandidateSessionId: string;
	unrelatedGoalId: string;
	fillerGoalIds: string[];
};

let fixture: Fixture;
const createdGoalIds: string[] = [];
const createdSessionIds: string[] = [];

function treeKey(kind: "project" | "project-archived" | "goal" | "team-lead", id: string): string {
	return `sidebar-tree/v1/${kind}/${encodeURIComponent(id)}`;
}

function sessionChildrenKey(sessionId: string, childClass: "delegate" | "archived-delegate"): string {
	return `sidebar-tree/v1/session-children/${encodeURIComponent(sessionId)}?childClass=${childClass}`;
}

async function createChildGoal(projectId: string, parentGoalId: string, title: string, team: boolean): Promise<string> {
	const response = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			spec: SPEC,
			projectId,
			parentGoalId,
			team,
			worktree: false,
			autoStartTeam: false,
		}),
	});
	expect(response.status, `${MARK}: create nested goal: ${await response.clone().text()}`).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function createDelegate(parentSessionId: string, title: string): Promise<string> {
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentSessionId,
			instructions: "Remain idle; this session exists only for deterministic sidebar reveal coverage.",
			title,
		}),
	});
	expect(response.status, `${MARK}: create delegate: ${await response.clone().text()}`).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

function navRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-nav-id="session:${sessionId}"]`).first();
}

function revealButton(page: Page): Locator {
	return page.getByTestId("sidebar-reveal-current-button");
}

function filterCheckbox(page: Page, id: "archived" | "busy" | "read" | "teams"): Locator {
	return page.getByTestId(`sidebar-filter-${id}`).locator('input[type="checkbox"]');
}

async function setFilters(page: Page, values: Partial<Record<"archived" | "busy" | "read" | "teams", boolean>>): Promise<void> {
	await page.getByTestId("sidebar-filters-button").click();
	await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible();
	for (const [id, checked] of Object.entries(values) as Array<["archived" | "busy" | "read" | "teams", boolean]>) {
		const checkbox = filterCheckbox(page, id);
		await expect(checkbox, `${MARK}: ${id} filter exists in the active view`).toHaveCount(1);
		if (checked) await checkbox.check();
		else await checkbox.uncheck();
	}
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("sidebar-filters-popover")).toHaveCount(0);
}

async function expectFilters(page: Page, values: Partial<Record<"archived" | "busy" | "read" | "teams", boolean>>): Promise<void> {
	await page.getByTestId("sidebar-filters-button").click();
	await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible();
	for (const [id, checked] of Object.entries(values) as Array<["archived" | "busy" | "read" | "teams", boolean]>) {
		if (checked) await expect(filterCheckbox(page, id), `${MARK}: ${id} resets checked`).toBeChecked();
		else await expect(filterCheckbox(page, id), `${MARK}: ${id} resets unchecked`).not.toBeChecked();
	}
	await page.keyboard.press("Escape");
}

async function storedExpansion(page: Page, key: string): Promise<string | undefined> {
	return page.evaluate(({ storageKey, key }) => {
		try { return JSON.parse(localStorage.getItem(storageKey) || "{}").expansion?.[key]; }
		catch { return undefined; }
	}, { storageKey: TREE_STATE_KEY, key });
}

async function setStoredExpansions(page: Page, expansion: Record<string, "expanded" | "collapsed">): Promise<void> {
	await page.addInitScript(({ storageKey, expansion }) => {
		localStorage.removeItem("bobbit-sidebar-collapsed");
		localStorage.setItem("bobbit-sidebar-session-view", "project");
		localStorage.setItem("bobbit-show-archived", "false");
		localStorage.setItem("bobbit-show-busy", "true");
		localStorage.setItem("bobbit-show-read", "true");
		localStorage.setItem(storageKey, JSON.stringify({ version: 1, expansion }));
	}, { storageKey: TREE_STATE_KEY, expansion });
}

async function setKeyboardCursorAway(page: Page, targetNavId: string): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
		key: "ArrowDown",
		code: "ArrowDown",
		ctrlKey: true,
		metaKey: true,
		bubbles: true,
		cancelable: true,
	})));
	await expect.poll(() => page.evaluate(() => (window as any).__bobbitState?.keyboardNavActiveId ?? null), {
		timeout: 5_000,
		message: `${MARK}: keyboard cursor should move onto a visible non-target row`,
	}).not.toBeNull();
	expect(await page.evaluate(() => (window as any).__bobbitState?.keyboardNavActiveId), `${MARK}: cursor moved away from current session`).not.toBe(targetNavId);
}

async function installRevealProbes(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((targetNavId) => {
		const targetHasEmphasis = (node: Node): boolean => {
			if (!(node instanceof Element)) return false;
			return (node.matches(`[data-nav-id="${targetNavId}"].sidebar-reveal-emphasis`)
				|| node.querySelector(`[data-nav-id="${targetNavId}"].sidebar-reveal-emphasis`) !== null);
		};
		(window as any).__sidebarRevealEmphasisCount = 0;
		(window as any).__sidebarRevealScrollCalls = [];
		new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "attributes" && targetHasEmphasis(record.target)) {
					(window as any).__sidebarRevealEmphasisCount++;
				}
				for (const node of record.addedNodes) {
					if (targetHasEmphasis(node)) (window as any).__sidebarRevealEmphasisCount++;
				}
			}
		}).observe(document.documentElement, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });

		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function patchedScrollIntoView(options?: boolean | ScrollIntoViewOptions) {
			if (this instanceof HTMLElement && this.dataset.navId === targetNavId) {
				const container = document.querySelector<HTMLElement>(".sidebar-edge [data-project-reorder-list]");
				const rowRect = this.getBoundingClientRect();
				const containerRect = container?.getBoundingClientRect();
				(window as any).__sidebarRevealScrollCalls.push({
					options: options ?? null,
					wasWithin: !!containerRect && rowRect.top >= containerRect.top - 1 && rowRect.bottom <= containerRect.bottom + 1,
					overflowing: !!container && container.scrollHeight - container.clientHeight > 4,
				});
			}
			return original.call(this, options as any);
		};
	}, `session:${sessionId}`);
}

async function sidebarScrollTop(page: Page): Promise<number> {
	return page.locator(".sidebar-edge [data-project-reorder-list]").evaluate(element => (element as HTMLElement).scrollTop);
}

async function expectRowWithinSidebar(page: Page, sessionId: string): Promise<void> {
	await expect.poll(() => page.evaluate((navId) => {
		const container = document.querySelector<HTMLElement>(".sidebar-edge [data-project-reorder-list]");
		const row = [...document.querySelectorAll<HTMLElement>(".sidebar-edge [data-nav-id]")]
			.find(element => element.dataset.navId === navId);
		if (!container || !row) return false;
		const containerRect = container.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		return rowRect.top >= containerRect.top - 1 && rowRect.bottom <= containerRect.bottom + 1;
	}, `session:${sessionId}`), { timeout: 10_000, message: `${MARK}: revealed row should be within sidebar viewport` }).toBe(true);
}

async function waitForEmphasisToFinish(page: Page, sessionId: string): Promise<void> {
	await expect(navRow(page, sessionId), `${MARK}: emphasis is one-shot`).not.toHaveClass(/sidebar-reveal-emphasis/, { timeout: 4_000 });
}

test.describe("Journey: Reveal current sidebar session", () => {
	test.beforeAll(async () => {
		await waitForHealth();
		const projectId = (await defaultProjectId())!;
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const preferences = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: true }),
		});
		expect(preferences.status, `${MARK}: enable nested goals`).toBe(200);

		const fillers = await Promise.all(Array.from({ length: FILLER_GOAL_COUNT }, (_, index) =>
			createGoal({ title: `Reveal current filler ${index} ${stamp}`, projectId, team: false, worktree: false })));
		const fillerGoalIds = fillers.map(goal => goal.id);
		createdGoalIds.push(...fillerGoalIds);

		const parent = await createGoal({
			title: `Reveal current parent ${stamp}`,
			projectId,
			team: false,
			worktree: false,
			subgoalsAllowed: true,
			maxNestingDepth: 3,
		});
		createdGoalIds.push(parent.id);
		const teamGoalId = await createChildGoal(projectId, parent.id, `Reveal current nested team ${stamp}`, true);
		createdGoalIds.push(teamGoalId);

		const teamLeadSessionId = await startTeam(teamGoalId);
		createdSessionIds.push(teamLeadSessionId);
		const delegateSessionId = await createDelegate(teamLeadSessionId, `Reveal current delegate ${stamp}`);
		createdSessionIds.push(delegateSessionId);

		const archivedCandidateSessionId = await createSession({ projectId });
		createdSessionIds.push(archivedCandidateSessionId);
		const titleResponse = await apiFetch(`/api/sessions/${archivedCandidateSessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: `Reveal current archived candidate ${stamp}` }),
		});
		expect(titleResponse.status).toBe(200);

		fixture = {
			projectId,
			parentGoalId: parent.id,
			teamGoalId,
			teamLeadSessionId,
			delegateSessionId,
			archivedCandidateSessionId,
			unrelatedGoalId: fillerGoalIds[0],
			fillerGoalIds,
		};
	});

	test.afterAll(async () => {
		if (fixture?.teamGoalId) await teardownTeam(fixture.teamGoalId, true).catch(() => {});
		for (const id of [...createdSessionIds].reverse()) await deleteSession(id).catch(() => {});
		createdSessionIds.length = 0;
		for (const id of [...createdGoalIds].reverse()) await deleteGoal(id, true).catch(() => {});
		createdGoalIds.length = 0;
	});

	test("desktop control force-reveals a collapsed off-screen delegate in Project and Status while preserving explicit state", async ({ page }) => {
		test.setTimeout(55_000);
		await page.setViewportSize({ width: 1280, height: 390 });
		const pathKeys = [
			treeKey("project", fixture.projectId),
			treeKey("goal", fixture.parentGoalId),
			treeKey("goal", fixture.teamGoalId),
			treeKey("team-lead", fixture.teamLeadSessionId),
			sessionChildrenKey(fixture.teamLeadSessionId, "delegate"),
		];
		const unrelatedKey = treeKey("goal", fixture.unrelatedGoalId);
		await setStoredExpansions(page, Object.fromEntries([...pathKeys, unrelatedKey].map(key => [key, "collapsed"])));
		await openApp(page);

		await expect(revealButton(page), `${MARK}: desktop target control is rendered beside Filters`).toBeVisible();
		await expect(revealButton(page), `${MARK}: no-session route disables target control`).toBeDisabled();
		await expect(revealButton(page)).toHaveAttribute("title", /open.*session|no.*session/i);

		await navigateToHash(page, `#/session/${fixture.delegateSessionId}`);
		await expect(revealButton(page)).toBeEnabled({ timeout: 15_000 });
		await expect(revealButton(page)).toHaveAttribute("title", "Reveal current session in sidebar");
		await expect(navRow(page, fixture.delegateSessionId), `${MARK}: route reveal respects the explicit collapsed path`).toHaveCount(0);

		await setFilters(page, { busy: false, read: false });
		const search = page.locator("input[data-search]");
		await search.fill("query-that-cannot-match-current-delegate");
		await setKeyboardCursorAway(page, `session:${fixture.delegateSessionId}`);
		await installRevealProbes(page, fixture.delegateSessionId);

		await revealButton(page).click();
		await expect(search, `${MARK}: reveal clears shared sidebar search`).toHaveValue("");
		await expectFilters(page, { archived: false, busy: true, read: true });
		const targetRow = navRow(page, fixture.delegateSessionId);
		await expect(targetRow, `${MARK}: nested team delegate row is rendered`).toBeVisible({ timeout: 15_000 });
		await expect(targetRow, `${MARK}: current route highlight wins over keyboard cursor`).toHaveAttribute("data-nav-active", "true");
		const restoredKeyboardCursor = await page.evaluate(() => (window as any).__bobbitState?.keyboardNavActiveId ?? null);
		expect([null, `session:${fixture.delegateSessionId}`], `${MARK}: stale keyboard cursor is cleared or restored to target`).toContain(restoredKeyboardCursor);
		await expectRowWithinSidebar(page, fixture.delegateSessionId);

		for (const key of pathKeys) {
			expect(await storedExpansion(page, key), `${MARK}: explicit reveal persists ancestor ${key}`).toBe("expanded");
		}
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: unrelated collapse remains untouched`).toBe("collapsed");
		await expect.poll(() => page.evaluate(() => (window as any).__sidebarRevealEmphasisCount), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
		const firstScroll = await page.evaluate(() => (window as any).__sidebarRevealScrollCalls.at(-1));
		expect(firstScroll, `${MARK}: target begins outside an overflowing sidebar and uses nearest smooth scrolling`).toMatchObject({
			options: { behavior: "smooth", block: "nearest" },
			wasWithin: false,
			overflowing: true,
		});

		await waitForEmphasisToFinish(page, fixture.delegateSessionId);
		const scrollBeforeRepeat = await sidebarScrollTop(page);
		await revealButton(page).click();
		await expect.poll(() => page.evaluate(() => (window as any).__sidebarRevealEmphasisCount), { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		expect(await sidebarScrollTop(page), `${MARK}: nearest-edge repeat does not jump an already-visible row`).toBe(scrollBeforeRepeat);

		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(navRow(page, fixture.delegateSessionId), `${MARK}: explicitly expanded path survives reload`).toBeVisible({ timeout: 15_000 });
		for (const key of pathKeys) expect(await storedExpansion(page, key)).toBe("expanded");
		expect(await storedExpansion(page, unrelatedKey)).toBe("collapsed");

		await page.getByTestId("sidebar-view-status").click();
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
		// Team members are hidden by the Status defaults. Turn them on only long
		// enough to collapse the target's real section; reveal must reset this.
		await setFilters(page, { teams: true });
		const statusRow = navRow(page, fixture.delegateSessionId);
		await expect(statusRow).toBeVisible({ timeout: 10_000 });
		const statusSection = await statusRow.evaluate(element => element.closest<HTMLElement>("[data-status-section]")?.dataset.statusSection);
		expect(statusSection, `${MARK}: target belongs to a real Status section`).toMatch(/^(pinned|unread|read)$/);
		const statusHeading = page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`);
		await statusHeading.click();
		await expect(statusHeading).toHaveAttribute("aria-expanded", "false");
		await expect(navRow(page, fixture.delegateSessionId)).toHaveCount(0);
		await setFilters(page, { archived: true, busy: false, read: false, teams: true });
		await search.fill("status-query-that-cannot-match-current-delegate");
		await setKeyboardCursorAway(page, `session:${fixture.delegateSessionId}`);

		await revealButton(page).click();
		await expect(search).toHaveValue("");
		await expectFilters(page, { archived: false, busy: true, read: true, teams: false });
		await expect(page.locator(`[data-status-section="${statusSection}"] .sidebar-status-heading`), `${MARK}: reveal explicitly expands actual Status section`).toHaveAttribute("aria-expanded", "true");
		await expect(navRow(page, fixture.delegateSessionId)).toHaveAttribute("data-nav-active", "true");
		const collapsedSections = await page.evaluate(() => JSON.parse(localStorage.getItem("bobbit-status-collapsed-sections") || "[]"));
		expect(collapsedSections, `${MARK}: target Status expansion is persisted`).not.toContain(statusSection);
		expect(await storedExpansion(page, unrelatedKey), `${MARK}: Status reveal does not mutate unrelated Project expansion`).toBe("collapsed");
	});

	test("terminated session cold-loads into its archived group, reduces motion, and never exposes the control on mobile", async ({ page }) => {
		test.setTimeout(45_000);
		await page.setViewportSize({ width: 1280, height: 430 });
		await openApp(page);
		await navigateToHash(page, `#/session/${fixture.archivedCandidateSessionId}`);
		await expect(revealButton(page)).toBeEnabled({ timeout: 15_000 });
		await expect(navRow(page, fixture.archivedCandidateSessionId)).toHaveAttribute("data-nav-active", "true", { timeout: 15_000 });

		await deleteSession(fixture.archivedCandidateSessionId);
		let allowArchivedTarget = false;
		let archivedListLoads = 0;
		await page.route("**/api/sessions?**", async route => {
			const url = new URL(route.request().url());
			if (url.searchParams.get("include") !== "archived") {
				await route.continue();
				return;
			}
			archivedListLoads++;
			const response = await route.fetch();
			if (allowArchivedTarget) {
				await route.fulfill({ response });
				return;
			}
			const body = await response.json() as { sessions?: Array<{ id: string }>; archivedDelegates?: Array<{ id: string }> };
			body.sessions = (body.sessions || []).filter(session => session.id !== fixture.archivedCandidateSessionId);
			body.archivedDelegates = (body.archivedDelegates || []).filter(session => session.id !== fixture.archivedCandidateSessionId);
			await route.fulfill({ response, json: body });
		});

		await page.evaluate(({ storageKey, projectKey, archivedKey }) => {
			localStorage.setItem("bobbit-sidebar-session-view", "project");
			localStorage.setItem("bobbit-show-archived", "false");
			localStorage.setItem(storageKey, JSON.stringify({
				version: 1,
				expansion: { [projectKey]: "collapsed", [archivedKey]: "collapsed" },
			}));
		}, {
			storageKey: TREE_STATE_KEY,
			projectKey: treeKey("project", fixture.projectId),
			archivedKey: treeKey("project-archived", fixture.projectId),
		});
		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(revealButton(page), `${MARK}: terminated route remains revealable`).toBeEnabled({ timeout: 15_000 });
		await expect(navRow(page, fixture.archivedCandidateSessionId), `${MARK}: intercepted cold cache excludes target before reveal`).toHaveCount(0);
		await setFilters(page, { busy: false, read: false });
		await page.locator("input[data-search]").fill("cold-archive-query-with-no-match");
		await installRevealProbes(page, fixture.archivedCandidateSessionId);
		const loadsBeforeReveal = archivedListLoads;
		allowArchivedTarget = true;

		await revealButton(page).click();
		await expect.poll(() => archivedListLoads, { timeout: 10_000, message: `${MARK}: reveal requests archived data when current target is missing` }).toBeGreaterThan(loadsBeforeReveal);
		const archivedRow = navRow(page, fixture.archivedCandidateSessionId);
		await expect(archivedRow, `${MARK}: terminated row is revealed from cold archive data`).toBeVisible({ timeout: 15_000 });
		await expect(archivedRow).toHaveAttribute("data-nav-active", "true");
		await expectRowWithinSidebar(page, fixture.archivedCandidateSessionId);
		expect(await storedExpansion(page, treeKey("project", fixture.projectId))).toBe("expanded");
		expect(await storedExpansion(page, treeKey("project-archived", fixture.projectId)), `${MARK}: archived group is force-expanded and persisted`).toBe("expanded");

		await expect.poll(() => page.evaluate(() => (window as any).__sidebarRevealEmphasisCount), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
		await waitForEmphasisToFinish(page, fixture.archivedCandidateSessionId);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const emphasisBeforeReduced = await page.evaluate(() => (window as any).__sidebarRevealEmphasisCount);
		await page.evaluate(() => { (window as any).__sidebarRevealScrollCalls = []; });
		await revealButton(page).click();
		await expect.poll(() => page.evaluate(() => (window as any).__sidebarRevealEmphasisCount), { timeout: 5_000 }).toBeGreaterThan(emphasisBeforeReduced);
		const reducedScroll = await page.evaluate(() => (window as any).__sidebarRevealScrollCalls.at(-1));
		expect(reducedScroll?.options?.behavior, `${MARK}: reduced motion never requests smooth movement`).not.toBe("smooth");
		const reducedAnimation = await archivedRow.evaluate(element => {
			const style = getComputedStyle(element);
			return { name: style.animationName, duration: style.animationDuration };
		});
		expect(reducedAnimation.name === "none" || reducedAnimation.duration.split(",").every(value => Number.parseFloat(value) === 0), `${MARK}: reduced-motion emphasis is immediate`).toBe(true);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		await expect(revealButton(page), `${MARK}: target control is absent, not merely disabled, in mobile layout`).toHaveCount(0);
	});
});
