import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/settings-admin-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "settings-admin-fixture-bundle.js");

const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const ROLE_MANAGER_SRC = path.resolve("src/app/role-manager-page.ts");
const TOOL_MANAGER_SRC = path.resolve("src/app/tool-manager-page.ts");
const WORKFLOW_SRC = path.resolve("src/app/workflow-page.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");
const COMPONENTS_EDITOR_SRC = path.resolve("src/app/components-editor.ts");
const IMAGE_SELECTOR_SRC = path.resolve("src/ui/dialogs/ImageModelSelector.ts");

const TEST_MODEL = "anthropic/claude-opus-4-1";
const TEST_THINKING = "high";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SETTINGS_SRC,
			ROLE_MANAGER_SRC,
			TOOL_MANAGER_SRC,
			WORKFLOW_SRC,
			CONFIG_SCOPE_SRC,
			COMPONENTS_EDITOR_SRC,
			IMAGE_SELECTOR_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__settingsAdminReady === true, null, { timeout: 10_000 });
}

async function reloadFixture(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__settingsAdminReady === true, null, { timeout: 10_000 });
}

async function resetFixture(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((o) => (window as any).__resetSettingsAdminFixture(o), opts);
}

async function renderSettings(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => (window as any).__renderSettingsAdminSettings(h), hash);
}

async function loadRoles(page: Page, hash = "#/roles"): Promise<void> {
	await page.evaluate((h) => (window as any).__loadSettingsAdminRoles(h), hash);
}

async function loadTools(page: Page, hash = "#/tools"): Promise<void> {
	await page.evaluate((h) => (window as any).__loadSettingsAdminTools(h), hash);
}

async function prefs(page: Page): Promise<Record<string, any>> {
	return await page.evaluate(() => (window as any).__getSettingsAdminPrefs());
}

type ArchivedWorktreeItemFixture = {
	key: string;
	sessionId: string;
	title: string;
	status: "removable" | "skipped" | "already-cleaned" | "failed";
	disposition: "ready-to-clean" | "already-cleaned" | "ineligible" | "needs-attention" | "failed";
	reason: string;
	reasonCategory: string;
	selectionCategories?: string[];
	projectId?: string;
	projectName?: string;
	repo?: string;
	repoPath?: string;
	path?: string;
	branch?: string;
	detail?: string;
	actionable?: boolean;
	selectable?: boolean;
	defaultSelected?: boolean;
};

function archivedWorktreeItem(overrides: Partial<ArchivedWorktreeItemFixture> & Pick<ArchivedWorktreeItemFixture, "key" | "sessionId" | "title" | "status" | "disposition" | "reason" | "reasonCategory">): ArchivedWorktreeItemFixture & Record<string, any> {
	const actionable = overrides.actionable ?? overrides.status === "removable";
	return {
		archivedAt: 1_700_000_000_000,
		projectId: "proj-1",
		projectName: "Scope UI Project",
		repo: ".",
		repoPath: "/fixture/project",
		repoDisplayName: "app",
		path: `/fixture/worktrees/${overrides.key}`,
		branch: `archived/${overrides.key}`,
		source: "worktreePath",
		pathExists: actionable,
		gitWorktreeMetadataExists: actionable,
		localBranchExists: actionable,
		willDeleteBranch: actionable,
		detail: overrides.status === "removable"
			? "Safe to remove: no live session, goal, team, staff, or sibling worktree references this path."
			: "Not removable in this fixture category.",
		actionable,
		selectable: actionable,
		defaultSelected: actionable,
		selectionCategories: actionable ? ["all-removable", ...(overrides.selectionCategories ?? ["archived-session"])] : [],
		...overrides,
	};
}

function archivedWorktreeScan(items: Array<ArchivedWorktreeItemFixture & Record<string, any>>) {
	const byDisposition: Record<string, number> = {};
	const byReason: Record<string, number> = {};
	const bySelectionCategory: Record<string, number> = {};
	for (const item of items) {
		byDisposition[item.disposition] = (byDisposition[item.disposition] || 0) + 1;
		byReason[item.reason] = (byReason[item.reason] || 0) + 1;
		for (const category of item.selectionCategories || []) bySelectionCategory[category] = (bySelectionCategory[category] || 0) + 1;
	}
	const groupedItems = new Map<string, Array<any>>();
	for (const item of items) {
		const groupId = item.status === "removable" ? "ready-to-clean" : item.reason;
		groupedItems.set(groupId, [...(groupedItems.get(groupId) || []), item]);
	}
	const groups = [...groupedItems.entries()].map(([id, groupItems]) => ({
		id,
		label: id === "ready-to-clean" ? "Ready to clean" : humanizeReason(id),
		disposition: groupItems[0]?.disposition,
		reason: groupItems[0]?.reason,
		reasonCategory: groupItems[0]?.reasonCategory,
		count: groupItems.length,
		itemKeys: groupItems.map((item) => item.key),
		items: groupItems.slice(0, 5),
	}));
	const ready = items.filter((item) => item.status === "removable");
	const already = items.filter((item) => item.status === "already-cleaned");
	const failed = items.filter((item) => item.status === "failed" || item.disposition === "failed");
	const ineligible = items.filter((item) => item.status === "skipped" || item.disposition === "ineligible");
	const sessions = [...new Map(items.map((item) => [item.sessionId, item])).values()].map((sessionItem: any) => ({
		id: sessionItem.sessionId,
		title: sessionItem.title,
		archivedAt: sessionItem.archivedAt,
		projectId: sessionItem.projectId,
		projectName: sessionItem.projectName,
		sandboxed: Boolean(sessionItem.sandboxed),
		worktrees: items.filter((item) => item.sessionId === sessionItem.sessionId),
	}));
	return {
		sessions,
		items,
		counts: {
			archivedSessions: sessions.length,
			sessionsWithWorktrees: items.filter((item) => item.path).length,
			removableWorktrees: ready.length,
			skippedWorktrees: ineligible.length,
			alreadyCleanedWorktrees: already.length,
			totalItems: items.length,
			readyToClean: ready.length,
			defaultSelected: ready.filter((item) => item.defaultSelected).length,
			alreadyCleaned: already.length,
			ineligible: ineligible.length,
			needsAttention: ineligible.length + failed.length,
			failed: failed.length,
			byDisposition,
			byReason,
			bySelectionCategory,
		},
		groups,
		selectionPresets: [
			{ id: "all-removable", label: "Select all removable", itemKeys: ready.map((item) => item.key), categories: ["all-removable"] },
			{ id: "archived-session", label: "Archived sessions only", itemKeys: ready.filter((item) => item.selectionCategories?.includes("archived-session")).map((item) => item.key), categories: ["archived-session"] },
			{ id: "current-project", label: "Current project", itemKeys: ready.filter((item) => item.selectionCategories?.includes("current-project")).map((item) => item.key), categories: ["current-project"] },
			{ id: "goal-team-delegate", label: "Goal/team/delegate worktrees", itemKeys: ready.filter((item) => item.selectionCategories?.includes("goal-team-delegate")).map((item) => item.key), categories: ["goal-team-delegate"] },
		],
		generatedAt: Date.now(),
	};
}

function humanizeReason(reason: string): string {
	return reason.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function cleanupResponse(counts: Partial<Record<"requested" | "cleaned" | "branchDeleted" | "skipped" | "alreadyCleaned" | "failed", number>>, results: any[] = []) {
	return {
		counts: { requested: 0, cleaned: 0, branchDeleted: 0, skipped: 0, alreadyCleaned: 0, failed: 0, ...counts },
		results,
	};
}

async function setArchivedWorktreeScan(page: Page, scan: any): Promise<void> {
	await page.evaluate((payload) => (window as any).__setArchivedWorktreeScan(payload), scan);
}

async function setArchivedWorktreeCleanup(page: Page, cleanup: any, nextScan?: any): Promise<void> {
	await page.evaluate(({ response, next }) => (window as any).__setArchivedWorktreeCleanup(response, next), { response: cleanup, next: nextScan });
}

async function scanArchivedWorktrees(page: Page) {
	const card = page.getByTestId("archived-worktree-maintenance");
	await expect(card).toBeVisible();
	await card.getByTestId("archived-worktree-scan").click();
	await expect(card.getByTestId("archived-worktree-summary-ready")).toBeVisible();
	return card;
}

function visibleArchivedRows(page: Page): Locator {
	return page.locator('[data-testid="archived-worktree-row"]:visible');
}

async function clickArchivedWorktreeRowCheckbox(page: Page, key: string): Promise<void> {
	const row = page.locator(`[data-testid="archived-worktree-row"][data-archived-worktree-key="${key}"]`).first();
	await expect(row).toBeVisible();
	const checkbox = row.locator('input[type="checkbox"], [role="checkbox"]').first();
	if (await checkbox.count()) await checkbox.click();
	else await row.click();
}

test.describe("Settings/admin UI fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
		await resetFixture(page);
	});

	test("archived worktree maintenance defaults to actionable rows and avoids ambiguous primary counts", async ({ page }) => {
		const scan = archivedWorktreeScan([
			archivedWorktreeItem({ key: "ready-1", sessionId: "arch-1", title: "Ready archived one", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" }),
			archivedWorktreeItem({ key: "ready-2", sessionId: "arch-2", title: "Ready archived two", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" }),
			...Array.from({ length: 8 }, (_, i) => archivedWorktreeItem({ key: `missing-${i}`, sessionId: `skip-missing-${i}`, title: `Missing path ${i}`, status: "skipped", disposition: "ineligible", reason: "no-worktree-path", reasonCategory: "missing-worktree-path", path: "" })),
			archivedWorktreeItem({ key: "sandbox-1", sessionId: "skip-sandbox-1", title: "Sandbox path", status: "skipped", disposition: "ineligible", reason: "sandbox-container-path", reasonCategory: "sandbox-container-path", path: "/workspace-wt/session/sandbox" }),
			archivedWorktreeItem({ key: "already-1", sessionId: "already-1", title: "Already cleaned", status: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", reasonCategory: "already-cleaned" }),
		]);
		await setArchivedWorktreeScan(page, scan);
		await renderSettings(page, "#/settings/system/maintenance");

		const card = await scanArchivedWorktrees(page);
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*2/);
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*2/);
		await expect(card.getByTestId("archived-worktree-summary-already-cleaned")).toContainText(/Already cleaned:\s*1/);
		await expect(card.getByTestId("archived-worktree-summary-needs-attention")).toContainText(/Needs attention:\s*9/);
		await expect(card).not.toContainText(/With worktrees\s*:/);
		await expect(visibleArchivedRows(page)).toHaveCount(2);
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="removable"]:visible')).toHaveCount(2);
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="skipped"]:visible')).toHaveCount(0);
		await expect(card).not.toContainText("no-worktree-path");
		await expect(card).not.toContainText("sandbox-container-path");
		await expect(card.getByTestId("archived-worktree-clean-all")).toBeEnabled();
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeEnabled();
	});

	test("archived worktree maintenance shows zero-removable empty state with skipped details hidden", async ({ page }) => {
		const scan = archivedWorktreeScan([
			...Array.from({ length: 6 }, (_, i) => archivedWorktreeItem({ key: `missing-${i}`, sessionId: `missing-${i}`, title: `Missing path ${i}`, status: "skipped", disposition: "ineligible", reason: "no-worktree-path", reasonCategory: "missing-worktree-path", path: "" })),
			archivedWorktreeItem({ key: "sandbox-1", sessionId: "sandbox-1", title: "Sandbox path", status: "skipped", disposition: "ineligible", reason: "sandbox-container-path", reasonCategory: "sandbox-container-path", path: "/workspace-wt/session/sandbox" }),
			archivedWorktreeItem({ key: "already-1", sessionId: "already-1", title: "Already cleaned", status: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", reasonCategory: "already-cleaned" }),
		]);
		await setArchivedWorktreeScan(page, scan);
		await renderSettings(page, "#/settings/system/maintenance");

		const card = await scanArchivedWorktrees(page);
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("archived-worktree-empty-state")).toBeVisible();
		await expect(card.getByTestId("archived-worktree-empty-state")).toContainText(/Nothing safe to clean right now/i);
		await expect(card).toContainText(/Cleanup is disabled because there are 0 safe candidates/i);
		await expect(card.getByTestId("archived-worktree-clean-all")).toBeDisabled();
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeDisabled();
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="skipped"]:visible')).toHaveCount(0);
		await expect(card).not.toContainText("Missing path 0");
		await expect(card).not.toContainText(/With worktrees\s*:/);
	});

	test("archived worktree skipped disclosure groups examples and expands one reason at a time", async ({ page }) => {
		const scan = archivedWorktreeScan([
			...Array.from({ length: 6 }, (_, i) => archivedWorktreeItem({ key: `missing-${i}`, sessionId: `missing-${i}`, title: `Missing path ${i}`, status: "skipped", disposition: "ineligible", reason: "no-worktree-path", reasonCategory: "missing-worktree-path", path: "" })),
			...Array.from({ length: 3 }, (_, i) => archivedWorktreeItem({ key: `sandbox-${i}`, sessionId: `sandbox-${i}`, title: `Sandbox path ${i}`, status: "skipped", disposition: "ineligible", reason: "sandbox-container-path", reasonCategory: "sandbox-container-path", path: `/workspace-wt/session/${i}` })),
			archivedWorktreeItem({ key: "referenced-1", sessionId: "referenced-1", title: "Referenced live", status: "skipped", disposition: "ineligible", reason: "referenced-by-live-session", reasonCategory: "referenced" }),
			archivedWorktreeItem({ key: "stale-1", sessionId: "stale-1", title: "Stale directory", status: "skipped", disposition: "needs-attention", reason: "stale-worktree-directory", reasonCategory: "stale" }),
		]);
		await setArchivedWorktreeScan(page, scan);
		await renderSettings(page, "#/settings/system/maintenance");

		const card = await scanArchivedWorktrees(page);
		await expect(page.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(0);
		await card.getByTestId("archived-worktree-show-skipped").click();
		const missingGroup = card.getByTestId("archived-worktree-group-no-worktree-path");
		await expect(missingGroup).toBeVisible();
		await expect(missingGroup).toContainText(/Missing Worktree Path|No Worktree Path/i);
		await expect(missingGroup).toHaveAttribute("data-reason", "no-worktree-path");
		await expect(missingGroup.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(5);
		await expect(card.getByTestId("archived-worktree-group-sandbox-container-path")).toBeVisible();
		await card.getByTestId("archived-worktree-show-all-no-worktree-path").click();
		await expect(missingGroup.locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(6);
		await expect(card.getByTestId("archived-worktree-group-sandbox-container-path").locator('[data-testid="archived-worktree-row"]:visible')).toHaveCount(3);
		await card.getByTestId("archived-worktree-show-skipped").click();
		await expect(page.locator('[data-testid="archived-worktree-row"][data-status="skipped"]:visible')).toHaveCount(0);
	});

	test("archived worktree selection presets select only actionable categories", async ({ page }) => {
		const scan = archivedWorktreeScan([
			archivedWorktreeItem({ key: "ready-arch-1", sessionId: "ready-arch-1", title: "Archived session one", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready", selectionCategories: ["archived-session", "current-project"] }),
			archivedWorktreeItem({ key: "ready-arch-2", sessionId: "ready-arch-2", title: "Archived session two", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready", projectId: "other-project" }),
			archivedWorktreeItem({ key: "ready-goal-1", sessionId: "ready-goal-1", title: "Goal child worktree", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready", selectionCategories: ["goal-team-delegate"], childKind: "team", projectId: "other-project" }),
			archivedWorktreeItem({ key: "skip-live", sessionId: "skip-live", title: "Live referenced", status: "skipped", disposition: "ineligible", reason: "referenced-by-live-session", reasonCategory: "referenced" }),
			archivedWorktreeItem({ key: "already-1", sessionId: "already-1", title: "Already cleaned", status: "already-cleaned", disposition: "already-cleaned", reason: "already-cleaned", reasonCategory: "already-cleaned" }),
		]);
		await setArchivedWorktreeScan(page, scan);
		await renderSettings(page, "#/settings/system/maintenance");

		const card = await scanArchivedWorktrees(page);
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*3/);
		await card.getByTestId("archived-worktree-clear-selection").click();
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*0/);
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeDisabled();
		await card.getByTestId("archived-worktree-select-archived-sessions").click();
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*2/);
		await card.getByTestId("archived-worktree-select-all-removable").click();
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*3/);
		if (await card.getByTestId("archived-worktree-select-current-project").count()) {
			await card.getByTestId("archived-worktree-select-current-project").click();
			await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*1/);
		}
		if (await card.getByTestId("archived-worktree-select-goal-team-delegate").count()) {
			await card.getByTestId("archived-worktree-select-goal-team-delegate").click();
			await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*1/);
		}
	});

	test("archived worktree clean selected posts selected keys, reports counts, and rescans", async ({ page }) => {
		const readyOne = archivedWorktreeItem({ key: "ready-1", sessionId: "ready-1", title: "Clean selected one", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" });
		const readyTwo = archivedWorktreeItem({ key: "ready-2", sessionId: "ready-2", title: "Clean selected two", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" });
		await setArchivedWorktreeScan(page, archivedWorktreeScan([readyOne, readyTwo]));
		await setArchivedWorktreeCleanup(page, cleanupResponse({ requested: 1, cleaned: 1 }, [{ key: "ready-1", sessionId: "ready-1", status: "cleaned", reason: "safe-archived-session-worktree", worktreeRemoved: true, branchDeleted: false }]), archivedWorktreeScan([readyTwo]));
		await renderSettings(page, "#/settings/system/maintenance");
		const card = await scanArchivedWorktrees(page);

		await card.getByTestId("archived-worktree-clear-selection").click();
		await clickArchivedWorktreeRowCheckbox(page, "ready-1");
		await expect(card.getByTestId("archived-worktree-summary-selected")).toContainText(/Selected:\s*1/);
		await page.evaluate(() => (window as any).__clearSettingsAdminFetchLog());
		await card.getByTestId("archived-worktree-clean-selected").click();
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminFetchLog().filter((e: any) => e.url === "/api/maintenance/cleanup-archived-session-worktrees").at(-1)?.body)).toMatchObject({
			mode: "selected",
			worktrees: [expect.objectContaining({ key: "ready-1", sessionId: "ready-1" })],
		});
		await expect(card).toContainText(/Cleaned:\s*1|Removed:\s*1/i);
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*1/);
		await expect(page.locator('[data-testid="archived-worktree-row"][data-archived-worktree-key="ready-1"]:visible')).toHaveCount(0);
	});

	test("archived worktree clean all posts server-authoritative mode and disables after zero rescan", async ({ page }) => {
		const readyOne = archivedWorktreeItem({ key: "ready-1", sessionId: "ready-1", title: "Clean all one", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" });
		const readyTwo = archivedWorktreeItem({ key: "ready-2", sessionId: "ready-2", title: "Clean all two", status: "removable", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", reasonCategory: "ready" });
		const skipped = archivedWorktreeItem({ key: "skip-live", sessionId: "skip-live", title: "Referenced by live", status: "skipped", disposition: "ineligible", reason: "referenced-by-live-session", reasonCategory: "referenced" });
		await setArchivedWorktreeScan(page, archivedWorktreeScan([readyOne, readyTwo, skipped]));
		await setArchivedWorktreeCleanup(page, cleanupResponse({ requested: 2, cleaned: 2, skipped: 0, failed: 0 }, [
			{ key: "ready-1", sessionId: "ready-1", status: "cleaned", reason: "safe-archived-session-worktree", worktreeRemoved: true, branchDeleted: true },
			{ key: "ready-2", sessionId: "ready-2", status: "cleaned", reason: "safe-archived-session-worktree", worktreeRemoved: true, branchDeleted: true },
		]), archivedWorktreeScan([skipped]));
		await renderSettings(page, "#/settings/system/maintenance");
		const card = await scanArchivedWorktrees(page);

		await page.evaluate(() => (window as any).__clearSettingsAdminFetchLog());
		await card.getByTestId("archived-worktree-clean-all").click();
		await page.getByRole("button", { name: "Clean worktrees" }).evaluate((button: HTMLElement) => button.click());
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminFetchLog().filter((e: any) => e.url === "/api/maintenance/cleanup-archived-session-worktrees").at(-1)?.body)).toEqual({ mode: "all" });
		await expect(card).toContainText(/Cleaned:\s*2|Removed:\s*2/i);
		await expect(card.getByTestId("archived-worktree-summary-ready")).toContainText(/Ready to clean:\s*0/);
		await expect(card.getByTestId("archived-worktree-empty-state")).toBeVisible();
		await expect(card.getByTestId("archived-worktree-clean-all")).toBeDisabled();
		await expect(card.getByTestId("archived-worktree-clean-selected")).toBeDisabled();
	});

	test("settings tabs, account providers, and project scope render without a gateway", async ({ page }) => {
		await renderSettings(page, "#/settings/system/general");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible();
		await expect(page.getByText("Show message timestamps")).toBeVisible();

		await page.locator("button").filter({ hasText: "Models" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/models");
		await expect(page.locator("[data-testid='models-tab']")).toBeVisible();

		await page.locator("button").filter({ hasText: "Shortcuts" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/shortcuts");

		await page.locator("button").filter({ hasText: "Color Palette" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/palette");

		await renderSettings(page, "#/settings/system/account");
		await expect(page.getByText("Anthropic OAuth")).toBeVisible();
		await expect(page.getByText("OpenAI OAuth")).toBeVisible();
		await expect(page.getByText("Google OAuth")).toBeVisible();
		await expect(page.getByText("ChatGPT subscription GPT models")).toBeVisible();
		await expect(page.getByTestId("account-status-anthropic")).toHaveText("Authenticated");
		await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Not authenticated");
		await expect(page.getByTestId("account-status-google-gemini-cli")).toHaveText("Not authenticated");

		await renderSettings(page, "#/settings/proj-1/appearance");
		await expect(page.locator("button").filter({ hasText: "Scope UI Project" })).toBeVisible();
		await expect(page.locator("button").filter({ hasText: "Appearance" })).toBeVisible();
		await expect(page.getByText("Palette").first()).toBeVisible();
	});

	test("general preferences persist across reload and reset clears the skills budget", async ({ page }) => {
		await renderSettings(page, "#/settings/system/general");
		const timestamps = page.locator("label").filter({ hasText: "Show message timestamps" }).locator("input");
		const playFinish = page.locator("[data-testid='general-play-finish-sound']");
		const budget = page.locator("[data-testid='general-skills-catalog-budget']");
		const reset = page.locator("[data-testid='general-skills-catalog-budget-reset']");

		// Show message timestamps defaults ON (only an explicit `false` opts out).
		await expect(timestamps).toBeChecked();
		await expect(playFinish).toBeChecked();
		await expect(budget).toHaveValue("16");
		await expect(reset).toBeDisabled();

		await timestamps.click();
		await expect(timestamps).not.toBeChecked();
		await expect.poll(async () => (await prefs(page)).showTimestamps).toBe(false);

		await playFinish.click();
		await expect(playFinish).not.toBeChecked();
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playAgentFinishSound)).toBe("false");
		await expect.poll(async () => (await prefs(page)).playAgentFinishSound).toBe(false);

		await budget.fill("32");
		await budget.blur();
		await expect(reset).toBeEnabled();
		await expect.poll(async () => (await prefs(page)).skillsCatalogBudget).toBe(32 * 1024);

		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/general");
		const timestampsAfter = page.locator("label").filter({ hasText: "Show message timestamps" }).locator("input");
		const playAfter = page.locator("[data-testid='general-play-finish-sound']");
		const budgetAfter = page.locator("[data-testid='general-skills-catalog-budget']");
		const resetAfter = page.locator("[data-testid='general-skills-catalog-budget-reset']");

		await expect(timestampsAfter).not.toBeChecked();
		await expect(playAfter).not.toBeChecked();
		await expect(budgetAfter).toHaveValue("32");

		await resetAfter.click();
		await expect(budgetAfter).toHaveValue("16");
		await expect(resetAfter).toBeDisabled();
		await expect.poll(async () => (await prefs(page)).skillsCatalogBudget).toBeUndefined();
	});

	test("account login buttons all disable while any OAuth flow is in flight", async ({ page }) => {
		await renderSettings(page, "#/settings/system/account");
		const loginButtons = page.locator("button").filter({ hasText: /Log in|Re-authenticate|Authenticating/ });
		await expect(loginButtons.first()).toBeVisible();
		await expect(loginButtons).toHaveCount(3);
		for (let i = 0; i < await loginButtons.count(); i++) {
			await expect(loginButtons.nth(i)).toBeEnabled();
		}

		await loginButtons.first().click();
		const disabledButtons = page.locator("button").filter({ hasText: /Log in|Re-authenticate|Authenticating/ });
		await expect(disabledButtons).toHaveCount(3);
		for (let i = 0; i < await disabledButtons.count(); i++) {
			await expect(disabledButtons.nth(i)).toBeDisabled();
		}
	});

	test("components tab edits and persists per-component config rows", async ({ page }) => {
		await renderSettings(page, "#/settings/proj-1/components");
		await expect(page.locator("[data-testid='components-tab']")).toBeVisible();

		const componentCard = page.locator("[data-testid='component-card']").first();
		await expect(componentCard).toBeVisible();
		await componentCard.locator(".wf-gate-header").click();

		const configTable = page.locator("[data-testid='component-config-app']");
		await expect(configTable).toBeVisible();
		await expect(configTable.locator("[data-testid='config-row']")).toHaveCount(0);

		await configTable.locator("[data-testid='add-config']").click();
		const row = configTable.locator("[data-testid='config-row']").first();
		await row.locator("[data-testid='config-key']").fill("qa_start_command");
		await row.locator("[data-testid='config-value']").fill("PORT=$PORT npm start");
		await page.locator("[data-testid='save-components']").click();
		await expect(page.locator("[data-testid='save-status']").filter({ hasText: "Saved." })).toBeVisible();
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminStructured("proj-1").components[0].config.qa_start_command))
			.toBe("PORT=$PORT npm start");

		await reloadFixture(page);
		await renderSettings(page, "#/settings/proj-1/components");
		const cardAfter = page.locator("[data-testid='component-card']").first();
		await cardAfter.locator(".wf-gate-header").click();
		const tableAfter = page.locator("[data-testid='component-config-app']");
		await expect(tableAfter.locator("[data-testid='config-row']")).toHaveCount(1);
		await expect(tableAfter.locator("[data-testid='config-key']")).toHaveValue("qa_start_command");
		await expect(tableAfter.locator("[data-testid='config-value']")).toHaveValue("PORT=$PORT npm start");

		await tableAfter.locator("[data-testid='delete-config']").click();
		await page.locator("[data-testid='save-components']").click();
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminStructured("proj-1").components[0].config?.qa_start_command))
			.toBeUndefined();
	});

	test("image model picker navigates, selects, persists, flags stale prefs, and clears", async ({ page }) => {
		await renderSettings(page, "#/settings/system/models");
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible();
		await expect(row).toContainText("Auto");

		await row.locator("button").first().click();
		const target = page.locator("image-model-selector [data-image-model-item]", {
			hasText: "imagen-4.0-fast-generate-001",
		}).first();
		await expect(target).toBeVisible();
		await target.click();
		await expect(row).toContainText("imagen-4.0-fast-generate-001");
		await expect.poll(async () => (await prefs(page))["default.imageModel"]).toBe("google/imagen-4.0-fast-generate-001");

		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/models");
		const rowAfter = page.locator("[data-testid='image-model-row']").first();
		await expect(rowAfter).toContainText("imagen-4.0-fast-generate-001");

		await resetFixture(page, { prefs: { "default.imageModel": "openai/this-model-does-not-exist" } });
		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/models");
		const staleRow = page.locator("[data-testid='image-model-row']").first();
		await expect(staleRow.locator("[data-testid='image-model-unavailable-badge']")).toBeVisible();
		await expect(staleRow).toContainText("this-model-does-not-exist");

		await staleRow.locator("[data-testid='image-model-clear-btn']").click();
		await expect(staleRow).toContainText("Auto");
		await expect.poll(async () => (await prefs(page))["default.imageModel"]).toBeUndefined();
	});

	test("config scope rows, origin badges, tools, and embedded workflows render from fixtures", async ({ page }) => {
		await loadRoles(page);
		await expect(page.locator("button").filter({ hasText: "System" }).first()).toBeVisible();
		await expect(page.locator("button").filter({ hasText: "Scope UI Project" }).first()).toBeVisible();
		await expect(page.locator(".config-origin-badge").first()).toBeVisible();
		await expect(page.locator(".config-origin-badge").first()).toHaveText(/builtin|server|project/);

		await page.locator("button").filter({ hasText: "Scope UI Project" }).first().click();
		await expect(page.locator(".config-origin-badge").first()).toBeVisible();
		await expect.poll(async () => {
			const log = await page.evaluate(() => (window as any).__getSettingsAdminFetchLog());
			return log.some((e: any) => e.url.includes("/api/roles?projectId=proj-1"));
		}).toBe(true);

		await loadTools(page);
		await expect(page.locator("button").filter({ hasText: "System" }).first()).toBeVisible();
		await expect(page.locator(".tool-group-header").first()).toBeVisible();
		await page.locator(".tool-group-header").first().click();
		await expect(page.locator(".tool-row").first()).toBeVisible();

		await renderSettings(page, "#/settings/proj-1/workflows");
		const tab = page.locator("[data-testid='workflows-tab']").first();
		await expect(tab).toBeVisible();
		expect(await tab.locator("button").filter({ hasText: /^System$/ }).count()).toBe(0);
	});

	test("role manager model tab renders persisted overrides and saves clear", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");
		await expect(page.locator(".roles-tab").filter({ hasText: "Prompt" })).toBeVisible();
		await page.locator("[data-testid='roles-tab-model']").click();
		await expect(page.locator("[data-testid='roles-model-tab']")).toBeVisible();
		await expect(page.locator("[data-testid='model-row']")).toBeVisible();

		await page.evaluate(({ model, thinking }) => {
			(window as any).__putSettingsAdminRole("coder", { model, thinkingLevel: thinking });
		}, { model: TEST_MODEL, thinking: TEST_THINKING });

		await reloadFixture(page);
		await loadRoles(page, "#/roles/coder");
		await page.locator("[data-testid='roles-tab-model']").click();
		const modelRow = page.locator("[data-testid='model-row']");
		await expect(modelRow.locator("button").filter({ hasText: "claude-opus-4-1" })).toBeVisible();
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			return roles.find((r: any) => r.name === "coder")?.thinkingLevel;
		}).toBe(TEST_THINKING);

		const clearBtn = modelRow.locator("[data-testid='model-clear-btn']");
		await clearBtn.click();
		await expect(clearBtn).toHaveCount(0);
		const saveBtn = page.locator("[data-testid='role-save-btn'] button").first();
		await expect(saveBtn).toBeEnabled();
		await saveBtn.click();
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			return roles.find((r: any) => r.name === "coder")?.model ?? "";
		}).toBe("");

		await page.evaluate(() => (window as any).__putSettingsAdminRole("coder", { thinkingLevel: "" }));
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			const coder = roles.find((r: any) => r.name === "coder");
			return [coder?.model ?? "", coder?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
	});
});
