import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-navigation-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-navigation-fixture-bundle.js");

const DEPS = [
	ENTRY,
	path.resolve("src/app/sidebar.ts"),
	path.resolve("src/app/sidebar-nav.ts"),
	path.resolve("src/app/render-helpers.ts"),
	path.resolve("src/app/sidebar-nesting.ts"),
	path.resolve("src/app/sidebar-spawned-children.ts"),
	path.resolve("src/app/sidebar-tree-builder.ts"),
	path.resolve("src/app/team-archived-bucket.ts"),
	path.resolve("src/app/state.ts"),
	path.resolve("src/app/api.ts"),
	path.resolve("src/app/session-manager.ts"),
	path.resolve("src/app/routing.ts"),
	path.resolve("src/ui/components/sidebar-filters.ts"),
	path.resolve("src/ui/components/SearchBox.ts"),
	path.resolve("src/app/components/search-status-dot.ts"),
];

const MARK = "SIDEBAR_NAVIGATION_FIXTURE";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: DEPS });
});

type FixtureIds = Record<
	| "projectAlpha"
	| "projectBeta"
	| "sessionA"
	| "sessionB"
	| "sessionC"
	| "staff"
	| "staffSession"
	| "orphanStaff"
	| "teamGoal"
	| "teamLead"
	| "teamCoder"
	| "spawnedOne"
	| "spawnedTwo"
	| "spawnedArchived"
	| "forestParent"
	| "forestChild"
	| "forestArchivedChild"
	| "soloGoal"
	| "soloGoalSession",
	string
>;

async function loadFixture(page: Page, opts?: { showArchived?: boolean; mobile?: boolean }): Promise<FixtureIds> {
	if (opts?.mobile) await page.setViewportSize({ width: 390, height: 740 });
	else await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarNavigationReady === true, null, { timeout: 10_000 });
	await page.evaluate((resetOpts) => (window as any).__resetSidebarNavigationFixture(resetOpts), opts ?? {});
	await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
	return page.evaluate(() => (window as any).__sidebarNavigationFixtureIds);
}

async function navIds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar-edge");
		if (!sidebar) return [];
		return Array.from(sidebar.querySelectorAll<HTMLElement>("[data-nav-id]"))
			.map((el) => el.getAttribute("data-nav-id") || "")
			.filter(Boolean);
	});
}

async function activeNavIds(page: Page): Promise<string[]> {
	return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-nav-active='true']"))
		.filter((el) => el.getClientRects().length > 0)
		.map((el) => el.getAttribute("data-nav-id") || "")
		.filter(Boolean));
}

test.describe("sidebar navigation lightweight fixture", () => {
	test("row selection and project/session navigation settle on one active row", async ({ page }) => {
		const ids = await loadFixture(page);

		await expect(page.locator(`[data-project-id="${ids.projectAlpha}"]`).first()).toBeVisible();
		await expect(page.locator(`[data-session-id="${ids.sessionA}"]`).first()).toBeVisible();
		await expect(page.locator(`[data-session-id="${ids.sessionB}"]`).first()).toBeVisible();

		for (const id of [ids.sessionA, ids.sessionB, ids.sessionC, ids.sessionB]) {
			await page.evaluate((sessionId) => (window as any).__sidebarNavigationSelectSession(sessionId), id);
		}

		await expect.poll(() => activeNavIds(page), { timeout: 5_000 }).toEqual([`session:${ids.sessionB}`]);
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/session/${ids.sessionB}`);
	});

	test("goal dashboard navigation and hierarchy rows render without full gateway", async ({ page }) => {
		const ids = await loadFixture(page);

		await page.evaluate((goalId) => (window as any).__sidebarNavigationSelectGoalDashboard(goalId), ids.teamGoal);
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/goal/${ids.teamGoal}`);
		await expect(page.locator(`[data-nav-id="goal:${ids.teamGoal}"]`).first(), `${MARK}: goal dashboard target remains in sidebar`).toBeVisible();

		await expect(page.locator(`[data-session-id="${ids.teamLead}"]`).first(), `${MARK}: team lead renders under expanded team goal`).toBeVisible();
		await expect(page.locator(`[data-session-id="${ids.teamCoder}"]`).first(), `${MARK}: team child renders under team lead`).toBeVisible();
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.forestParent}"]`), `${MARK}: nested forest parent renders`).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.forestChild}"]`), `${MARK}: nested forest child renders`).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.forestChild}"]`), `${MARK}: nested child is visible`).toBeVisible();
	});

	test("spawned child hierarchy dedupes by id and keeps stable same-title siblings", async ({ page }) => {
		const ids = await loadFixture(page);

		const childRows = page.locator(`[data-testid="sidebar-spawned-child-row"]`);
		await expect(childRows.filter({ hasText: "AUDIT: SAME TITLE" }), `${MARK}: same-title siblings both render`).toHaveCount(2);
		await expect(page.locator(`[data-testid="sidebar-spawned-child-row"][data-goal-id="${ids.spawnedOne}"]`), `${MARK}: duplicate state.goals id is collapsed`).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-spawned-child-row"][data-goal-id="${ids.spawnedTwo}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.spawnedOne}"]`), `${MARK}: spawned child is claimed by team-lead path, not forest path`).toHaveCount(0);

		const firstOrder = await page.locator(`[data-testid="sidebar-spawned-child-row"]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-goal-id")));
		await page.evaluate(() => (window as any).__sidebarNavigationRender());
		const secondOrder = await page.locator(`[data-testid="sidebar-spawned-child-row"]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-goal-id")));
		expect(secondOrder, `${MARK}: spawned child order is stable across renders`).toEqual(firstOrder);
	});

	test("Show Archived folds archived hierarchy into the same deterministic paths", async ({ page }) => {
		const ids = await loadFixture(page, { showArchived: true });

		await expect(page.locator(`[data-testid="sidebar-spawned-child-row"][data-goal-id="${ids.spawnedArchived}"]`), `${MARK}: archived spawned child appears under team lead when Show Archived is on`).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.forestArchivedChild}"]`), `${MARK}: archived nested child appears under live parent when Show Archived is on`).toHaveCount(1);
		await expect(page.locator(`[data-testid="sidebar-archived-divider"]`).first()).toBeVisible();

		await page.evaluate(() => (window as any).__sidebarNavigationSetShowArchived(false));
		await expect(page.locator(`[data-testid="sidebar-spawned-child-row"][data-goal-id="${ids.spawnedArchived}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${ids.forestArchivedChild}"]`)).toHaveCount(0);
	});

	test("staff section stays separate from sessions and surfaces orphaned staff", async ({ page }) => {
		const ids = await loadFixture(page);

		await expect(page.getByText("Fixture Staff", { exact: false }).first(), `${MARK}: project staff row renders`).toBeVisible();
		await expect(page.getByText("Orphan Fixture Staff", { exact: false }).first(), `${MARK}: orphan staff banner renders`).toBeVisible();
		await expect(page.locator(`[data-session-id="${ids.staffSession}"]`), `${MARK}: staff current session is not duplicated in Sessions rows`).toHaveCount(0);
		await expect(page.locator(`[data-nav-id="session:${ids.staffSession}"]`), `${MARK}: staff row keeps session nav id`).toHaveCount(1);

		const staffTitle = page.getByText("Fixture Staff", { exact: true }).first();
		const section = await staffTitle.evaluate((el) => {
			const headers = Array.from(document.querySelectorAll("span"));
			const staffHeaders = headers.filter((h) => (h.textContent || "").trim().toLowerCase() === "staff");
			const sessionHeaders = headers.filter((h) => (h.textContent || "").trim().toLowerCase() === "sessions");
			const wrappers = (hs: Element[]) => hs.map((h) => h.parentElement?.parentElement).filter(Boolean) as Element[];
			const inside = (ws: Element[]) => ws.some((w) => w.contains(el));
			return { underStaff: inside(wrappers(staffHeaders)), underSessions: inside(wrappers(sessionHeaders)) };
		});
		expect(section, `${MARK}: staff row belongs to Staff subsection only`).toEqual({ underStaff: true, underSessions: false });
	});

	test("story sidebar matrix: search, collapse persistence, mobile staff styling", async ({ page }) => {
		const ids = await loadFixture(page, { mobile: true });

		await page.evaluate(() => (window as any).__sidebarNavigationSetSearch("Bravo"));
		await expect(page.getByText("Bravo Chat", { exact: false }).first()).toBeVisible();
		await expect(page.getByText("Alpha Chat", { exact: false }).first()).toHaveCount(0);
		await page.evaluate(() => (window as any).__sidebarNavigationSetSearch(""));
		await expect(page.getByText("Alpha Chat", { exact: false }).first()).toBeVisible();

		await page.evaluate(() => (window as any).__sidebarNavigationCollapse());
		await expect(page.locator("[data-testid='sidebar-collapsed']")).toBeVisible();
		expect(await page.evaluate(() => localStorage.getItem("bobbit-sidebar-collapsed")), `${MARK}: collapse state persists to localStorage`).toBe("true");
		await page.evaluate(() => (window as any).__sidebarNavigationExpand());
		await expect(page.locator("[data-testid='sidebar-expanded']")).toBeVisible();

		await page.evaluate((sessionId) => (window as any).__sidebarNavigationSelectSession(sessionId), ids.staffSession);
		await expect.poll(() => activeNavIds(page), { timeout: 5_000 }).toEqual([`session:${ids.staffSession}`]);
		const order = await navIds(page);
		expect(order, `${MARK}: mobile fixture keeps staff/session nav rows in the sidebar order`).toContain(`staff-header:${ids.projectAlpha}`);
		expect(order).toContain(`session:${ids.staffSession}`);
	});
});
