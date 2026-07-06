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

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__maintenanceFixtureReady === true, null, { timeout: 10_000 });
}

async function setupMaintenance(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((fixtureOpts) => (window as any).__setMaintenanceFixture(fixtureOpts), opts);
	await expect(page.getByTestId("worktree-cleanup-maintenance")).toBeVisible({ timeout: 10_000 });
}

async function maintenanceFetchLog(page: Page): Promise<Array<{ url: string; method: string; body: unknown }>> {
	return await page.evaluate(() => (window as any).__getMaintenanceFetchLog());
}

function maintenanceCardByHeading(page: Page, heading: string | RegExp): Locator {
	return page.getByRole("heading", { name: heading }).locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' border ')][1]");
}

function worktreeCard(page: Page): Locator {
	return page.getByTestId("worktree-cleanup-maintenance");
}

function worktreeItem(overrides: Record<string, any>): Record<string, any> {
	const actionable = overrides.actionable ?? overrides.disposition === "ready-to-clean";
	return {
		id: overrides.id,
		projectId: "fixture-project",
		projectName: "Fixture Project",
		repo: ".",
		repoPath: "C:/repo",
		repoDisplayName: "app",
		path: `C:/repo-wt/${overrides.id}`,
		branch: `session/${overrides.id}`,
		sources: ["git-worktree"],
		owners: [],
		classification: overrides.classification,
		disposition: overrides.disposition,
		reason: overrides.reason,
		detail: actionable ? "No live or durable Bobbit record references this path." : "Not removable in this fixture category.",
		actionable,
		selectable: actionable,
		defaultSelected: actionable,
		pathExists: actionable,
		gitWorktreeMetadataExists: actionable,
		localBranchExists: actionable,
		willDeleteBranch: actionable,
		...overrides,
	};
}

function worktreeInventory(items: Record<string, any>[]) {
	const counts: Record<string, any> = {
		total: items.length,
		readyToClean: items.filter((item) => item.disposition === "ready-to-clean").length,
		protectedInUse: items.filter((item) => item.disposition === "protected" || item.classification === "protected-in-use" || item.classification === "pool-entry").length,
		archivedOwned: items.filter((item) => item.classification === "archived-owned").length,
		unownedGitWorktrees: items.filter((item) => item.classification === "unowned-git-worktree").length,
		poolEntries: items.filter((item) => item.classification === "pool-entry").length,
		alreadyCleaned: items.filter((item) => item.disposition === "already-cleaned").length,
		needsAttention: items.filter((item) => item.disposition === "needs-attention" || item.disposition === "failed").length,
		scanErrors: items.filter((item) => item.classification === "scan-error").length,
		defaultSelected: items.filter((item) => item.defaultSelected !== false && item.disposition === "ready-to-clean").length,
		byClassification: {},
		byReason: {},
		bySource: {},
	};
	for (const item of items) {
		counts.byClassification[item.classification] = (counts.byClassification[item.classification] || 0) + 1;
		counts.byReason[item.reason] = (counts.byReason[item.reason] || 0) + 1;
		for (const source of item.sources || []) counts.bySource[source] = (counts.bySource[source] || 0) + 1;
	}
	return { items, counts, generatedAt: Date.now(), scanned: { projects: 1, repos: 2, worktreeRoots: 1 } };
}

function cleanupResponse(counts: Record<string, number>, results: any[] = []): any {
	return { counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts }, results };
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, SETTINGS_SRC, API_SRC, SEARCH_DOT_SRC] });
});

test.describe("Maintenance tab fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders maintenance sections with worktree cleanup disabled before scan", async ({ page }) => {
		await setupMaintenance(page);

		await expect(page.getByText("Orphaned Sessions")).toBeVisible();
		await expect(page.getByText("Expired Archives")).toBeVisible();
		await expect(worktreeCard(page).getByRole("heading", { name: "Worktree Cleanup" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "Archived Session Worktrees" })).toHaveCount(0);
		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/);
		await expect(worktreeCard(page).getByTestId("worktree-cleanup-clean-all")).toBeDisabled();
		await expect(worktreeCard(page).getByTestId("worktree-cleanup-clean-selected")).toBeDisabled();
		await expect(maintenanceCardByHeading(page, "Orphaned Sessions").getByRole("button", { name: /Terminate/ })).toBeDisabled();
		await expect(maintenanceCardByHeading(page, "Expired Archives").getByRole("button", { name: /Purge/ })).toBeDisabled();
	});

	test("scan buttons call APIs and render empty worktree cleanup", async ({ page }) => {
		await setupMaintenance(page);
		const card = worktreeCard(page);

		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.getByTestId("worktree-cleanup-empty-state")).toContainText(/Nothing safe to clean right now/i, { timeout: 5_000 });

		await maintenanceCardByHeading(page, "Orphaned Sessions").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 5_000 });

		await maintenanceCardByHeading(page, "Expired Archives").getByRole("button", { name: "Scan" }).click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 5_000 });

		await expect.poll(async () => (await maintenanceFetchLog(page)).map(e => e.url)).toEqual(expect.arrayContaining([
			"/api/maintenance/worktrees",
			"/api/maintenance/orphaned-sessions",
			"/api/maintenance/expired-archives",
		]));
	});

	test("worktree scan defaults to actionable rows and exposes diagnostics on demand", async ({ page }) => {
		await setupMaintenance(page, {
			worktreeInventory: worktreeInventory([
				worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", repo: "packages/web", repoDisplayName: "packages/web", repoPath: "C:/repo/packages/web", path: "C:/repo-wt/session-archived-alpha/packages/web", branch: "session/archived-alpha", sources: ["archived-session", "git-worktree"], owners: [{ type: "archived-session", id: "arch-1", title: "Archived cleanup target", archived: true }] }),
				worktreeItem({ id: "git-orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree", branch: "session/orphan" }),
				worktreeItem({ id: "pool-1", classification: "pool-entry", disposition: "protected", reason: "safe-pool-entry", actionable: false, selectable: false, defaultSelected: false, sources: ["pool", "filesystem"] }),
				worktreeItem({ id: "skip-live", classification: "protected-in-use", disposition: "protected", reason: "referenced-by-live-team", actionable: false, selectable: false, defaultSelected: false, branchDeleteBlockedReason: "branch-referenced-by-live-record", willDeleteBranch: false }),
				worktreeItem({ id: "already-cleaned", classification: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", actionable: false, selectable: false, defaultSelected: false, pathExists: false, gitWorktreeMetadataExists: false, willDeleteBranch: false }),
			]),
		});

		const card = worktreeCard(page);
		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*2/);
		await expect(card.getByTestId("worktree-cleanup-summary-protected")).toContainText(/Protected\/in use:\s*2/);
		await expect(card).toContainText(/Pool entries:\s*1/);
		await expect(page.locator('[data-testid="worktree-cleanup-row"][data-disposition="ready-to-clean"]:visible')).toHaveCount(2);
		const removableRow = card.locator('[data-worktree-id="arch-alpha"]');
		await expect(removableRow).toContainText("repo: packages/web");
		await expect(removableRow).toContainText("branch: session/archived-alpha");
		await expect(removableRow).toContainText("Branch will be deleted");
		await expect(removableRow).toContainText("worktree: C:/repo-wt/session-archived-alpha/packages/web");
		await expect(removableRow).toContainText("repo path: C:/repo/packages/web");
		await expect(removableRow.getByRole("checkbox")).toBeEnabled();
		await expect(removableRow.getByRole("checkbox")).toBeChecked();

		await expect(card.locator('[data-worktree-id="skip-live"]')).toHaveCount(0);
		await card.getByTestId("worktree-cleanup-show-diagnostics").click();
		await expect(card.getByTestId("worktree-cleanup-group-pool-entry")).toBeVisible();
		const skippedRow = card.locator('[data-worktree-id="skip-live"]');
		await expect(skippedRow).toContainText("Protected/in use");
		await expect(skippedRow).toHaveAttribute("data-reason", "referenced-by-live-team");
		await expect(skippedRow).toContainText("Branch will be kept: branch-referenced-by-live-record");
		await expect(skippedRow.getByRole("checkbox")).toHaveCount(0);
	});

	test("selected cleanup posts item ids, shows counts, clears cleaned rows, and rescans", async ({ page }) => {
		const readyOne = worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session", "git-worktree"] });
		const readyTwo = worktreeItem({ id: "git-orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" });
		await setupMaintenance(page, {
			worktreeInventory: worktreeInventory([readyOne, readyTwo]),
			worktreeCleanup: cleanupResponse({ requested: 1, cleaned: 1, branchDeleted: 0 }, [{ itemId: "arch-alpha", status: "cleaned", worktreeRemoved: true, branchDeleted: false }]),
			worktreeNextInventory: worktreeInventory([readyTwo]),
		});
		const card = worktreeCard(page);

		await card.getByTestId("worktree-cleanup-scan").click();
		await card.getByTestId("worktree-cleanup-clear-selection").click();
		await card.locator('[data-worktree-id="arch-alpha"] input[type="checkbox"]').click();
		await card.locator('[data-action="cleanup-selected-worktrees"]').click();

		await expect(card.locator('[data-worktree-id="arch-alpha"]')).toHaveCount(0, { timeout: 5_000 });
		await expect.poll(async () => await card.textContent()).toMatch(/cleaned\D+1/i);

		const log = await maintenanceFetchLog(page);
		const cleanupPost = log.find(entry => entry.method === "POST" && entry.url === "/api/maintenance/cleanup-worktrees");
		expect(cleanupPost?.body).toEqual({ mode: "selected", itemIds: ["arch-alpha"] });
		expect(log.filter(entry => entry.method === "GET" && entry.url === "/api/maintenance/worktrees")).toHaveLength(2);
	});

	test("cleanup actions POST and then rescan", async ({ page }) => {
		await setupMaintenance(page, {
			worktreeInventory: worktreeInventory([worktreeItem({ id: "orphan", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" })]),
			worktreeCleanup: cleanupResponse({ requested: 1, cleaned: 1 }),
			worktreeNextInventory: worktreeInventory([]),
			sessions: [{ id: "12345678-aaaa-bbbb-cccc-123456789abc", title: "Verifier orphan" }],
			archives: { count: 1, totalSizeBytes: 2048 },
		});

		const card = worktreeCard(page);
		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.getByTestId("worktree-cleanup-clean-all")).toBeEnabled({ timeout: 5_000 });
		await card.getByTestId("worktree-cleanup-clean-all").click();
		await page.getByRole("button", { name: "Clean worktrees" }).evaluate((button: HTMLElement) => button.click());
		await expect(card.getByTestId("worktree-cleanup-empty-state")).toBeVisible({ timeout: 5_000 });

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

	test("worktree scan state persists when switching tabs and back", async ({ page }) => {
		await setupMaintenance(page, {
			worktreeInventory: worktreeInventory([worktreeItem({ id: "arch-alpha", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session"] })]),
		});

		const card = worktreeCard(page);
		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.locator('[data-worktree-id="arch-alpha"]')).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "General" }).first().click();
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();
		await expect(worktreeCard(page).getByRole("heading", { name: "Worktree Cleanup" })).toBeVisible({ timeout: 5_000 });
		await expect(worktreeCard(page).locator('[data-worktree-id="arch-alpha"]')).toBeVisible({ timeout: 5_000 });
	});
});
