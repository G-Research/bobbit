import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/search-preview-maintenance-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "search-preview-maintenance-bundle.js");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SEARCH_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");

const REMOVABLE_SESSION_ID = "arch-removable-session";
const SKIPPED_SESSION_ID = "arch-skipped-session";
const CLEANED_SESSION_ID = "arch-cleaned-session";

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__maintenanceFixtureReady === true, null, { timeout: 10_000 });
}

async function setupMaintenance(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((fixtureOpts) => (window as any).__setMaintenanceFixture(fixtureOpts), opts);
	await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toBeVisible({ timeout: 10_000 });
}

async function maintenanceFetchLog(page: Page): Promise<Array<{ url: string; method: string; body: unknown }>> {
	return await page.evaluate(() => (window as any).__getMaintenanceFetchLog());
}

function maintenanceCardByHeading(page: Page, heading: string | RegExp): Locator {
	return page.getByRole("heading", { name: heading }).locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' border ')][1]");
}

function archivedWorktreeCard(page: Page): Locator {
	return page.locator('[data-section="archived-session-worktrees"]');
}

function archivedWorktreeScan() {
	return {
		sessions: [
			{
				id: REMOVABLE_SESSION_ID,
				title: "Archived cleanup target",
				archivedAt: 1_720_000_000_000,
				projectName: "Fixture Project",
				branch: "session/archived-alpha",
				repoPath: "C:/repo",
				worktreePath: "C:/repo-wt/session-archived-alpha",
				worktrees: [
					{
						key: "arch-alpha::packages-web",
						sessionId: REMOVABLE_SESSION_ID,
						repo: "packages/web",
						repoPath: "C:/repo/packages/web",
						path: "C:/repo-wt/session-archived-alpha/packages/web",
						branch: "session/archived-alpha",
						pathExists: true,
						gitWorktreeMetadataExists: true,
						localBranchExists: true,
						status: "removable",
						reason: "Safe to remove",
						detail: "No live session, goal, team, staff, or sibling record references this path.",
						willDeleteBranch: true,
					},
				],
			},
			{
				id: SKIPPED_SESSION_ID,
				title: "Guarded archived delegate",
				archivedAt: 1_720_000_100_000,
				projectName: "Fixture Project",
				branch: "session/shared-branch",
				repoPath: "C:/repo",
				worktreePath: "C:/repo-wt/shared-worktree",
				worktrees: [
					{
						key: "arch-skip::root",
						sessionId: SKIPPED_SESSION_ID,
						repo: ".",
						repoPath: "C:/repo",
						path: "C:/repo-wt/shared-worktree",
						branch: "session/shared-branch",
						pathExists: true,
						gitWorktreeMetadataExists: true,
						localBranchExists: true,
						status: "skipped",
						reason: "Still referenced",
						detail: "A live team member still uses this worktree path.",
						willDeleteBranch: false,
						branchDeleteBlockedReason: "Branch is referenced by a live team member.",
					},
				],
			},
		],
		counts: {
			archivedSessions: 2,
			sessionsWithWorktrees: 2,
			removableWorktrees: 1,
			skippedWorktrees: 1,
			alreadyCleanedWorktrees: 0,
		},
	};
}

function alreadyCleanedArchivedWorktreeScan() {
	return {
		sessions: [
			{
				id: CLEANED_SESSION_ID,
				title: "Already cleaned archive",
				archivedAt: 1_720_000_200_000,
				projectName: "Fixture Project",
				branch: "session/already-cleaned",
				repoPath: "C:/repo",
				worktreePath: "C:/repo-wt/already-cleaned",
				worktrees: [
					{
						key: "arch-cleaned::root",
						sessionId: CLEANED_SESSION_ID,
						repo: ".",
						repoPath: "C:/repo",
						path: "C:/repo-wt/already-cleaned",
						branch: "session/already-cleaned",
						pathExists: false,
						gitWorktreeMetadataExists: false,
						localBranchExists: true,
						status: "already-cleaned",
						reason: "Already cleaned",
						detail: "The worktree path and git worktree metadata are gone.",
						willDeleteBranch: false,
					},
				],
			},
		],
		counts: {
			archivedSessions: 1,
			sessionsWithWorktrees: 1,
			removableWorktrees: 0,
			skippedWorktrees: 0,
			alreadyCleanedWorktrees: 1,
		},
	};
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SETTINGS_SRC, API_SRC, SEARCH_DOT_SRC],
	});
});

test.describe("Maintenance tab fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders maintenance sections with actions disabled before scan", async ({ page }) => {
		await setupMaintenance(page);

		await expect(page.getByText("Orphaned Sessions")).toBeVisible();
		await expect(page.getByText("Expired Archives")).toBeVisible();
		await expect(archivedWorktreeCard(page).getByRole("heading", { name: "Archived Session Worktrees" })).toBeVisible();
		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/);
		await expect(maintenanceCardByHeading(page, "Orphaned Worktrees").getByRole("button", { name: /Clean Up/ })).toBeDisabled();
		await expect(archivedWorktreeCard(page).locator('[data-action="cleanup-archived-session-worktrees"]')).toBeDisabled();
		await expect(maintenanceCardByHeading(page, "Orphaned Sessions").getByRole("button", { name: /Terminate/ })).toBeDisabled();
		await expect(maintenanceCardByHeading(page, "Expired Archives").getByRole("button", { name: /Purge/ })).toBeDisabled();
	});

	test("scan buttons call APIs and render empty results", async ({ page }) => {
		await setupMaintenance(page);

		await maintenanceCardByHeading(page, "Orphaned Worktrees").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		await archivedWorktreeCard(page).locator('[data-action="scan-archived-session-worktrees"]').click();
		await expect(archivedWorktreeCard(page).getByText(/No archived(?: session)? worktrees found/i)).toBeVisible({ timeout: 5_000 });

		await maintenanceCardByHeading(page, "Orphaned Sessions").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 5_000 });

		await maintenanceCardByHeading(page, "Expired Archives").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 5_000 });

		await expect.poll(async () => (await maintenanceFetchLog(page)).map(e => e.url)).toEqual(expect.arrayContaining([
			"/api/maintenance/orphaned-worktrees",
			"/api/maintenance/archived-session-worktrees",
			"/api/maintenance/orphaned-sessions",
			"/api/maintenance/expired-archives",
		]));
	});

	test("archived worktree scan renders removable and skipped rows with safety details", async ({ page }) => {
		await setupMaintenance(page, { archivedWorktreeScan: archivedWorktreeScan() });

		await archivedWorktreeCard(page).locator('[data-action="scan-archived-session-worktrees"]').click();
		const card = archivedWorktreeCard(page);
		await expect(card.getByText("Archived cleanup target")).toBeVisible({ timeout: 5_000 });
		await expect(card.getByText("Guarded archived delegate")).toBeVisible();
		await expect(card.getByText("arch-rem")).toBeVisible();
		await expect(card.getByText("arch-ski")).toBeVisible();

		const removableRow = card.locator('[data-archived-worktree-key="arch-alpha::packages-web"]');
		await expect(removableRow).toContainText("session/archived-alpha");
		await expect(removableRow).toContainText("packages/web");
		await expect(removableRow).toContainText("C:/repo-wt/session-archived-alpha/packages/web");
		await expect(removableRow).toContainText("Safe to remove");
		await expect(removableRow).toContainText("No live session, goal, team, staff, or sibling record references this path.");
		await expect(removableRow.getByRole("checkbox")).toBeEnabled();
		await expect(removableRow.getByRole("checkbox")).toBeChecked();

		const skippedRow = card.locator('[data-archived-worktree-key="arch-skip::root"]');
		await expect(skippedRow).toContainText("session/shared-branch");
		await expect(skippedRow).toContainText(".");
		await expect(skippedRow).toContainText("C:/repo-wt/shared-worktree");
		await expect(skippedRow).toContainText("Still referenced");
		await expect(skippedRow).toContainText("A live team member still uses this worktree path.");
		await expect(skippedRow.getByRole("checkbox")).toBeDisabled();
	});

	test("archived selected cleanup posts selected worktrees, shows counts, clears cleaned rows, and rescans", async ({ page }) => {
		await setupMaintenance(page, { archivedWorktreeScan: archivedWorktreeScan() });
		const card = archivedWorktreeCard(page);

		await card.locator('[data-action="scan-archived-session-worktrees"]').click();
		await expect(card.locator('[data-archived-worktree-key="arch-alpha::packages-web"]')).toBeVisible({ timeout: 5_000 });
		await card.locator('[data-action="cleanup-archived-session-worktrees"]').click();

		await expect(card.locator('[data-archived-worktree-key="arch-alpha::packages-web"]')).toHaveCount(0, { timeout: 5_000 });
		await expect(card.locator('[data-archived-worktree-key="arch-skip::root"]')).toBeVisible();
		await expect.poll(async () => await card.textContent()).toMatch(/(cleaned\D+1|1\D+cleaned)/i);
		await expect.poll(async () => await card.textContent()).toMatch(/(branch\D+1|1\D+branch)/i);

		const log = await maintenanceFetchLog(page);
		const cleanupPost = log.find(entry => entry.method === "POST" && entry.url === "/api/maintenance/cleanup-archived-session-worktrees");
		expect(cleanupPost?.body).toMatchObject({
			mode: "selected",
			worktrees: [
				expect.objectContaining({
					sessionId: REMOVABLE_SESSION_ID,
					repo: "packages/web",
					path: "C:/repo-wt/session-archived-alpha/packages/web",
					key: "arch-alpha::packages-web",
				}),
			],
		});
		expect((cleanupPost?.body as { worktrees?: unknown[] } | undefined)?.worktrees).toHaveLength(1);
		expect(log.filter(entry => entry.method === "GET" && entry.url.startsWith("/api/maintenance/archived-session-worktrees"))).toHaveLength(2);
	});

	test("already-cleaned archived diagnostic rows are disabled when the UI exposes them", async ({ page }) => {
		await setupMaintenance(page, { archivedWorktreeScan: alreadyCleanedArchivedWorktreeScan() });
		const card = archivedWorktreeCard(page);

		const diagnosticsControl = card.getByRole("checkbox", { name: /already cleaned|diagnostic/i })
			.or(card.getByRole("button", { name: /already cleaned|diagnostic/i }));
		if (await diagnosticsControl.count()) await diagnosticsControl.first().click();

		await card.locator('[data-action="scan-archived-session-worktrees"]').click();
		const cleanedRow = card.locator('[data-archived-worktree-key="arch-cleaned::root"]');
		if (await cleanedRow.count() === 0) test.skip(true, "Archived worktree diagnostics are not exposed by this UI.");

		await expect(cleanedRow).toContainText("Already cleaned archive");
		await expect(cleanedRow).toContainText("arch-cle");
		await expect(cleanedRow).toContainText("session/already-cleaned");
		await expect(cleanedRow).toContainText("C:/repo-wt/already-cleaned");
		await expect(cleanedRow).toContainText("Already cleaned");
		await expect(cleanedRow).toContainText("The worktree path and git worktree metadata are gone.");
		await expect(cleanedRow.getByRole("checkbox")).toBeDisabled();
		await expect(card.locator('[data-action="cleanup-archived-session-worktrees"]')).toBeDisabled();
	});

	test("cleanup actions POST and then rescan", async ({ page }) => {
		await setupMaintenance(page, {
			worktrees: [{ path: "C:/tmp/orphan", branch: "session/orphan" }],
			sessions: [{ id: "12345678-aaaa-bbbb-cccc-123456789abc", title: "Verifier orphan" }],
			archives: { count: 1, totalSizeBytes: 2048 },
		});

		const orphanedWorktreesCard = maintenanceCardByHeading(page, "Orphaned Worktrees");
		await orphanedWorktreesCard.getByRole("button", { name: "Scan" }).click();
		const cleanUp = orphanedWorktreesCard.getByRole("button", { name: /Clean Up \(1\)/ });
		await expect(cleanUp).toBeEnabled({ timeout: 5_000 });
		await cleanUp.click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		const orphanedSessionsCard = maintenanceCardByHeading(page, "Orphaned Sessions");
		await orphanedSessionsCard.getByRole("button", { name: "Scan" }).click();
		const terminate = orphanedSessionsCard.getByRole("button", { name: /Terminate \(1\)/ });
		await expect(terminate).toBeEnabled({ timeout: 5_000 });
		await terminate.click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 5_000 });

		const expiredArchivesCard = maintenanceCardByHeading(page, "Expired Archives");
		await expiredArchivesCard.getByRole("button", { name: "Scan" }).click();
		const purge = expiredArchivesCard.getByRole("button", { name: /Purge \(1\)/ });
		await expect(purge).toBeEnabled({ timeout: 5_000 });
		await purge.click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 5_000 });

		await expect.poll(async () => (await maintenanceFetchLog(page)).map(e => `${e.method} ${e.url}`)).toEqual(expect.arrayContaining([
			"POST /api/maintenance/cleanup-worktrees",
			"POST /api/maintenance/cleanup-sessions",
			"POST /api/maintenance/purge-archives",
		]));
	});

	test("archived worktree scan state persists when switching tabs and back", async ({ page }) => {
		await setupMaintenance(page, { archivedWorktreeScan: archivedWorktreeScan() });

		await archivedWorktreeCard(page).locator('[data-action="scan-archived-session-worktrees"]').click();
		await expect(archivedWorktreeCard(page).locator('[data-archived-worktree-key="arch-alpha::packages-web"]')).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "General" }).first().click();
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();
		await expect(archivedWorktreeCard(page).getByRole("heading", { name: "Archived Session Worktrees" })).toBeVisible({ timeout: 5_000 });
		await expect(archivedWorktreeCard(page).locator('[data-archived-worktree-key="arch-alpha::packages-web"]')).toBeVisible({ timeout: 5_000 });
	});

	test("worktree scan state persists when switching tabs and back", async ({ page }) => {
		await setupMaintenance(page);

		await maintenanceCardByHeading(page, "Orphaned Worktrees").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "General" }).first().click();
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();
		await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });
	});
});
