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
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SEARCH_BOX_SRC = path.resolve("src/ui/components/SearchBox.ts");
const SEARCH_STATUS_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");

const MARK = "SIDEBAR_NAV_FIXTURE";

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
			STATE_SRC,
			API_SRC,
			SEARCH_BOX_SRC,
			SEARCH_STATUS_DOT_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarKeyboardNavReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetSidebarKeyboardNavFixture());
	await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
}

async function fixtureIds(page: Page): Promise<Record<"project" | "liveGoal" | "archivedHeader" | "archivedGoal", string>> {
	return page.evaluate(() => (window as any).__sidebarKeyboardNavFixtureIds);
}

async function nextFrame(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function activeNavId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const sel = [
			"[data-nav-id].sidebar-session-active",
			"[data-nav-id].sidebar-active",
			"[data-nav-id][data-nav-active='true']",
			"[data-nav-id][data-active='true']",
		].join(", ");
		const el = document.querySelector(sel);
		return el ? el.getAttribute("data-nav-id") : null;
	});
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
	await expect.poll(() => activeNavId(page), { timeout: 5_000 }).toBe(expected);
}

async function resetNavStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.history.replaceState({}, "", "#/");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (state) {
			state.keyboardNavActiveId = null;
			state.selectedSessionId = null;
		}
		(window as any).__bobbitRenderSidebarFixture?.();
	});
	await nextFrame(page);
	await waitForActiveNavId(page, null);
}

async function pressCtrlArrowDown(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent("keydown", {
			key: "ArrowDown",
			code: "ArrowDown",
			ctrlKey: true,
			metaKey: true,
			bubbles: true,
			cancelable: true,
		}));
	});
}

async function walkDown(page: Page, steps: number, expectedOrder: string[]): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		await pressCtrlArrowDown(page);
		await waitForActiveNavId(page, expectedOrder[i % expectedOrder.length]);
		visited.push(await activeNavId(page));
	}
	return visited;
}

test.describe("Sidebar keyboard navigation lightweight fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("Show Archived adds and removes archived rows from the Ctrl+ArrowDown cycle", async ({ page }) => {
		const ids = await fixtureIds(page);

		const offIds = await waitForStableNavOrder(page, [ids.project, ids.liveGoal], [ids.archivedHeader, ids.archivedGoal]);
		expect(offIds.includes(ids.archivedHeader), `${MARK}: archived header hidden when Show Archived is off`).toBe(false);
		expect(offIds.includes(ids.archivedGoal), `${MARK}: archived goal hidden when Show Archived is off`).toBe(false);

		await resetNavStart(page);
		const visitedOff = new Set((await walkDown(page, offIds.length + 2, offIds)).filter((id): id is string => !!id));
		expect(visitedOff.has(ids.archivedHeader), `${MARK}: archived header not visited when Show Archived is off`).toBe(false);
		expect(visitedOff.has(ids.archivedGoal), `${MARK}: archived goal not visited when Show Archived is off`).toBe(false);

		await page.getByTestId("sidebar-filters-button").click();
		const archivedToggle = page.getByTestId("sidebar-filter-archived").locator("input");
		await expect(archivedToggle, `${MARK}: Show Archived starts unchecked`).not.toBeChecked();
		await archivedToggle.check();
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.showArchived), { timeout: 5_000 }).toBe(true);
		await expect(page.locator(`[data-nav-id="${ids.archivedHeader}"]`), `${MARK}: archived header renders when Show Archived is on`).toHaveCount(1, { timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="${ids.archivedGoal}"]`), `${MARK}: archived goal renders when Show Archived is on`).toHaveCount(1, { timeout: 10_000 });

		const onIds = await waitForStableNavOrder(page, [ids.archivedHeader, ids.archivedGoal]);
		expect(onIds.includes(ids.archivedHeader), `${MARK}: archived header in DOM when Show Archived is on`).toBe(true);
		expect(onIds.includes(ids.archivedGoal), `${MARK}: archived goal in DOM when Show Archived is on`).toBe(true);
		await resetNavStart(page);
		const visitedOn = new Set((await walkDown(page, onIds.length + 2, onIds)).filter((id): id is string => !!id));
		expect(visitedOn.has(ids.archivedHeader), `${MARK}: archived header visited when Show Archived is on`).toBe(true);
		expect(visitedOn.has(ids.archivedGoal), `${MARK}: archived goal visited when Show Archived is on`).toBe(true);

		await archivedToggle.uncheck();
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.showArchived), { timeout: 5_000 }).toBe(false);
		await expect(page.locator(`[data-nav-id="${ids.archivedHeader}"]`), `${MARK}: archived header disappears when Show Archived is off again`).toHaveCount(0, { timeout: 10_000 });
		const offIdsAgain = await waitForStableNavOrder(page, [ids.project, ids.liveGoal], [ids.archivedHeader, ids.archivedGoal]);
		expect(offIdsAgain.includes(ids.archivedHeader), `${MARK}: archived header removed from cycle`).toBe(false);
		expect(offIdsAgain.includes(ids.archivedGoal), `${MARK}: archived goal removed from cycle`).toBe(false);
		await resetNavStart(page);
		const visitedOffAgain = new Set((await walkDown(page, offIdsAgain.length + 2, offIdsAgain)).filter((id): id is string => !!id));
		expect(visitedOffAgain.has(ids.archivedHeader), `${MARK}: archived header not visited after Show Archived is off again`).toBe(false);
		expect(visitedOffAgain.has(ids.archivedGoal), `${MARK}: archived goal not visited after Show Archived is off again`).toBe(false);
	});
});
