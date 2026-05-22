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
		return Array.from(sidebar.querySelectorAll("[data-nav-id]"))
			.map((el) => el.getAttribute("data-nav-id"))
			.filter((v): v is string => !!v);
	});
}

async function waitForShortcutsReady(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"), {
		timeout: 15_000,
	}).toBe(true);
}

async function walkDown(page: Page, steps: number): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		await pressCtrlArrow(page, "ArrowDown");
		await nextFrame(page);
		visited.push(await activeNavId(page));
	}
	return visited;
}

test.describe("Sidebar keyboard navigation contract", () => {
	let projectA: { id: string; rootPath: string; name: string } | undefined;
	let projectB: { id: string; rootPath: string; name: string } | undefined;
	const createdSessionIds: string[] = [];
	const createdGoalIds: string[] = [];

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
		createdGoalIds.push(goalA.id);
		createdSessionIds.push(await createSession({ projectId: projectA.id, goalId: goalA.id }));
		createdSessionIds.push(await createSession({ projectId: projectA.id }));

		const goalB = await createGoal({
			title: `KBNavGoalB-${stamp}`,
			projectId: projectB.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		createdGoalIds.push(goalB.id);
		createdSessionIds.push(await createSession({ projectId: projectB.id, goalId: goalB.id }));
	});

	test.afterAll(async () => {
		for (const g of createdGoalIds) await deleteGoal(g).catch(() => {});
		for (const s of createdSessionIds) await deleteSession(s).catch(() => {});
		if (projectA) await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		if (projectB) await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("visible row IDs, wrap order, search filtering, project collapse/expand, and goal auto-open", async ({ page }) => {
		test.setTimeout(60_000);
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const domOrder = await navIdsInDomOrder(page);
		expect(domOrder.length, `${MARK}: sidebar must emit data-nav-id rows`).toBeGreaterThan(3);
		const kinds = new Set(domOrder.map((id) => id.split(":")[0]));
		for (const k of ["project", "goal", "session"]) {
			expect(kinds.has(k), `${MARK}: sidebar missing data-nav-id of kind "${k}"`).toBe(true);
		}

		await page.evaluate(() => { window.location.hash = "#/"; });
		const visitedDown = await walkDown(page, domOrder.length + 1);
		expect(visitedDown.slice(0, domOrder.length), `${MARK}: Ctrl+ArrowDown must visit rows in DOM order`).toEqual(domOrder);
		expect(visitedDown[domOrder.length], `${MARK}: Ctrl+ArrowDown must wrap to first row`).toBe(domOrder[0]);

		await page.evaluate(() => { window.location.hash = "#/"; });
		await pressCtrlArrow(page, "ArrowDown");
		await nextFrame(page);
		expect(await activeNavId(page), `${MARK}: first Ctrl+ArrowDown should land on first DOM row`).toBe(domOrder[0]);
		await pressCtrlArrow(page, "ArrowUp");
		await nextFrame(page);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowUp from first row must wrap to last`).toBe(domOrder[domOrder.length - 1]);

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("KBNavGoalA");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.searchQuery ?? ""),
			{ timeout: 5_000 },
		).toBe("KBNavGoalA");
		const filtered = await navIdsInDomOrder(page);
		expect(filtered.length, `${MARK}: search must still render at least one nav row`).toBeGreaterThan(0);
		await page.evaluate(() => { window.location.hash = "#/"; });
		const visitedFiltered = new Set((await walkDown(page, filtered.length + 2)).filter((id): id is string => !!id));
		for (const v of visitedFiltered) {
			expect(filtered.includes(v), `${MARK}: Ctrl+ArrowDown under search visited filtered-out row ${v}`).toBe(true);
		}
		await searchInput.fill("");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.searchQuery ?? ""),
			{ timeout: 5_000 },
		).toBe("");

		const beforeCollapse = await navIdsInDomOrder(page);
		const projectNavId = `project:${projectA!.id}`;
		const headerLocator = page.locator(`[data-nav-id="${projectNavId}"]`);
		expect(await headerLocator.count(), `${MARK}: Project A header must have data-nav-id`).toBeGreaterThan(0);
		const collapseBtn = headerLocator.locator(
			"button[title*='Collapse' i], button[aria-label*='Collapse' i], [data-action='collapse']",
		).first();
		if (await collapseBtn.count()) await collapseBtn.click();
		else await headerLocator.first().click();
		await nextFrame(page);

		const afterCollapse = await navIdsInDomOrder(page);
		const projAIdx = beforeCollapse.indexOf(projectNavId);
		let nextProjIdx = beforeCollapse.length;
		for (let i = projAIdx + 1; i < beforeCollapse.length; i++) {
			if (beforeCollapse[i].startsWith("project:")) { nextProjIdx = i; break; }
		}
		for (const child of beforeCollapse.slice(projAIdx + 1, nextProjIdx)) {
			expect(afterCollapse.includes(child), `${MARK}: collapsing ${projectNavId} must remove child ${child}`).toBe(false);
		}

		await page.evaluate(() => { window.location.hash = "#/"; });
		let landed = false;
		for (let i = 0; i < afterCollapse.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await nextFrame(page);
			if ((await activeNavId(page)) === projectNavId) { landed = true; break; }
		}
		expect(landed, `${MARK}: must land active row on project header`).toBe(true);

		await pressCtrlArrow(page, "ArrowRight");
		await nextFrame(page);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowRight must not move active row`).toBe(projectNavId);
		const afterExpand = await navIdsInDomOrder(page);
		expect(afterExpand.length, `${MARK}: Ctrl+ArrowRight on collapsed project must expand children`).toBeGreaterThan(afterCollapse.length);

		await pressCtrlArrow(page, "ArrowLeft");
		await nextFrame(page);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowLeft must not move active row`).toBe(projectNavId);
		expect((await navIdsInDomOrder(page)).length, `${MARK}: Ctrl+ArrowLeft on expanded project must collapse`).toBeLessThan(afterExpand.length);

		const domForGoal = await navIdsInDomOrder(page);
		const goalEntry = domForGoal.find((id) => id.startsWith("goal:"));
		expect(goalEntry, `${MARK}: sidebar must include a goal row in nav order`).toBeTruthy();
		const goalId = goalEntry!.split(":")[1];
		await page.evaluate(() => { window.location.hash = "#/"; });
		landed = false;
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

	test("toggling See Archived adds/removes archived rows from the Ctrl+ArrowDown cycle", async ({ page }) => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const projC = await registerProject(`navkb-charlie-${stamp}`);
		let liveGoalId: string | undefined;
		let liveSessId: string | undefined;
		let archGoalId: string | undefined;

		try {
			const liveGoal = await createGoal({
				title: `KBNavCharlieLive-${stamp}`,
				projectId: projC.id,
				worktree: false,
				cwd: nonGitCwd(),
			});
			liveGoalId = liveGoal.id;
			liveSessId = await createSession({ projectId: projC.id, goalId: liveGoalId });

			const archGoal = await createGoal({
				title: `KBNavCharlieArch-${stamp}`,
				projectId: projC.id,
				worktree: false,
				cwd: nonGitCwd(),
			});
			archGoalId = archGoal.id;
			await deleteGoal(archGoalId);

			await page.addInitScript(() => {
				localStorage.setItem("bobbit-show-archived", "false");
			});
			await openApp(page);
			await waitForShortcutsReady(page);
			await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

			const projCNavId = `project:${projC.id}`;
			const liveGoalNavId = `goal:${liveGoalId}`;
			const archHeaderNavId = `archived-header:${projC.id}`;
			const archGoalNavId = `goal:${archGoalId}`;

			await expect(page.locator(`[data-nav-id="${projCNavId}"]`), `${MARK}: Project C header must render`).toHaveCount(1, { timeout: 10_000 });
			await expect(page.locator(`[data-nav-id="${liveGoalNavId}"]`), `${MARK}: live goal must render`).toHaveCount(1, { timeout: 10_000 });
			expect(await page.evaluate(() => (window as any).bobbitState?.showArchived === true), `${MARK}: showArchived starts OFF`).toBe(false);

			const offIds = await navIdsInDomOrder(page);
			expect(offIds.includes(archHeaderNavId), `${MARK}: archived-header hidden when archived OFF`).toBe(false);
			expect(offIds.includes(archGoalNavId), `${MARK}: archived goal hidden when archived OFF`).toBe(false);
			await page.evaluate(() => { window.location.hash = "#/"; });
			const visitedOff = new Set((await walkDown(page, offIds.length + 2)).filter((id): id is string => !!id));
			expect(visitedOff.has(archHeaderNavId), `${MARK}: archived-header not visited when OFF`).toBe(false);
			expect(visitedOff.has(archGoalNavId), `${MARK}: archived goal not visited when OFF`).toBe(false);

			await expect(filtersButton(page)).toBeVisible({ timeout: 5_000 });
			await clickShowArchivedToggle(page);
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
				{ timeout: 5_000 },
			).toBe(true);
			await expect(page.locator(`[data-nav-id="${archHeaderNavId}"]`), `${MARK}: archived-header must render when ON`).toHaveCount(1, { timeout: 10_000 });
			await expect(page.locator(`[data-nav-id="${archGoalNavId}"]`), `${MARK}: archived goal must render when ON`).toHaveCount(1, { timeout: 10_000 });

			const onIds = await navIdsInDomOrder(page);
			expect(onIds.includes(archHeaderNavId), `${MARK}: archived-header in DOM when ON`).toBe(true);
			expect(onIds.includes(archGoalNavId), `${MARK}: archived goal in DOM when ON`).toBe(true);
			await page.evaluate(() => { window.location.hash = "#/"; });
			const visitedOn = new Set((await walkDown(page, onIds.length + 2)).filter((id): id is string => !!id));
			expect(visitedOn.has(archHeaderNavId), `${MARK}: archived-header visited when ON`).toBe(true);
			expect(visitedOn.has(archGoalNavId), `${MARK}: archived goal visited when ON`).toBe(true);

			await clickShowArchivedToggle(page);
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.showArchived === true),
				{ timeout: 5_000 },
			).toBe(false);
			await expect(page.locator(`[data-nav-id="${archHeaderNavId}"]`), `${MARK}: archived-header disappears when OFF`).toHaveCount(0, { timeout: 10_000 });
			const offIds2 = await navIdsInDomOrder(page);
			expect(offIds2.includes(archHeaderNavId), `${MARK}: archived-header removed from cycle`).toBe(false);
			expect(offIds2.includes(archGoalNavId), `${MARK}: archived goal removed from cycle`).toBe(false);
		} finally {
			await page.evaluate(() => {
				localStorage.setItem("bobbit-show-archived", "false");
			}).catch(() => {});
			if (liveSessId) await deleteSession(liveSessId).catch(() => {});
			if (liveGoalId) await deleteGoal(liveGoalId).catch(() => {});
			if (archGoalId) await deleteGoal(archGoalId).catch(() => {});
			await apiFetch(`/api/projects/${projC.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
