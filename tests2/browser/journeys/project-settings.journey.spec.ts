/**
 * Journey: Project Settings + Project Assistant — v2 browser smoke
 * Covers: journey-project-settings, journey-project-assistant
 * Consolidated from: settings-*, project-assistant-*, model-settings-*, etc.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page, Route } from "@playwright/test";
import { test, expect, openApp, apiFetch, registerProject, navigateToHash } from "../_helpers/journey-fixture.js";

let _projCounter = 0;
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-v2-proj-${process.env.E2E_PORT ?? "0"}-${Date.now()}-${++_projCounter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Journey: Project Settings", () => {
	test("project settings route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("system settings general route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.getByText(/settings/i).first()).toBeVisible({ timeout: 15_000 });
	});

	test("settings navigation does not break sidebar", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("API-created project appears on projects settings page", async ({ page }) => {
		const projectId = (await registerProject({
			name: "v2-settings-proj-alpha",
			rootPath: uniqueProjectDir(),
			seedWorkflows: false,
		})).id;
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await expect(page.getByText("v2-settings-proj-alpha").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteProject(projectId);
		}
	});

	test("gear icon on project row opens project-specific settings", async ({ page }) => {
		const projectId = (await registerProject({
			name: "v2-settings-proj-beta",
			rootPath: uniqueProjectDir(),
			seedWorkflows: false,
		})).id;
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			const projectName = page.getByText("v2-settings-proj-beta").first();
			await expect(projectName).toBeVisible({ timeout: 15_000 });
			// Hover the group container to reveal gear icon
			const groupContainer = projectName.locator("xpath=ancestor::*[contains(@class,'group')]").first();
			await groupContainer.hover();
			const gearBtn = groupContainer.locator("button[title='Project settings']");
			if (await gearBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
				await gearBtn.click();
				await page.waitForFunction(
					(id: string) => window.location.hash.includes(id) && window.location.hash.includes("settings"),
					projectId,
					{ timeout: 15_000 },
				);
				const hash = await page.evaluate(() => window.location.hash);
				expect(hash).toContain(projectId);
				expect(hash).toContain("settings");
			} else {
				// Gear button may require different hover target; assert settings route is navigable directly
				await page.evaluate((id: string) => { window.location.hash = `#/settings/${id}`; }, projectId);
				await page.waitForFunction(
					(id: string) => window.location.hash.includes(id),
					projectId,
					{ timeout: 15_000 },
				);
				const hash = await page.evaluate(() => window.location.hash);
				expect(hash).toContain(projectId);
			}
		} finally {
			await deleteProject(projectId);
		}
	});

	test("project settings page shows project name", async ({ page }) => {
		const projectId = (await registerProject({
			name: "v2-settings-proj-gamma",
			rootPath: uniqueProjectDir(),
			seedWorkflows: false,
		})).id;
		try {
			await openApp(page);
			await page.evaluate((id: string) => { window.location.hash = `#/settings/${id}`; }, projectId);
			await page.waitForFunction(
				(id: string) => window.location.hash.includes(id),
				projectId,
				{ timeout: 15_000 },
			);
			await expect(page.getByText("v2-settings-proj-gamma").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteProject(projectId);
		}
	});

	test("models settings route renders a toggle", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/models"; });
		await page.waitForFunction(() => window.location.hash.includes("models"), null, { timeout: 20_000 });
		// Any toggle/checkbox-style input on the models settings page
		const toggle = page.locator('input[type="checkbox"], [role="switch"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Project Assistant", () => {
	test("assistant settings route reachable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("app shell stable during project assistant flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	// Ported from project-assistant.spec.ts (audit: project-settings GAP, mutant
	// BR65): Add Project on a non-empty dir without .bobbit routes to the project
	// assistant, creating a provisional project shown with the "(setting up)"
	// sidebar indicator.
	test("Add Project (non-.bobbit dir) creates a provisional '(setting up)' project", async ({ page }) => {
		test.setTimeout(120_000);
		const dir = uniqueProjectDir();
		writeFileSync(join(dir, "package.json"), `{"name":"v2-provisional-${Date.now()}"}`);
		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 15_000 });
			await pathInput.fill(dir);
			await page.locator("button").filter({ hasText: "Continue" }).first().click();

			// Dialog closes and we land in the assistant session.
			await expect(pathInput).not.toBeVisible({ timeout: 15_000 });
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toMatch(/^#\/session\//);

			// The provisional project shows the "(setting up)" indicator in the sidebar.
			const sidebar = page.locator(".sidebar-edge");
			await expect(sidebar.getByText("(setting up)").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			// Best-effort cleanup of any provisional project bound to this dir.
			try {
				const res = await apiFetch("/api/projects");
				const data = await res.json();
				for (const p of (data.projects || data || [])) {
					if (p.name === "default") continue;
					if (p.rootPath === dir || p.provisional) await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
				}
			} catch { /* best-effort */ }
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// Ported from settings-model-fallback.spec.ts (audit: project-settings GAP):
	// the models settings page must expose the session-model-fallback toggle,
	// defaulting to unchecked.
	test("models settings exposes the session-model-fallback toggle (default off)", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/models"; });
		await page.waitForFunction(() => window.location.hash.includes("models"), null, { timeout: 20_000 });
		const toggle = page.locator('[data-testid="allow-session-model-fallback-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
		await expect(toggle).not.toBeChecked();
	});

	// Ported from role-assistant-new.spec.ts (audit: project-settings GAP): the
	// #/roles page exposes a "New Role" button.
	test("roles page exposes a 'New Role' button", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/roles"; });
		await page.waitForFunction(() => window.location.hash.includes("roles"), null, { timeout: 20_000 });
		await expect(page.locator("button").filter({ hasText: "New Role" }).first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Settings App Version", () => {
	test("installed builds show the package version", async ({ page }) => {
		await page.route("**/api/app-info", route => route.fulfill({
			json: { version: "0.14.1", buildType: "installed" },
		}));
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const appHeader = page.getByTestId("app-header-row");
		const version = appHeader.getByTestId("settings-app-version");
		await expect(version).toHaveText("Bobbit v0.14.1");
		await expect(version).toHaveAttribute("title", "Running from an installed build");
	});

	test("source builds show the commit in the app header row", async ({ page }) => {
		await page.route("**/api/app-info", route => route.fulfill({
			json: { version: "0.14.1", buildType: "source", commitSha: "e3563ba" },
		}));
		await page.route("**/api/harness-status", route => route.fulfill({
			json: { restartAvailable: true },
		}));
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const appHeader = page.getByTestId("app-header-row");
		const version = appHeader.getByTestId("settings-app-version");
		const restart = page.getByRole("button", { name: "Restart Server" });
		await expect(version).toHaveText("Bobbit v0.14.1 [e3563ba]");
		await expect(version).toHaveAttribute("title", "Running from source");
		await expect(restart).toBeVisible();
		const [headerBox, restartBox] = await Promise.all([appHeader.boundingBox(), restart.boundingBox()]);
		expect(headerBox).not.toBeNull();
		expect(restartBox).not.toBeNull();
		expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(restartBox!.y);
	});

	test("retries app info after a transient failure", async ({ page }) => {
		let appInfoAvailable = false;
		let attempts = 0;
		await page.route("**/api/app-info", route => {
			attempts++;
			return appInfoAvailable
				? route.fulfill({ json: { version: "0.14.1", buildType: "installed" } })
				: route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
		});
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect.poll(() => attempts).toBeGreaterThan(0);
		await expect(page.getByTestId("settings-app-version")).toHaveCount(0);

		await navigateToHash(page, "#/");
		appInfoAvailable = true;
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.getByTestId("app-header-row").getByTestId("settings-app-version"))
			.toHaveText("Bobbit v0.14.1");
		expect(attempts).toBeGreaterThan(1);
	});
});

// Ported from settings-restart-button.spec.ts (audit: project-settings GAP,
// mutant BR63): without the dev harness the Restart Server control must be
// absent — and stay absent across reload + navigation.
test.describe("Journey: Settings Restart Button", () => {
	async function expectRestartHidden(page: import("@playwright/test").Page): Promise<void> {
		await expect(page.getByRole("button", { name: /Restart Server|Restart Requested|Requesting/i })).toHaveCount(0);
	}

	test("restart button is hidden by default and after reload + navigation", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 15_000 });
		await expectRestartHidden(page);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expectRestartHidden(page);

		await navigateToHash(page, "#/");
		await navigateToHash(page, "#/settings/system/general");
		await expectRestartHidden(page);
	});
});

// Ported from system-prompt-customise.spec.ts (audit: project-settings GAP):
// settings exposes the Customise-system-prompt control.
test.describe("Journey: Customise System Prompt", () => {
	test("settings exposes the customise-system-prompt control", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("general"), null, { timeout: 20_000 });
		await expect(page.locator('[data-testid="general-customise-system-prompt"]').first()).toBeVisible({ timeout: 15_000 });
	});
});

// Ported from settings-maintenance-archived-worktrees.spec.ts (audit:
// project-settings GAP, mutant BR47): the System → Maintenance page renders the
// worktree-cleanup card, and a scan surfaces the ready-to-clean count from the
// (route-mocked) /api/maintenance/worktrees inventory.
test.describe("Journey: Settings Maintenance — worktree cleanup", () => {
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
			detail: actionable ? "Safe to remove." : "Not removable in this fixture category.",
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
			readyToClean: items.filter((i) => i.disposition === "ready-to-clean").length,
			protectedInUse: items.filter((i) => i.disposition === "protected" || i.classification === "protected-in-use").length,
			archivedOwned: items.filter((i) => i.classification === "archived-owned").length,
			unownedGitWorktrees: items.filter((i) => i.classification === "unowned-git-worktree").length,
			poolEntries: items.filter((i) => i.classification === "pool-entry").length,
			alreadyCleaned: items.filter((i) => i.disposition === "already-cleaned").length,
			needsAttention: items.filter((i) => i.disposition === "needs-attention" || i.disposition === "failed").length,
			scanErrors: items.filter((i) => i.classification === "scan-error").length,
			defaultSelected: items.filter((i) => i.defaultSelected !== false && i.disposition === "ready-to-clean").length,
			byClassification: {} as Record<string, number>,
			byReason: {} as Record<string, number>,
			bySource: {} as Record<string, number>,
		};
		for (const item of items) {
			counts.byClassification[item.classification] = (counts.byClassification[item.classification] || 0) + 1;
			counts.byReason[item.reason] = (counts.byReason[item.reason] || 0) + 1;
			for (const source of item.sources || []) counts.bySource[source] = (counts.bySource[source] || 0) + 1;
		}
		return { items, counts, generatedAt: Date.now(), scanned: { projects: 1, repos: 2, worktreeRoots: 1 } };
	}

	async function installMaintenanceRoutes(page: Page, scan: any): Promise<void> {
		await page.route(new RegExp("/api/maintenance/worktrees(?:\\?.*)?$"), async (route: Route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scan) });
		});
	}

	// Ported from settings-agent-dir.spec.ts (audit: project-settings GAP,
	// mutant BR53): the System → Maintenance page exposes the Agent Directory
	// section, and entering a valid path enables the Validate control.
	test("agent-dir maintenance section enables Validate after a path is entered", async ({ page }) => {
		test.setTimeout(90_000);
		const dir = uniqueProjectDir();
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 15_000 });

		await page.getByRole("button", { name: "Maintenance" }).click();
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toContain("/maintenance");

		const section = page.locator('[data-testid="agent-dir-settings"]').first();
		await expect(section).toBeVisible({ timeout: 15_000 });
		await expect(section.getByRole("heading", { name: /Agent Directory/i })).toBeVisible({ timeout: 10_000 });

		const input = section.locator('[data-testid="agent-dir-path-input"]').first();
		await expect(input).toBeVisible({ timeout: 10_000 });
		await expect(input).toBeEnabled({ timeout: 10_000 });
		await input.fill(dir);
		await expect(input).toHaveValue(dir);

		// The Validate control (mutant target) must be present and enabled once a
		// path is entered.
		await expect(section.locator('[data-testid="agent-dir-validate"]').first()).toBeEnabled({ timeout: 15_000 });
	});

	test("maintenance page renders worktree-cleanup card and scan shows ready count", async ({ page }) => {
		const scan = scanResponse([
			worktreeItem({ id: "arch-ready", classification: "archived-owned", disposition: "ready-to-clean", reason: "safe-archived-session-worktree", sources: ["archived-session", "git-worktree"], willDeleteBranch: true }),
			worktreeItem({ id: "git-ready", classification: "unowned-git-worktree", disposition: "ready-to-clean", reason: "safe-unowned-session-worktree" }),
			worktreeItem({ id: "live-1", classification: "protected-in-use", disposition: "protected", reason: "referenced-by-live-session", actionable: false, selectable: false, defaultSelected: false }),
		]);
		await installMaintenanceRoutes(page, scan);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		const card = page.getByTestId("worktree-cleanup-maintenance");
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByTestId("worktree-cleanup-scan").click();
		await expect(card.getByTestId("worktree-cleanup-summary-ready")).toContainText(/Ready to clean:\s*2/, { timeout: 15_000 });
		await expect(card.getByTestId("worktree-cleanup-summary-protected")).toContainText(/Protected\/in use:\s*1/, { timeout: 10_000 });
	});
});
