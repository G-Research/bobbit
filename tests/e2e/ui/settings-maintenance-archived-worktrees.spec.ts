import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

type MaintenanceStubState = {
	scan: any;
	cleanup: any;
	nextScan?: any;
	cleanupBodies: any[];
};

function archivedWorktreeItem(overrides: Record<string, any>): Record<string, any> {
	const actionable = overrides.actionable ?? overrides.status === "removable";
	return {
		key: overrides.key,
		sessionId: overrides.sessionId,
		title: overrides.title,
		archivedAt: 1_700_000_000_000,
		projectId: "default",
		projectName: "default",
		repo: ".",
		repoPath: "/fixture/project",
		repoDisplayName: "app",
		path: `/fixture/worktrees/${overrides.key}`,
		branch: `archived/${overrides.key}`,
		source: "worktreePath",
		status: overrides.status,
		disposition: overrides.disposition,
		reason: overrides.reason,
		reasonCategory: overrides.reasonCategory,
		detail: actionable
			? "Safe to remove: no live session, goal, team, staff, or sibling worktree references this path."
			: "Not removable in this fixture category.",
		actionable,
		selectable: actionable,
		defaultSelected: actionable,
		selectionCategories: actionable ? ["all-removable", ...(overrides.selectionCategories ?? ["archived-session"])] : [],
		pathExists: actionable,
		gitWorktreeMetadataExists: actionable,
		localBranchExists: actionable,
		willDeleteBranch: actionable,
		...overrides,
	};
}

function scanResponse(items: Record<string, any>[]): any {
	const byDisposition: Record<string, number> = {};
	const byReason: Record<string, number> = {};
	const bySelectionCategory: Record<string, number> = {};
	for (const item of items) {
		byDisposition[item.disposition] = (byDisposition[item.disposition] || 0) + 1;
		byReason[item.reason] = (byReason[item.reason] || 0) + 1;
		for (const category of item.selectionCategories || []) bySelectionCategory[category] = (bySelectionCategory[category] || 0) + 1;
	}
	const groupedItems = new Map<string, Record<string, any>[]>();
	for (const item of items) {
		const groupId = item.status === "removable" ? "ready-to-clean" : item.reason;
		groupedItems.set(groupId, [...(groupedItems.get(groupId) || []), item]);
	}
	const ready = items.filter((item) => item.status === "removable");
	const already = items.filter((item) => item.status === "already-cleaned");
	const ineligible = items.filter((item) => item.status === "skipped" || item.disposition === "ineligible");
	const failed = items.filter((item) => item.status === "failed" || item.disposition === "failed");
	return {
		sessions: [...new Map(items.map((item) => [item.sessionId, item])).values()].map((sessionItem: any) => ({
			id: sessionItem.sessionId,
			title: sessionItem.title,
			archivedAt: sessionItem.archivedAt,
			projectId: sessionItem.projectId,
			projectName: sessionItem.projectName,
			worktrees: items.filter((item) => item.sessionId === sessionItem.sessionId),
		})),
		items,
		counts: {
			archivedSessions: new Set(items.map((item) => item.sessionId)).size,
			sessionsWithWorktrees: items.filter((item) => item.path).length,
			removableWorktrees: ready.length,
			skippedWorktrees: ineligible.length,
			alreadyCleanedWorktrees: already.length,
			totalItems: items.length,
			readyToClean: ready.length,
			defaultSelected: ready.length,
			alreadyCleaned: already.length,
			ineligible: ineligible.length,
			needsAttention: ineligible.length + failed.length,
			failed: failed.length,
			byDisposition,
			byReason,
			bySelectionCategory,
		},
		groups: [...groupedItems.entries()].map(([id, groupItems]) => ({
			id,
			label: id.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
			disposition: groupItems[0]?.disposition,
			reason: groupItems[0]?.reason,
			reasonCategory: groupItems[0]?.reasonCategory,
			count: groupItems.length,
			itemKeys: groupItems.map((item) => item.key),
			items: groupItems.slice(0, 5),
		})),
		selectionPresets: [
			{ id: "all-removable", label: "Select all removable", itemKeys: ready.map((item) => item.key), categories: ["all-removable"] },
			{ id: "archived-session", label: "Archived sessions only", itemKeys: ready.filter((item) => item.selectionCategories?.includes("archived-session")).map((item) => item.key), categories: ["archived-session"] },
		],
		generatedAt: Date.now(),
	};
}

function cleanupResponse(counts: Record<string, number>, results: any[] = []): any {
	return {
		counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts },
		results,
	};
}

async function installMaintenanceRoutes(page: Page, state: MaintenanceStubState): Promise<void> {
	await page.route(/\/api\/maintenance\/archived-session-worktrees(?:\?.*)?$/, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.scan) });
	});
	await page.route(/\/api\/maintenance\/cleanup-archived-session-worktrees(?:\?.*)?$/, async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		state.cleanupBodies.push(route.request().postDataJSON?.() ?? JSON.parse(route.request().postData() || "{}"));
		if (state.nextScan) state.scan = state.nextScan;
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.cleanup) });
	});
}

async function openMaintenance(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/maintenance");
	await expect(page.getByTestId("archived-worktree-maintenance")).toBeVisible({ timeout: 10_000 });
}

test.describe("Settings Maintenance archived worktree UX", () => {
	test("clean-all journey shows actionable-only defaults, posts server-authoritative mode, and rescans empty", async ({ page }) => {
		const skipped = archivedWorktreeItem({ key: "skip-live", sessionId: "skip-live", title: "Referenced by live session", status: "skipped", disposition: "ineligible", reason: "referenced-by-live-session", reasonCategory: "referenced" });
		const state: MaintenanceStubState = {
			scan: scanResponse([
				archivedWorktreeItem({ key: "ready-1", sessionId: "ready-1", title: "Ready archived worktree", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" }),
				skipped,
			]),
			cleanup: cleanupResponse({ requested: 1, cleaned: 1, branchDeleted: 1 }, [
				{ key: "ready-1", sessionId: "ready-1", status: "cleaned", reason: "safe-archived-session-worktree", worktreeRemoved: true, branchDeleted: true },
			]),
			nextScan: scanResponse([skipped]),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);

		const card = page.getByTestId("archived-worktree-maintenance");
		await card.getByTestId("archived-worktree-scan").click();
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*1/);
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*1/);
		await expect(card).not.toContainText(/With worktrees\s*:/);
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="removable"]:visible')).toHaveCount(1);
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="skipped"]:visible')).toHaveCount(0);

		await card.getByTestId("archived-worktree-clean-all").click();
		await page.getByRole("button", { name: "Clean worktrees" }).evaluate((button: HTMLElement) => button.click());
		await expect.poll(() => state.cleanupBodies).toEqual([{ mode: "all" }]);
		await expect(card).toContainText(/Cleaned:\s*1|Removed:\s*1/i);
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("archived-worktree-empty-state")).toBeVisible();
		await expect(card.getByTestId("archived-worktree-clean-all")).toBeDisabled();
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeDisabled();
	});

	test("zero-removable state hides skipped examples until disclosure and supports grouped samples", async ({ page }) => {
		const state: MaintenanceStubState = {
			scan: scanResponse([
				...Array.from({ length: 6 }, (_, i) => archivedWorktreeItem({ key: `missing-${i}`, sessionId: `missing-${i}`, title: `Missing path ${i}`, status: "skipped", disposition: "ineligible", reason: "no-worktree-path", reasonCategory: "missing-worktree-path", path: "" })),
				archivedWorktreeItem({ key: "sandbox-1", sessionId: "sandbox-1", title: "Sandbox path", status: "skipped", disposition: "ineligible", reason: "sandbox-container-path", reasonCategory: "sandbox-container-path", path: "/workspace-wt/session/sandbox" }),
				archivedWorktreeItem({ key: "already-1", sessionId: "already-1", title: "Already cleaned", status: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", reasonCategory: "already-cleaned" }),
			]),
			cleanup: cleanupResponse({}),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);

		const card = page.getByTestId("archived-worktree-maintenance");
		await card.getByTestId("archived-worktree-scan").click();
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("archived-worktree-empty-state")).toContainText(/Nothing safe to clean right now/i);
		await expect(card).toContainText(/Cleanup is disabled because there are 0 safe candidates/i);
		await expect(card.getByTestId("archived-worktree-clean-all")).toBeDisabled();
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeDisabled();
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="skipped"]:visible')).toHaveCount(0);
		await expect(card).not.toContainText("Missing path 0");
		await expect(card).not.toContainText(/With worktrees\s*:/);

		await card.getByTestId("archived-worktree-show-skipped").click();
		const missingGroup = card.getByTestId("archived-worktree-group-no-worktree-path");
		await expect(missingGroup).toBeVisible();
		await expect(missingGroup.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(5);
		await expect(card.getByTestId("archived-worktree-group-sandbox-container-path")).toBeVisible();
		await card.getByTestId("archived-worktree-show-all-no-worktree-path").click();
		await expect(missingGroup.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(6);
	});

	test("zero-removable all-already-cleaned scan shows representative already-cleaned examples", async ({ page }) => {
		const alreadyCleaned = archivedWorktreeItem({ key: "already-only-1", sessionId: "already-only-1", title: "Already cleaned only", status: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", reasonCategory: "already-cleaned" });
		const scan = scanResponse([alreadyCleaned]);
		scan.sessions = [];
		scan.items = [];
		const state: MaintenanceStubState = {
			scan,
			cleanup: cleanupResponse({}),
			cleanupBodies: [],
		};
		await installMaintenanceRoutes(page, state);
		await openMaintenance(page);

		const card = page.getByTestId("archived-worktree-maintenance");
		await card.getByTestId("archived-worktree-scan").click();
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("archived-worktree-summary-already-cleaned")).toContainText(/Already cleaned:\s*1/);
		await expect(card.getByTestId("archived-worktree-empty-state")).toBeVisible();
		await expect(page.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(0);
		await card.getByTestId("archived-worktree-show-skipped").click();
		const alreadyGroup = card.getByTestId("archived-worktree-group-already-cleaned");
		await expect(alreadyGroup).toBeVisible();
		await expect(alreadyGroup).toContainText("Already cleaned only");
		await expect(alreadyGroup.locator('[data-testid="archived-worktree-row"][data-status="already-cleaned"]:visible')).toHaveCount(1);
	});
});
