/**
 * Sidebar keyboard navigation contract.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	createGoal,
	deleteSession,
	deleteGoal,
	nonGitCwd,
	waitForHealth,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MARK = "SIDEBAR_NAV_CONTRACT";

async function registerProject(name: string): Promise<{ id: string; rootPath: string; name: string }> {
	const rootPath = join(
		tmpdir(),
		`bobbit-e2e-navkb-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(rootPath, { recursive: true });
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { id: data.id, rootPath, name };
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

async function nextFrame(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
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

async function waitForShortcutsReady(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"), {
		timeout: 15_000,
	}).toBe(true);
}

async function waitForActiveNavId(page: Page, expected: string | null): Promise<void> {
	await expect.poll(() => activeNavId(page), { timeout: 5_000 }).toBe(expected);
}

// Deterministic settle: gate on the concrete presence/absence of the specific
// nav-id rows the caller cares about using Playwright's auto-retrying locator
// matchers, then read the DOM order once. This replaces the rAF-spin stability
// scan (waitForStableNavOrder) for the heavy archived-toggle/reload tests —
// no per-frame polling, no 2-stable-frame requirement, no 10s spin budget.
async function waitForNavRows(
	page: Page,
	requiredIds: string[],
	absentIds: string[] = [],
): Promise<string[]> {
	for (const id of requiredIds) {
		await expect(page.locator(`[data-nav-id="${id}"]`), `${MARK}: nav row ${id} must render`).toHaveCount(1, { timeout: 10_000 });
	}
	for (const id of absentIds) {
		await expect(page.locator(`[data-nav-id="${id}"]`), `${MARK}: nav row ${id} must be absent`).toHaveCount(0, { timeout: 10_000 });
	}
	return navIdsInDomOrder(page);
}

async function resetNavStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.history.replaceState({}, "", "#/");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (state) {
			state.keyboardNavActiveId = null;
			state.selectedSessionId = null;
			state.goalDashboardId = null;
		}
		(window as any).__bobbitRenderApp?.();
	});
	await nextFrame(page);
	await waitForActiveNavId(page, null);
}

async function walkDown(page: Page, steps: number, expectedOrder?: string[]): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		await pressCtrlArrow(page, "ArrowDown");
		if (expectedOrder?.length) {
			await waitForActiveNavId(page, expectedOrder[i % expectedOrder.length]);
		} else {
			await nextFrame(page);
		}
		visited.push(await activeNavId(page));
	}
	return visited;
}

test.describe("Sidebar keyboard navigation contract", () => {
	let projectA: { id: string; rootPath: string; name: string } | undefined;
	let projectB: { id: string; rootPath: string; name: string } | undefined;
	const createdSessionIds: string[] = [];
	const liveGoalIds: string[] = [];
	const createdGoalIds: string[] = [];
	let archivedGoalId: string | undefined;

	test.beforeAll(async () => {
		await waitForHealth();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		projectA = await registerProject(`navkb-alpha-${stamp}`);
		projectB = await registerProject(`navkb-bravo-${stamp}`);

		const goalA = await createGoal({
			title: `KBNavGoalA-${stamp}`,
			projectId: projectA.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		liveGoalIds.push(goalA.id);
		createdGoalIds.push(goalA.id);
		createdSessionIds.push(await createSession({ projectId: projectA.id, goalId: goalA.id }));
		createdSessionIds.push(await createSession({ projectId: projectA.id }));

		const goalB = await createGoal({
			title: `KBNavGoalB-${stamp}`,
			projectId: projectB.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		liveGoalIds.push(goalB.id);
		createdGoalIds.push(goalB.id);
		createdSessionIds.push(await createSession({ projectId: projectB.id, goalId: goalB.id }));

		const archivedGoal = await createGoal({
			title: `KBNavArchived-${stamp}`,
			projectId: projectB.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		archivedGoalId = archivedGoal.id;
		createdGoalIds.push(archivedGoalId);
		await deleteGoal(archivedGoalId);
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/goals?archived=true&projectId=${encodeURIComponent(projectB!.id)}&limit=50`);
			if (!resp.ok) return false;
			const body = await resp.json();
			return Array.isArray(body.goals) && body.goals.some((g: { id?: string }) => g.id === archivedGoalId);
		}, { timeout: 5_000 }).toBe(true);
	});

	test.afterAll(async () => {
		for (const g of createdGoalIds) await deleteGoal(g).catch(() => {});
		for (const s of createdSessionIds) await deleteSession(s).catch(() => {});
		if (projectA) await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		if (projectB) await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	// Build the canonical set of nav ids the sidebar must always render for the
	// fixture projects/goals/sessions created in beforeAll.
	function buildRequiredNavIds(): string[] {
		return [
			`project:${projectA!.id}`,
			`project:${projectB!.id}`,
			...liveGoalIds.map((id) => `goal:${id}`),
			...createdSessionIds.map((id) => `session:${id}`),
		];
	}

	// Open the app with a deterministic Show-Archived seed and wait until the
	// keyboard-shortcut layer + sidebar are live. Each test below gets a fresh
	// browser context, so seeding localStorage here fully isolates its starting
	// filter state (no cross-test leakage). This was previously one 60s mega-test
	// that tipped over its budget under Chromium contention; splitting it gives
	// each scenario its own 30s budget while preserving every assertion.
	async function openSidebar(page: Page, showArchived: boolean): Promise<void> {
		await page.addInitScript((sa) => {
			localStorage.setItem("bobbit-show-archived", sa ? "true" : "false");
		}, showArchived);
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
	}

	test("visible row IDs cover every kind and Ctrl+Arrow wraps at both ends", async ({ page }) => {
		await openSidebar(page, false);
		const domOrder = await waitForStableNavOrder(page, buildRequiredNavIds());
		expect(domOrder.length, `${MARK}: sidebar must emit data-nav-id rows`).toBeGreaterThan(3);
		const kinds = new Set(domOrder.map((id) => id.split(":")[0]));
		for (const k of ["project", "goal", "session"]) {
			expect(kinds.has(k), `${MARK}: sidebar missing data-nav-id of kind "${k}"`).toBe(true);
		}

		await resetNavStart(page);
		const visitedDown = await walkDown(page, domOrder.length + 1, domOrder);
		expect(visitedDown.slice(0, domOrder.length), `${MARK}: Ctrl+ArrowDown must visit rows in DOM order`).toEqual(domOrder);
		expect(visitedDown[domOrder.length], `${MARK}: Ctrl+ArrowDown must wrap to first row`).toBe(domOrder[0]);

		await resetNavStart(page);
		await pressCtrlArrow(page, "ArrowDown");
		await waitForActiveNavId(page, domOrder[0]);
		expect(await activeNavId(page), `${MARK}: first Ctrl+ArrowDown should land on first DOM row`).toBe(domOrder[0]);
		await pressCtrlArrow(page, "ArrowUp");
		await waitForActiveNavId(page, domOrder[domOrder.length - 1]);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowUp from first row must wrap to last`).toBe(domOrder[domOrder.length - 1]);
	});

	test("search filtering restricts the keyboard cycle to matching rows", async ({ page }) => {
		await openSidebar(page, false);
		await waitForStableNavOrder(page, buildRequiredNavIds());

		// The search box debounces input by 200ms before publishing to
		// state.searchQuery (ui/components/SearchBox.ts); under contention a single
		// fill's debounced dispatch can be dropped, so re-issue until it applies.
		const searchInput = page.locator("input[data-search]");
		await expect.poll(async () => {
			await searchInput.fill("KBNavGoalA");
			return page.evaluate(() => (window as any).bobbitState?.searchQuery ?? "");
		}, { timeout: 10_000, intervals: [250, 400, 700, 1000] }).toBe("KBNavGoalA");
		const filtered = await waitForStableNavOrder(page, [`goal:${liveGoalIds[0]}`]);
		expect(filtered.length, `${MARK}: search must still render at least one nav row`).toBeGreaterThan(0);
		await resetNavStart(page);
		const visitedFiltered = new Set((await walkDown(page, filtered.length + 2, filtered)).filter((id): id is string => !!id));
		for (const v of visitedFiltered) {
			expect(filtered.includes(v), `${MARK}: Ctrl+ArrowDown under search visited filtered-out row ${v}`).toBe(true);
		}
		await expect.poll(async () => {
			await searchInput.fill("");
			return page.evaluate(() => (window as any).bobbitState?.searchQuery ?? "");
		}, { timeout: 10_000, intervals: [250, 400, 700, 1000] }).toBe("");
	});

	test("Ctrl+Arrow collapses and expands a project while keeping the active row", async ({ page }) => {
		await openSidebar(page, false);
		const beforeCollapse = await waitForStableNavOrder(page, buildRequiredNavIds());
		const projectNavId = `project:${projectA!.id}`;
		const headerLocator = page.locator(`[data-nav-id="${projectNavId}"]`);
		expect(await headerLocator.count(), `${MARK}: Project A header must have data-nav-id`).toBeGreaterThan(0);
		const collapseBtn = headerLocator.locator(
			"button[title*='Collapse' i], button[aria-label*='Collapse' i], [data-action='collapse']",
		).first();
		const projAIdx = beforeCollapse.indexOf(projectNavId);
		let nextProjIdx = beforeCollapse.length;
		for (let i = projAIdx + 1; i < beforeCollapse.length; i++) {
			if (beforeCollapse[i].startsWith("project:")) { nextProjIdx = i; break; }
		}
		const projectAChildren = beforeCollapse.slice(projAIdx + 1, nextProjIdx);
		if (await collapseBtn.count()) await collapseBtn.click();
		else await headerLocator.first().click();

		const afterCollapse = await waitForStableNavOrder(page, [projectNavId], projectAChildren);
		for (const child of projectAChildren) {
			expect(afterCollapse.includes(child), `${MARK}: collapsing ${projectNavId} must remove child ${child}`).toBe(false);
		}

		await resetNavStart(page);
		let landed = false;
		for (let i = 0; i < afterCollapse.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await nextFrame(page);
			if ((await activeNavId(page)) === projectNavId) { landed = true; break; }
		}
		expect(landed, `${MARK}: must land active row on project header`).toBe(true);

		await pressCtrlArrow(page, "ArrowRight");
		await waitForActiveNavId(page, projectNavId);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowRight must not move active row`).toBe(projectNavId);
		const afterExpand = await waitForStableNavOrder(page, projectAChildren);
		expect(afterExpand.length, `${MARK}: Ctrl+ArrowRight on collapsed project must expand children`).toBeGreaterThan(afterCollapse.length);

		await pressCtrlArrow(page, "ArrowLeft");
		await waitForActiveNavId(page, projectNavId);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowLeft must not move active row`).toBe(projectNavId);
		expect((await waitForStableNavOrder(page, [projectNavId], projectAChildren)).length, `${MARK}: Ctrl+ArrowLeft on expanded project must collapse`).toBeLessThan(afterExpand.length);
	});

	test("landing on a goal header routes to its goal dashboard", async ({ page }) => {
		await openSidebar(page, false);
		const domForGoal = await waitForStableNavOrder(page, buildRequiredNavIds());
		const goalEntry = domForGoal.find((id) => id.startsWith("goal:"));
		expect(goalEntry, `${MARK}: sidebar must include a goal row in nav order`).toBeTruthy();
		const goalId = goalEntry!.split(":")[1];
		await resetNavStart(page);
		let landed = false;
		for (let i = 0; i < domForGoal.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await nextFrame(page);
			if ((await activeNavId(page)) === goalEntry) { landed = true; break; }
		}
		expect(landed, `${MARK}: Ctrl+ArrowDown must land on goal header`).toBe(true);
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash, `${MARK}: landing on goal header must route to goal dashboard`).toContain(goalId);
		expect(hash).toMatch(/#\/goal\//);
	});

	test("archived rows join the keyboard cycle only when Show Archived is on", async ({ page }) => {
		await openSidebar(page, false);

		const projectBNavId = `project:${projectB!.id}`;
		const liveGoalBNavId = `goal:${liveGoalIds[1]}`;
		const archHeaderNavId = `archived-header:${projectB!.id}`;
		const archGoalNavId = `goal:${archivedGoalId}`;

		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
			{ timeout: 5_000 },
		).toBe(false);

		// OFF: archived rows are absent from the DOM nav set, and therefore from
		// the keyboard cycle — the "visible row IDs ... Ctrl+Arrow wraps" test
		// already proves cycle membership == DOM nav order, so DOM absence is a
		// sufficient (and cheaper) proof than re-walking the whole cycle here.
		const offIds = await waitForNavRows(page, [projectBNavId, liveGoalBNavId], [archHeaderNavId, archGoalNavId]);
		expect(offIds.includes(archHeaderNavId), `${MARK}: archived header hidden when Show Archived is off`).toBe(false);
		expect(offIds.includes(archGoalNavId), `${MARK}: archived goal hidden when Show Archived is off`).toBe(false);

		// Toggle Show Archived ON.
		await expect(filtersButton(page), `${MARK}: filters button must be reachable`).toBeVisible({ timeout: 5_000 });
		await clickShowArchivedToggle(page);
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
			{ timeout: 5_000 },
		).toBe(true);

		// ON: archived rows are present and reachable via the keyboard cycle.
		// One full walk (down the settled order) confirms they were genuinely
		// added to the cycle — the single keyboard assertion this test needs.
		const onIds = await waitForNavRows(page, [archHeaderNavId, archGoalNavId]);
		expect(onIds.includes(archHeaderNavId), `${MARK}: archived header in DOM when Show Archived is on`).toBe(true);
		expect(onIds.includes(archGoalNavId), `${MARK}: archived goal in DOM when Show Archived is on`).toBe(true);
		await resetNavStart(page);
		const visitedOn = new Set((await walkDown(page, onIds.length, onIds)).filter((id): id is string => !!id));
		expect(visitedOn.has(archHeaderNavId), `${MARK}: archived header visited when Show Archived is on`).toBe(true);
		expect(visitedOn.has(archGoalNavId), `${MARK}: archived goal visited when Show Archived is on`).toBe(true);
	});

	test("Show Archived persists across reload and can be turned back off", async ({ page }) => {
		await openSidebar(page, true);

		const projectBNavId = `project:${projectB!.id}`;
		const liveGoalBNavId = `goal:${liveGoalIds[1]}`;
		const archHeaderNavId = `archived-header:${projectB!.id}`;
		const archGoalNavId = `goal:${archivedGoalId}`;

		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
			{ timeout: 5_000 },
		).toBe(true);
		// Pre-reload: archived rows present in the DOM nav set (cycle membership ==
		// DOM order is proven by the wrap test, so DOM presence is sufficient here).
		await waitForNavRows(page, [archHeaderNavId, archGoalNavId]);

		// Reload: Show Archived must hydrate from localStorage.
		await page.reload();
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived")), { timeout: 5_000 }).toBe("true");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
			{ timeout: 5_000 },
		).toBe(true);

		// Deterministic hydrated signal: the specific archived rows rendered after
		// reload. One full keyboard walk confirms the persisted rows remain
		// reachable in the cycle — the persistence guarantee this test exists for.
		const reloadedIds = await waitForNavRows(page, [archHeaderNavId, archGoalNavId]);
		expect(reloadedIds.includes(archHeaderNavId), `${MARK}: archived header remains in DOM after reload`).toBe(true);
		expect(reloadedIds.includes(archGoalNavId), `${MARK}: archived goal remains in DOM after reload`).toBe(true);
		await resetNavStart(page);
		const visitedAfterReload = new Set((await walkDown(page, reloadedIds.length, reloadedIds)).filter((id): id is string => !!id));
		expect(visitedAfterReload.has(archHeaderNavId), `${MARK}: archived header remains in cycle after reload`).toBe(true);
		expect(visitedAfterReload.has(archGoalNavId), `${MARK}: archived goal remains in cycle after reload`).toBe(true);

		// Turn Show Archived back off — archived rows leave the DOM (and the cycle).
		await clickShowArchivedToggle(page);
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
			{ timeout: 5_000 },
		).toBe(false);
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived")), { timeout: 5_000 }).toBe("false");
		const offIdsAgain = await waitForNavRows(page, [projectBNavId, liveGoalBNavId], [archHeaderNavId, archGoalNavId]);
		expect(offIdsAgain.includes(archHeaderNavId), `${MARK}: archived header removed from cycle`).toBe(false);
		expect(offIdsAgain.includes(archGoalNavId), `${MARK}: archived goal removed from cycle`).toBe(false);
	});
});
