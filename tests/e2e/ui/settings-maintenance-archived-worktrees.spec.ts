import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

type MaintenanceStubState = {
	scan: any;
	cleanup: any;
	nextScan?: any;
	cleanupBodies: any[];
};

function worktreeItem(overrides: Record<string, any>): Record<string, any> {
	const actionable = overrides.actionable ?? overrides.disposition === "ready-to-clean";
	return {
		id: overrides.id,
		projectId: "default",
		projectName: "default",
		repo: ".",
		repoPath: "/fixture/project",
		repoDisplayName: "app",
		path: `/fixture/worktrees/${overrides.id}`,
		branch: `session/${overrides.id}`,
		sources: ["git-worktree"],
		owners: [],
		classification: overrides.classification,
		disposition: overrides.disposition,
		reason: overrides.reason,
		detail: actionable ? "Server classified this worktree as safe to remove." : "Not removable in this fixture category.",
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

function scanResponse(items: Record<string, any>[]): any {
	const counts = {
		total: items.length,
		readyToClean: items.filter((item) => item.disposition === "ready-to-clean").length,
		protectedInUse: items.filter((item) => item.disposition === "protected" || item.classification === "protected-in-use").length,
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
	return {
		counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts },
		results,
	};
}

async function installMaintenanceRoutes(page: Page, state: MaintenanceStubState): Promise<void> {
	await page.route(/\/api\/maintenance\/worktrees(?:\?.*)?$/, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.scan) });
	});
	await page.route(/\/api\/maintenance\/cleanup-worktrees(?:\?.*)?$/, async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		state.cleanupBodies.push(route.request().postDataJSON?.() ?? JSON.parse(route.request().postData() || "{}"));
		if (state.nextScan) state.scan = state.nextScan;
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.cleanup) });
	});
}

async function openMaintenance(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/maintenance");
	await expect(page.getByTestId("worktree-cleanup-maintenance")).toBeVisible({ timeout: 10_000 });
}

test.describe("Settings Maintenance worktree cleanup UX", () => {
	test("mixed inventory is actionable-first and diagnostics include pool entries", async ({ page }) => {
		const state: MaintenanceStubState = {
			scan: scanResponse([
				worktreeItem({ id: "arch-ready", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session", "git-worktree"], owners: [{ type: "archived-session", id: "arch-1", title: "Archived cleanup target", archived: true }], branch: "session/archived-alpha", path: "/fixture/worktrees/archived-alpha", willDeleteBranch: true }),
				worktreeItem({ id: "git-ready", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree", branch: "session/orphan", path: "/fixture/worktrees/orphan" }),
				worktreeItem({ id: "pool-1", classification: "pool-entry", disposition: "protected", reason: "safe-pool-entry", actionable: false, selectable: false, defaultSelected: false, sources: ["pool", "filesystem"], branch: "session/_pool-1" }),
				worktreeItem({ id: "live-1", classification: "protected-in-use", disposition: "protected", reason: "referenced-by-live-session", actionable: false, selectable: false, defaultSelected: false, owners: [{ type: "runtime-session", id: "live-1", title: "Live session" }] }),
				worktreeItem({ id: "fs-1", classification: "stale-filesystem-only", disposition: "needs-attention", reason: "filesystem-only-needs-attention", actionable: false, selectable: false, defaultSelected: false, sources: ["filesystem"], branch: undefined, willDeleteBranch: false }),
				worktreeItem({ id: "cleaned-1", classification: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", actionable: false, selectable: false, defaultSelected: false, sources: ["archived-session"], pathExists: false, gitWorktreeMetadataExists: false, willDeleteBranch: false }),
			]),
			cleanup: cleanupResponse({}),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);

		const card = page.getByTestId("worktree-cleanup-maintenance");
		await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "Archived Session Worktrees" })).toHaveCount(0);
		await card.getByTestId("worktree-cleanup-scan").click();

		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*2/);
		await expect(card.getByTestId("worktree-cleanup-summary-selected")).toContainText(/Selected:\s*2/);
		await expect(card.getByTestId("worktree-cleanup-summary-protected")).toContainText(/Protected\/in use:\s*2/);
		await expect(card.getByTestId("worktree-cleanup-summary-already-cleaned")).toContainText(/Already cleaned:\s*1/);
		await expect(card.getByTestId("worktree-cleanup-summary-needs-attention")).toContainText(/Needs attention:\s*1/);
		await expect(card).toContainText(/Pool entries:\s*1/);
		await expect(page.locator('[data-testid="worktree-cleanup-row"][data-disposition="ready-to-clean"]:visible')).toHaveCount(2);
		await expect(page.locator('[data-testid="worktree-cleanup-row"][data-classification="pool-entry"]:visible')).toHaveCount(0);
		await expect(card.locator('[data-worktree-id="arch-ready"]')).toContainText("Branch will be deleted");
		await expect(card.locator('[data-worktree-id="arch-ready"]').getByRole("checkbox")).toBeChecked();

		await card.getByTestId("worktree-cleanup-show-diagnostics").click();
		await expect(card.getByTestId("worktree-cleanup-group-pool-entry")).toBeVisible();
		await expect(card.getByTestId("worktree-cleanup-group-referenced-by-live-session")).toBeVisible();
		await expect(card.getByTestId("worktree-cleanup-group-filesystem-only-needs-attention")).toBeVisible();
		await expect(card.getByTestId("worktree-cleanup-group-already-cleaned")).toBeVisible();
		await expect(card.locator('[data-worktree-id="pool-1"]').getByRole("checkbox")).toHaveCount(0);
	});

	test("selected cleanup posts selected item ids and rescans", async ({ page }) => {
		const readyOne = worktreeItem({ id: "ready-1", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session", "git-worktree"] });
		const readyTwo = worktreeItem({ id: "ready-2", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" });
		const state: MaintenanceStubState = {
			scan: scanResponse([readyOne, readyTwo]),
			cleanup: cleanupResponse({ requested: 1, cleaned: 1 }, [{ itemId: "ready-1", status: "cleaned", worktreeRemoved: true, branchDeleted: false }]),
			nextScan: scanResponse([readyTwo]),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);
		const card = page.getByTestId("worktree-cleanup-maintenance");
		await card.getByTestId("worktree-cleanup-scan").click();

		await card.getByTestId("worktree-cleanup-clear-selection").click();
		await card.locator('[data-worktree-id="ready-1"] input[type="checkbox"]').click();
		await expect(card.getByTestId("worktree-cleanup-summary-selected")).toContainText(/Selected:\s*1/);
		await card.getByTestId("worktree-cleanup-clean-selected").click();

		await expect.poll(() => state.cleanupBodies).toEqual([{ mode: "selected", itemIds: ["ready-1"] }]);
		await expect(card).toContainText(/Cleaned:\s*1/i);
		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*1/);
		await expect(card.locator('[data-worktree-id="ready-1"]')).toHaveCount(0);
	});

	test("clean all posts all-safe and disables after zero-safe rescan", async ({ page }) => {
		const protectedItem = worktreeItem({ id: "protected", classification: "protected-in-use", disposition: "protected", reason: "referenced-by-live-session", actionable: false, selectable: false, defaultSelected: false });
		const state: MaintenanceStubState = {
			scan: scanResponse([
				worktreeItem({ id: "ready-1", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session"] }),
				worktreeItem({ id: "ready-2", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" }),
				protectedItem,
			]),
			cleanup: cleanupResponse({ requested: 2, cleaned: 2, branchDeleted: 2 }),
			nextScan: scanResponse([protectedItem]),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);
		const card = page.getByTestId("worktree-cleanup-maintenance");
		await card.getByTestId("worktree-cleanup-scan").click();
		await card.getByTestId("worktree-cleanup-clean-all").click();
		await page.getByRole("button", { name: "Clean worktrees" }).evaluate((button: HTMLElement) => button.click());

		await expect.poll(() => state.cleanupBodies).toEqual([{ mode: "all-safe" }]);
		await expect(card).toContainText(/Cleaned:\s*2/i);
		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("worktree-cleanup-empty-state")).toBeVisible();
		await expect(card.getByTestId("worktree-cleanup-clean-all")).toBeDisabled();
		await expect(card.getByTestId("worktree-cleanup-clean-selected")).toBeDisabled();
	});

	test("zero-safe state hides diagnostics until expanded", async ({ page }) => {
		const state: MaintenanceStubState = {
			scan: scanResponse([
				...Array.from({ length: 6 }, (_, i) => worktreeItem({ id: `fs-${i}`, classification: "stale-filesystem-only", disposition: "needs-attention", reason: "filesystem-only-needs-attention", actionable: false, selectable: false, defaultSelected: false, sources: ["filesystem"], branch: undefined, willDeleteBranch: false })),
				worktreeItem({ id: "already-1", classification: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", actionable: false, selectable: false, defaultSelected: false, willDeleteBranch: false }),
			]),
			cleanup: cleanupResponse({}),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);

		const card = page.getByTestId("worktree-cleanup-maintenance");
		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("worktree-cleanup-empty-state")).toContainText(/Nothing safe to clean right now|Worktree inventory is clean/i);
		await expect(page.locator('[data-testid="worktree-cleanup-row"]:visible')).toHaveCount(0);

		await card.getByTestId("worktree-cleanup-show-diagnostics").click();
		const fsGroup = card.getByTestId("worktree-cleanup-group-filesystem-only-needs-attention");
		await expect(fsGroup).toBeVisible();
		await expect(fsGroup.locator('[data-testid="worktree-cleanup-row"]:visible')).toHaveCount(5);
		await card.getByTestId("worktree-cleanup-show-all-filesystem-only-needs-attention").click();
		await expect(fsGroup.locator('[data-testid="worktree-cleanup-row"]:visible')).toHaveCount(6);
		await expect(card.getByTestId("worktree-cleanup-group-already-cleaned")).toBeVisible();
	});
});
