import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-keyboard-nav-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-keyboard-nav-fixture-bundle.js");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const SIDEBAR_NAV_SRC = path.resolve("src/app/sidebar-nav.ts");
const SIDEBAR_FILTERS_SRC = path.resolve("src/ui/components/sidebar-filters.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const SIDEBAR_TREE_BUILDER_SRC = path.resolve("src/app/sidebar-tree-builder.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SEARCH_BOX_SRC = path.resolve("src/ui/components/SearchBox.ts");
const SEARCH_STATUS_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");

const MARK = "SIDEBAR_NAV_FIXTURE";

type FixtureIds = Record<
	"project" | "liveGoal" | "goalSession" | "ungroupedHeader" | "liveSession" | "staffHeader" | "archivedHeader" | "archivedGoal",
	string
>;

type ActiveNavSnapshot = {
	id: string | null;
	activeIds: string[];
	fallbackIds: string[];
	keyboardNavActiveId: string | null;
	selectedSessionId: string | null;
	goalDashboardId: string | null;
	hash: string;
};

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SIDEBAR_SRC,
			SIDEBAR_NAV_SRC,
			SIDEBAR_FILTERS_SRC,
			RENDER_HELPERS_SRC,
			SIDEBAR_TREE_BUILDER_SRC,
			STATE_SRC,
			API_SRC,
			SEARCH_BOX_SRC,
			SEARCH_STATUS_DOT_SRC,
		],
	});
});

async function loadFixture(page: Page, options?: { showArchived?: boolean }): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarKeyboardNavReady === true, null, { timeout: 10_000 });
	await page.evaluate((opts) => (window as any).__resetSidebarKeyboardNavFixture(opts), options ?? {});
	await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
}

async function fixtureIds(page: Page): Promise<FixtureIds> {
	return page.evaluate(() => (window as any).__sidebarKeyboardNavFixtureIds);
}

async function nextFrame(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function activeNavSnapshot(page: Page): Promise<ActiveNavSnapshot> {
	return page.evaluate(() => {
		const idsFor = (selector: string) => Array.from(document.querySelectorAll(selector))
			.map((el) => el.getAttribute("data-nav-id"))
			.filter((id): id is string => !!id);
		const activeIds = idsFor("[data-nav-id][data-nav-active='true']");
		const fallbackIds = idsFor("[data-nav-id].sidebar-session-active, [data-nav-id].sidebar-active, [data-nav-id][data-active='true']");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState ?? {};
		return {
			id: activeIds[0] ?? fallbackIds[0] ?? null,
			activeIds,
			fallbackIds,
			keyboardNavActiveId: state.keyboardNavActiveId ?? null,
			selectedSessionId: state.selectedSessionId ?? null,
			goalDashboardId: state.goalDashboardId ?? null,
			hash: window.location.hash,
		};
	});
}

async function activeNavId(page: Page): Promise<string | null> {
	return (await activeNavSnapshot(page)).id;
}

async function navIdsInDomOrder(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar-edge");
		if (!sidebar) return [];
		const out: string[] = [];
		const seen = new Set<string>();
		for (const el of sidebar.querySelectorAll("[data-nav-id]")) {
			const id = el.getAttribute("data-nav-id");
			if (id && !seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
		}
		return out;
	});
}

function sameOrder(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, idx) => id === b[idx]);
}

async function waitForStableNavOrder(
	page: Page,
	requiredIds: string[] = [],
	absentIds: string[] = [],
): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	let previous: string[] | null = null;
	let stableFrames = 0;
	let latest: string[] = [];
	while (Date.now() < deadline) {
		await nextFrame(page);
		latest = await navIdsInDomOrder(page);
		const hasRequired = requiredIds.every((id) => latest.includes(id));
		const hasNoAbsent = absentIds.every((id) => !latest.includes(id));
		if (latest.length > 0 && hasRequired && hasNoAbsent && previous && sameOrder(latest, previous)) {
			stableFrames += 1;
			if (stableFrames >= 2) return latest;
		} else {
			stableFrames = 0;
		}
		previous = latest;
	}
	throw new Error(`${MARK}: sidebar nav order did not stabilize; latest=${JSON.stringify(latest)} required=${JSON.stringify(requiredIds)} absent=${JSON.stringify(absentIds)}`);
}

async function waitForActiveNavId(page: Page, expected: string | null): Promise<void> {
	const deadline = Date.now() + 5_000;
	let latest: ActiveNavSnapshot | null = null;
	while (Date.now() < deadline) {
		await nextFrame(page);
		latest = await activeNavSnapshot(page);
		if (latest.activeIds.length <= 1 && latest.id === expected) return;
	}
	throw new Error(`${MARK}: expected active nav ${JSON.stringify(expected)}; latest=${JSON.stringify(latest)}`);
}

async function resetNavStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.history.replaceState({}, "", "#/");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (state) {
			state.keyboardNavActiveId = null;
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.connectingSessionId = null;
			state.remoteAgent = null;
		}
		(window as any).__bobbitRenderSidebarFixture?.();
	});
	await waitForActiveNavId(page, null);
}

async function clearKeyboardOverrideAndRender(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (state) state.keyboardNavActiveId = null;
		(window as any).__bobbitRenderSidebarFixture?.();
	});
	await nextFrame(page);
}

async function setShowArchived(page: Page, showArchived: boolean): Promise<void> {
	await page.evaluate((show) => (window as any).__setSidebarKeyboardNavShowArchived(show), showArchived);
}

async function pressCtrlArrow(
	page: Page,
	key: "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight",
): Promise<void> {
	await page.evaluate((k) => {
		window.dispatchEvent(new KeyboardEvent("keydown", {
			key: k,
			code: k,
			ctrlKey: true,
			metaKey: true,
			bubbles: true,
			cancelable: true,
		}));
	}, key);
}

async function walk(
	page: Page,
	key: "ArrowDown" | "ArrowUp",
	steps: number,
	expectedOrder: string[],
): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		await pressCtrlArrow(page, key);
		const expected = key === "ArrowDown"
			? expectedOrder[i % expectedOrder.length]
			: expectedOrder[(expectedOrder.length - 1 - (i % expectedOrder.length) + expectedOrder.length) % expectedOrder.length];
		await waitForActiveNavId(page, expected);
		visited.push(await activeNavId(page));
	}
	return visited;
}

function visibleOrder(ids: FixtureIds): string[] {
	return [
		ids.project,
		ids.liveGoal,
		ids.goalSession,
		ids.ungroupedHeader,
		ids.liveSession,
		ids.staffHeader,
	];
}

function archivedOrder(ids: FixtureIds): string[] {
	return [
		...visibleOrder(ids),
		ids.archivedHeader,
		ids.archivedGoal,
	];
}

test.describe("Sidebar keyboard navigation lightweight fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row", async ({ page }) => {
		const ids = await fixtureIds(page);
		const expected = visibleOrder(ids);
		expect(await waitForStableNavOrder(page, expected, [ids.archivedHeader, ids.archivedGoal]), `${MARK}: visible nav order`).toEqual(expected);

		await resetNavStart(page);
		const visitedDown = await walk(page, "ArrowDown", expected.length + 1, expected);
		expect(visitedDown.slice(0, expected.length), `${MARK}: Ctrl+ArrowDown must visit rows in DOM order`).toEqual(expected);
		expect(visitedDown[expected.length], `${MARK}: Ctrl+ArrowDown must wrap to first row`).toBe(expected[0]);
		expect((await activeNavSnapshot(page)).activeIds, `${MARK}: one active row after down wrap`).toEqual([expected[0]]);

		await resetNavStart(page);
		const visitedUp = await walk(page, "ArrowUp", expected.length + 1, expected);
		const reverse = [...expected].reverse();
		expect(visitedUp.slice(0, expected.length), `${MARK}: Ctrl+ArrowUp must visit rows in reverse DOM order`).toEqual(reverse);
		expect(visitedUp[expected.length], `${MARK}: Ctrl+ArrowUp must wrap to last row`).toBe(reverse[0]);
		expect((await activeNavSnapshot(page)).activeIds, `${MARK}: one active row after up wrap`).toEqual([reverse[0]]);

		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, expected[0]);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowDown from last row wraps to first`).toBe(expected[0]);
	});

	test("Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection", async ({ page }) => {
		const ids = await fixtureIds(page);
		const expanded = visibleOrder(ids);
		await waitForStableNavOrder(page, expanded);

		await resetNavStart(page);
		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, ids.project);
		await pressCtrlArrow(page, "ArrowLeft");
		await waitForActiveNavId(page, ids.project);
		expect(await waitForStableNavOrder(page, [ids.project], expanded.slice(1)), `${MARK}: collapsed project order`).toEqual([ids.project]);
		await pressCtrlArrow(page, "ArrowRight");
		await waitForActiveNavId(page, ids.project);
		expect(await waitForStableNavOrder(page, expanded), `${MARK}: expanded project order restored`).toEqual(expanded);

		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, ids.liveGoal);
		await pressCtrlArrow(page, "ArrowLeft");
		await waitForActiveNavId(page, ids.liveGoal);
		const goalCollapsed = await waitForStableNavOrder(page, expanded.filter((id) => id !== ids.goalSession), [ids.goalSession]);
		expect(goalCollapsed.includes(ids.goalSession), `${MARK}: collapsed goal hides its session row`).toBe(false);
		await pressCtrlArrow(page, "ArrowRight");
		await waitForActiveNavId(page, ids.liveGoal);
		expect(await waitForStableNavOrder(page, expanded), `${MARK}: expanded goal order restored`).toEqual(expanded);
	});

	test("Show Archived deterministically adds archived rows to the keyboard cycle", async ({ page }) => {
		const ids = await fixtureIds(page);
		const off = visibleOrder(ids);
		const on = archivedOrder(ids);

		expect(await waitForStableNavOrder(page, off, [ids.archivedHeader, ids.archivedGoal]), `${MARK}: archived rows absent while hidden`).toEqual(off);
		await resetNavStart(page);
		const visitedOff = new Set((await walk(page, "ArrowDown", off.length, off)).filter((id): id is string => !!id));
		expect(visitedOff.has(ids.archivedHeader), `${MARK}: archived header is not reachable while hidden`).toBe(false);
		expect(visitedOff.has(ids.archivedGoal), `${MARK}: archived goal is not reachable while hidden`).toBe(false);

		await setShowArchived(page, true);
		expect(await waitForStableNavOrder(page, on), `${MARK}: archived rows join DOM order`).toEqual(on);
		await resetNavStart(page);
		const visitedOn = new Set((await walk(page, "ArrowDown", on.length, on)).filter((id): id is string => !!id));
		expect(visitedOn.has(ids.archivedHeader), `${MARK}: archived header reachable when shown`).toBe(true);
		expect(visitedOn.has(ids.archivedGoal), `${MARK}: archived goal reachable when shown`).toBe(true);

		await setShowArchived(page, false);
		expect(await waitForStableNavOrder(page, off, [ids.archivedHeader, ids.archivedGoal]), `${MARK}: archived rows leave DOM order`).toEqual(off);
	});

	test("route-selected project, goal, and session rows persist after rerender", async ({ page }) => {
		const ids = await fixtureIds(page);
		const order = visibleOrder(ids);
		await waitForStableNavOrder(page, order);

		await resetNavStart(page);
		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, ids.project);
		expect((await activeNavSnapshot(page)).hash, `${MARK}: project row routes to project settings`).toBe("#/settings/sidebar-nav-fixture-project/general");
		await clearKeyboardOverrideAndRender(page);
		await waitForActiveNavId(page, ids.project);

		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, ids.liveGoal);
		expect((await activeNavSnapshot(page)).hash, `${MARK}: goal row routes to goal dashboard`).toBe("#/goal/11111111-1111-4111-8111-111111111111");
		await clearKeyboardOverrideAndRender(page);
		await waitForActiveNavId(page, ids.liveGoal);

		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, ids.goalSession);
		const sessionSnapshot = await activeNavSnapshot(page);
		expect(sessionSnapshot.hash, `${MARK}: session row routes to session`).toBe("#/session/sidebar-nav-fixture-goal-session");
		expect(sessionSnapshot.selectedSessionId, `${MARK}: session row updates selected session synchronously`).toBe("sidebar-nav-fixture-goal-session");
		await clearKeyboardOverrideAndRender(page);
		await waitForActiveNavId(page, ids.goalSession);
	});
});
