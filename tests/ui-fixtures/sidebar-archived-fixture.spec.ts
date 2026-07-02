import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-archived-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-archived-fixture-bundle.js");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SIDEBAR_FILTERS_SRC = path.resolve("src/ui/components/sidebar-filters.ts");
const SEARCH_BOX_SRC = path.resolve("src/ui/components/SearchBox.ts");
const SEARCH_STATUS_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");
const SIDEBAR_NESTING_SRC = path.resolve("src/app/sidebar-nesting.ts");
const SIDEBAR_SPAWNED_SRC = path.resolve("src/app/sidebar-spawned-children.ts");
const SIDEBAR_TREE_BUILDER_SRC = path.resolve("src/app/sidebar-tree-builder.ts");
const TEAM_ARCHIVED_BUCKET_SRC = path.resolve("src/app/team-archived-bucket.ts");

const MARK = "SIDEBAR_ARCHIVED_FIXTURE";
const VERIFIER_MARK = "SIDEBAR_ARCHIVED_VERIFIER";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SIDEBAR_SRC,
			RENDER_HELPERS_SRC,
			STATE_SRC,
			API_SRC,
			SIDEBAR_FILTERS_SRC,
			SEARCH_BOX_SRC,
			SEARCH_STATUS_DOT_SRC,
			SIDEBAR_NESTING_SRC,
			SIDEBAR_SPAWNED_SRC,
			SIDEBAR_TREE_BUILDER_SRC,
			TEAM_ARCHIVED_BUCKET_SRC,
		],
	});
});

async function loadFixture(
	page: Page,
	options: { mode?: "desktop" | "mobile"; showArchived?: boolean; collapsed?: boolean } = {},
): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarArchivedReady === true, null, { timeout: 10_000 });
	await page.evaluate((opts) => (window as any).__resetSidebarArchivedFixture(opts), options);
	await expect(page.locator("#app")).toBeVisible({ timeout: 10_000 });
}

async function fixtureIds(page: Page): Promise<Record<string, string>> {
	return page.evaluate(() => (window as any).__sidebarArchivedFixtureIds);
}

async function domIndexes(page: Page, selectors: string[]): Promise<number[]> {
	return page.evaluate((sels) => {
		const all = Array.from(document.querySelectorAll("*"));
		return sels.map((sel) => all.indexOf(document.querySelector(sel) as Element));
	}, selectors);
}

function expectIncreasing(indexes: number[], label: string): void {
	for (let i = 0; i < indexes.length; i++) {
		expect(indexes[i], `${MARK}: ${label} selector ${i} missing`).toBeGreaterThanOrEqual(0);
		if (i > 0) expect(indexes[i], `${MARK}: ${label} order ${i}`).toBeGreaterThan(indexes[i - 1]);
	}
}

async function projectStandaloneArchivedPlacement(page: Page, sessionId: string, projectId: string, nextProjectId: string) {
	return page.evaluate(({ sessionId, projectId, nextProjectId }) => {
		const all = Array.from(document.querySelectorAll("*"));
		const row = document.querySelector(`[data-session-id="${sessionId}"]`);
		const archivedHeader = document.querySelector(`[data-nav-id="archived-header:${projectId}"]`);
		const nextProject = document.querySelector(`.project-reorder-section[data-project-id="${nextProjectId}"], section[data-project-id="${nextProjectId}"]`);
		const rowIndex = row ? all.indexOf(row) : -1;
		const headerIndex = archivedHeader ? all.indexOf(archivedHeader) : -1;
		const nextProjectIndex = nextProject ? all.indexOf(nextProject) : all.length;
		const dividerText = all
			.slice(Math.max(0, headerIndex), Math.max(0, rowIndex))
			.map(el => el.textContent?.trim())
			.filter(text => text === "Goals" || text === "Sessions")
			.at(-1) ?? "";
		return {
			rowIndex,
			headerIndex,
			nextProjectIndex,
			dividerText,
			isStandalone: rowIndex >= 0 && headerIndex >= 0 && rowIndex > headerIndex && rowIndex < nextProjectIndex && dividerText === "Sessions",
		};
	}, { sessionId, projectId, nextProjectId });
}

async function expectProjectStandaloneArchived(page: Page, sessionId: string, projectId: string, nextProjectId: string, label: string): Promise<void> {
	const placement = await projectStandaloneArchivedPlacement(page, sessionId, projectId, nextProjectId);
	expect(
		placement.isStandalone,
		`${VERIFIER_MARK}: ${label} verifier ${sessionId} did not render as a project-level standalone archived session ${JSON.stringify(placement)}`,
	).toBe(true);
}

async function expectNotProjectStandaloneArchived(page: Page, sessionId: string, projectId: string, nextProjectId: string, label: string): Promise<void> {
	const placement = await projectStandaloneArchivedPlacement(page, sessionId, projectId, nextProjectId);
	expect(
		placement.isStandalone,
		`${VERIFIER_MARK}: ${label} verifier ${sessionId} rendered as a project-level standalone archived session ${JSON.stringify(placement)}`,
	).toBe(false);
}

async function expandLiveTeamLead(page: Page, teamLeadId: string, teamWorkerId: string): Promise<void> {
	const lead = page.locator(`[data-session-id="${teamLeadId}"]`).first();
	await expect(lead, `${VERIFIER_MARK}: live team lead renders`).toBeVisible({ timeout: 10_000 });
	const expand = lead.locator(`span[title="Expand"]`).first();
	if (await expand.count()) await expand.click();
	await expect(page.locator(`[data-session-id="${teamWorkerId}"]`), `${VERIFIER_MARK}: live team lead is expanded`).toBeVisible({ timeout: 5_000 });
}

async function setShowArchived(page: Page, checked: boolean): Promise<void> {
	const isOpen = await page.evaluate(() => (window as any).bobbitState.filtersPopoverOpen === true);
	if (!isOpen) await page.getByTestId("sidebar-filters-button").click();
	const checkbox = page.getByTestId("sidebar-filter-archived").locator("input");
	await expect(checkbox).toBeVisible({ timeout: 5_000 });

	const current = await page.evaluate(() => (window as any).bobbitState.showArchived === true);
	if (current !== checked) await checkbox.click();
	await expect.poll(() => page.evaluate(() => (window as any).bobbitState.showArchived), { timeout: 5_000 }).toBe(checked);
	await expect(checkbox).toBeChecked({ checked });
}

test.describe("Sidebar archived deterministic fixture", () => {
	test("Show Archived toggles archived rows on/off and writes the persisted preference", async ({ page }) => {
		test.setTimeout(30_000);
		await loadFixture(page, { showArchived: false });
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`), `${MARK}: archived header hidden initially`).toHaveCount(0);
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA1}"]`), `${MARK}: archived goal hidden initially`).toHaveCount(0);

		await setShowArchived(page, true);
		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`), `${MARK}: archived header appears`).toHaveCount(1, { timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA1}"]`), `${MARK}: archived goal appears`).toHaveCount(1, { timeout: 10_000 });
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("true");

		await setShowArchived(page, false);
		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`), `${MARK}: archived header removed`).toHaveCount(0, { timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA1}"]`), `${MARK}: archived goal removed`).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("false");
	});

	test("desktop per-project archived sections preserve ordering, collapse state, and nested archived goals", async ({ page }) => {
		await loadFixture(page, { showArchived: true });
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectB}"]`)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedChildGoal}"]`), `${MARK}: archived child of live goal remains in live hierarchy`).toHaveCount(1);

		expectIncreasing(await domIndexes(page, [
			`[data-testid="project-header"][data-project-id="${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.liveGoalA}"]`,
			`[data-nav-id="goal:${ids.archivedChildGoal}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA1}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA2}"]`,
			`[data-session-id="${ids.archivedStandaloneA}"]`,
			`[data-testid="project-header"][data-project-id="${ids.projectB}"]`,
			`[data-nav-id="archived-header:${ids.projectB}"]`,
			`[data-nav-id="goal:${ids.archivedGoalB}"]`,
		]), "desktop archived rows");

		await page.locator(`[data-nav-id="archived-header:${ids.projectB}"]`).click();
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalB}"]`), `${MARK}: collapsed project B hides archived goal`).toHaveCount(0, { timeout: 5_000 });
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA1}"]`), `${MARK}: project A archived section stays expanded`).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("bobbit-archived-collapsed-projects") || "[]"))).toContain(ids.projectB);
	});

	test("legacy verifier sessions stay out of project-level standalone archive rows", async ({ page }) => {
		await loadFixture(page, { showArchived: true });
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-session-id="${ids.archivedStandaloneA}"]`), `${VERIFIER_MARK}: normal standalone archived session still renders`).toBeVisible({ timeout: 10_000 });
		await expectNotProjectStandaloneArchived(page, ids.legacyLlmReview, ids.projectA, ids.projectB, "desktop llm-review");
		await expectNotProjectStandaloneArchived(page, ids.legacyAgentQa, ids.projectA, ids.projectB, "desktop agent-qa");
	});

	test("missing-goal verifier transcript uses standalone fallback while empty placeholders stay hidden", async ({ page }) => {
		await loadFixture(page, { showArchived: true });
		const ids = await fixtureIds(page);

		await expectProjectStandaloneArchived(page, ids.missingGoalReviewTranscript, ids.projectA, ids.projectB, "desktop missing-goal transcript");
		await expect(page.locator(`[data-session-id="${ids.missingGoalReviewPlaceholder}"]`), `${VERIFIER_MARK}: empty missing-goal placeholder stays hidden`).toHaveCount(0);
	});

	test("legacy live team-goal verifier nests near the expanded live team lead", async ({ page }) => {
		await loadFixture(page, { showArchived: true });
		const ids = await fixtureIds(page);

		await expandLiveTeamLead(page, ids.teamLead, ids.teamWorker);
		await expect(page.locator(`[data-session-id="${ids.legacyLlmReview}"]`), `${VERIFIER_MARK}: legacy llm-review verifier renders under the live team lead`).toBeVisible({ timeout: 10_000 });
		expectIncreasing(await domIndexes(page, [
			`[data-session-id="${ids.teamLead}"]`,
			`[data-session-id="${ids.legacyLlmReview}"]`,
			`[data-session-id="${ids.legacyAgentQa}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
		]), `${VERIFIER_MARK}: live team-goal verifier rows are nested before the project archived bucket`);
	});

	test("archived team leads, members, and delegates nest under their live owners", async ({ page }) => {
		test.setTimeout(30_000);
		await loadFixture(page, { showArchived: true });
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-session-id="${ids.archivedTeamLead}"]`), `${MARK}: archived team lead renders under live goal`).toBeVisible({ timeout: 10_000 });
		await page.locator(`[data-session-id="${ids.archivedTeamLead}"] span[title="Expand"]`).click();
		await expect(page.locator(`[data-session-id="${ids.archivedTeamWorker}"]`), `${MARK}: archived worker expands under archived team lead`).toBeVisible({ timeout: 5_000 });

		const parent = page.locator(`[data-session-id="${ids.liveSessionParent}"]`).first();
		await expect(parent, `${MARK}: live parent session renders`).toBeVisible({ timeout: 10_000 });
		await parent.locator("span").first().click();
		await expect(page.locator(`[data-session-id="${ids.archivedDelegate}"]`), `${MARK}: archived delegate expands under live parent`).toBeVisible({ timeout: 5_000 });
		await page.locator(`[data-session-id="${ids.archivedDelegate}"] span[title="Expand"]`).click();
		await expect(page.locator(`[data-session-id="${ids.archivedNestedDelegate}"]`), `${MARK}: nested archived delegate expands recursively`).toBeVisible({ timeout: 5_000 });

		await setShowArchived(page, false);
		await expect(page.locator(`[data-session-id="${ids.archivedDelegate}"]`), `${MARK}: archived delegate hidden when Show Archived is off`).toHaveCount(0, { timeout: 5_000 });
		await setShowArchived(page, true);
		await expect(page.locator(`[data-session-id="${ids.archivedDelegate}"]`), `${MARK}: archived delegate survives Show Archived cycle`).toBeVisible({ timeout: 10_000 });
	});

	test("collapsed sidebar exposes archived goal rows only when Show Archived is on", async ({ page }) => {
		await loadFixture(page, { showArchived: true, collapsed: true });
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("button[title='Alpha Archived Goal One']"), `${MARK}: collapsed archived goal button visible`).toHaveCount(1);

		await loadFixture(page, { showArchived: false, collapsed: true });
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("button[title='Alpha Archived Goal One']"), `${MARK}: collapsed archived goal button hidden`).toHaveCount(0);
	});

	test("mobile archived sections share bucketing, collapse persistence, and search highlighting", async ({ page }) => {
		await loadFixture(page, { mode: "mobile", showArchived: true });
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`), `${MARK}: mobile project A archived header`).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectB}"]`), `${MARK}: mobile project B archived header`).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`[data-session-id="${ids.archivedStandaloneA}"]`), `${VERIFIER_MARK}: mobile normal standalone archived session still renders`).toBeVisible({ timeout: 10_000 });
		await expectNotProjectStandaloneArchived(page, ids.legacyLlmReview, ids.projectA, ids.projectB, "mobile llm-review");
		await expectNotProjectStandaloneArchived(page, ids.legacyAgentQa, ids.projectA, ids.projectB, "mobile agent-qa");
		await expectProjectStandaloneArchived(page, ids.missingGoalReviewTranscript, ids.projectA, ids.projectB, "mobile missing-goal transcript");
		await expect(page.locator(`[data-session-id="${ids.missingGoalReviewPlaceholder}"]`), `${VERIFIER_MARK}: mobile empty missing-goal placeholder stays hidden`).toHaveCount(0);
		expectIncreasing(await domIndexes(page, [
			`section[data-project-id="${ids.projectA}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA1}"]`,
			`section[data-project-id="${ids.projectB}"]`,
			`[data-nav-id="archived-header:${ids.projectB}"]`,
			`[data-nav-id="goal:${ids.archivedGoalB}"]`,
		]), "mobile archived rows");

		await page.locator(`[data-nav-id="archived-header:${ids.projectB}"]`).click();
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalB}"]`)).toHaveCount(0, { timeout: 5_000 });
		await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("bobbit-archived-collapsed-projects") || "[]"))).toContain(ids.projectB);

		await loadFixture(page, { mode: "mobile", showArchived: true });
		const search = page.locator("input[data-search]");
		await search.fill("Goal One");
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA1}"]`), `${MARK}: mobile search keeps matching archived goal`).toHaveCount(1, { timeout: 5_000 });
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalA2}"]`), `${MARK}: mobile search filters non-matching archived goal`).toHaveCount(0);
		await expect(page.locator(`[data-nav-id="goal:${ids.archivedGoalB}"]`), `${MARK}: mobile search filters other project archived goal`).toHaveCount(0);
		await expect(page.locator("strong.font-semibold"), `${MARK}: mobile archived search highlights match`).toContainText("Goal One", { timeout: 5_000 });

		await loadFixture(page, { mode: "mobile", showArchived: false });
		await expect(page.locator(`[data-nav-id="archived-header:${ids.projectA}"]`), `${MARK}: mobile Show Archived off hides archived sections`).toHaveCount(0);
	});
});
