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

		const requiredNavIds = [
			`project:${projectA!.id}`,
			`project:${projectB!.id}`,
			...createdGoalIds.map((id) => `goal:${id}`),
			...createdSessionIds.map((id) => `session:${id}`),
		];
		const domOrder = await waitForStableNavOrder(page, requiredNavIds);
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

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("KBNavGoalA");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.searchQuery ?? ""),
			{ timeout: 5_000 },
		).toBe("KBNavGoalA");
		const filtered = await waitForStableNavOrder(page, [`goal:${createdGoalIds[0]}`]);
		expect(filtered.length, `${MARK}: search must still render at least one nav row`).toBeGreaterThan(0);
		await resetNavStart(page);
		const visitedFiltered = new Set((await walkDown(page, filtered.length + 2, filtered)).filter((id): id is string => !!id));
		for (const v of visitedFiltered) {
			expect(filtered.includes(v), `${MARK}: Ctrl+ArrowDown under search visited filtered-out row ${v}`).toBe(true);
		}
		await searchInput.fill("");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.searchQuery ?? ""),
			{ timeout: 5_000 },
		).toBe("");

		const beforeCollapse = await waitForStableNavOrder(page, requiredNavIds);
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

		const domForGoal = await waitForStableNavOrder(page);
		const goalEntry = domForGoal.find((id) => id.startsWith("goal:"));
		expect(goalEntry, `${MARK}: sidebar must include a goal row in nav order`).toBeTruthy();
		const goalId = goalEntry!.split(":")[1];
		await resetNavStart(page);
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
});
