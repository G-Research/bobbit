import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// Sidebar copy actions exercise the real Clipboard API on the success path.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe.configure({ mode: "serial" });

test.describe("Sidebar actions menu", () => {
	const sessionIds: string[] = [];
	const goalIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	test.afterAll(async () => {
		for (const id of sessionIds.splice(0)) await deleteSession(id).catch(() => {});
		for (const id of goalIds.splice(0)) await deleteGoal(id).catch(() => {});
	});

	function sessionRow(page: Page, sessionId: string): Locator {
		return page.locator(`[data-session-id="${sessionId}"]`).first();
	}

	function goalRow(page: Page, goalId: string): Locator {
		return page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	}

	function triggerFor(row: Locator, kind: "session" | "goal", id: string): Locator {
		return row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="${kind}"][data-sidebar-actions-id="${id}"]`).first();
	}

	function popover(page: Page): Locator {
		return page.locator("sidebar-actions-popover").first();
	}

	function menuItem(page: Page, actionId: string): Locator {
		return page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="${actionId}"]`).first();
	}

	async function expectNoPopover(page: Page): Promise<void> {
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
	}

	async function assertHamburgerAppearsOnHover(row: Locator, kind: "session" | "goal", id: string): Promise<void> {
		const page = row.page();
		const trigger = triggerFor(row, kind, id);
		await page.mouse.move(1, 1);
		await expect(trigger, `${kind} hamburger should be hidden until hover on desktop`).toBeHidden();
		await row.hover();
		await expect(trigger, `${kind} hamburger should appear on hover`).toBeVisible({ timeout: 5_000 });
	}

	async function openMenu(row: Locator, kind: "session" | "goal", id: string): Promise<void> {
		await expect(row).toBeVisible({ timeout: 10_000 });
		const trigger = triggerFor(row, kind, id);
		await row.hover();
		await expect(trigger, `${kind} hamburger should appear on hover`).toBeVisible({ timeout: 5_000 });
		await trigger.click();
		await expect(row.page().locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
	}

	async function menuLabels(page: Page): Promise<string[]> {
		return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((els) =>
			els.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
		);
	}

	async function openSession(page: Page, sessionId: string): Promise<Locator> {
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		const row = sessionRow(page, sessionId);
		await expect(row).toBeVisible({ timeout: 10_000 });
		return row;
	}

	async function ensureGoalExpanded(page: Page, goalId: string): Promise<Locator> {
		const row = goalRow(page, goalId);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await page.evaluate((id) => {
			(window as any).__bobbitExpandedGoals?.add(id);
			(window as any).__bobbitRenderApp?.();
		}, goalId);
		return row;
	}

	async function expectedHashUrl(page: Page, hash: string): Promise<string> {
		return page.evaluate((h) => `${location.origin}${location.pathname}${location.search}${h}`, hash);
	}

	test("desktop session hamburger opens the menu and direct quick actions still fire", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const row = await openSession(page, sessionId);
		await assertHamburgerAppearsOnHover(row, "session", sessionId);
		await openMenu(row, "session", sessionId);
		await expect.poll(() => menuLabels(page)).toEqual(["Modify", "Terminate", "Copy link", "Duplicate session"]);

		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		await row.hover();
		await row.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]').click();
		await expect(page.getByText("Edit Session").first()).toBeVisible({ timeout: 5_000 });
		await page.getByRole("button", { name: "Cancel" }).click();

		await row.hover();
		await row.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]').click();
		await expect(page.getByText("Terminate Session").first()).toBeVisible({ timeout: 5_000 });
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(row, "cancel keeps the session row in the sidebar").toBeVisible();
	});

	test("desktop goal hamburger opens the menu and dashboard quick action routes directly", async ({ page }) => {
		const goal = await createGoal({ title: `Sidebar goal actions ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		await openApp(page);
		const row = await ensureGoalExpanded(page, goal.id as string);
		await assertHamburgerAppearsOnHover(row, "goal", goal.id as string);
		await openMenu(row, "goal", goal.id as string);
		await expect.poll(() => menuLabels(page)).toEqual(["Re-attempt", "Archive", "Goal dashboard", "Copy link"]);

		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		await row.hover();
		await row.locator('[data-sidebar-action-id="dashboard"][data-sidebar-action-quick="true"]').click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/goal/${goal.id}`);
	});

	test("copy link menu item writes exact absolute hash URLs for session and goal", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({ title: `Sidebar copy goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		const row = await openSession(page, sessionId);
		await openMenu(row, "session", sessionId);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await expectedHashUrl(page, `#/session/${sessionId}`));

		await navigateToHash(page, "#/landing");
		const gRow = await ensureGoalExpanded(page, goal.id as string);
		await openMenu(gRow, "goal", goal.id as string);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await expectedHashUrl(page, `#/goal/${goal.id}`));
	});

	test("copy link falls back to the manual dialog with entity-specific titles", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({ title: `Sidebar fallback goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: { writeText: () => Promise.reject(new Error("forced clipboard failure")) },
			});
		});

		const row = await openSession(page, sessionId);
		await openMenu(row, "session", sessionId);
		await menuItem(page, "copy-link").click();
		await expect(page.locator("copy-link-fallback-dialog")).toContainText("Copy session link", { timeout: 5_000 });
		await expect(page.locator('[data-testid="copy-link-fallback-input"]')).toHaveValue(await expectedHashUrl(page, `#/session/${sessionId}`));
		await page.locator("copy-link-fallback-dialog").getByText("Close", { exact: true }).click();
		await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0, { timeout: 5_000 });

		await navigateToHash(page, "#/landing");
		const gRow = await ensureGoalExpanded(page, goal.id as string);
		await openMenu(gRow, "goal", goal.id as string);
		await menuItem(page, "copy-link").click();
		await expect(page.locator("copy-link-fallback-dialog")).toContainText("Copy goal link", { timeout: 5_000 });
		await expect(page.locator('[data-testid="copy-link-fallback-input"]')).toHaveValue(await expectedHashUrl(page, `#/goal/${goal.id}`));
	});

	test("dismissal closes on outside click, Escape, route change, and item selection", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const row = await openSession(page, sessionId);

		await openMenu(row, "session", sessionId);
		await page.mouse.click(5, 5);
		await expectNoPopover(page);

		await openMenu(row, "session", sessionId);
		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		await openMenu(row, "session", sessionId);
		await page.evaluate(() => { window.location.hash = "#/settings"; });
		await expectNoPopover(page);

		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await openMenu(row, "session", sessionId);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
	});

	test("duplicate session menu action calls the endpoint, navigates, and preserves goal context", async ({ page }) => {
		const goal = await createGoal({ title: `Duplicate context goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);
		const sourceId = await createSession({ goalId: goal.id as string });
		sessionIds.push(sourceId);
		await waitForSessionStatus(sourceId, "idle");
		await apiFetch(`/api/sessions/${sourceId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "Source context session" }),
		});

		await openSession(page, sourceId);
		await ensureGoalExpanded(page, goal.id as string);
		const row = sessionRow(page, sourceId);
		await openMenu(row, "session", sourceId);

		const responsePromise = page.waitForResponse((resp) =>
			resp.url().includes(`/api/sessions/${sourceId}/duplicate`) && resp.request().method() === "POST",
		);
		await menuItem(page, "duplicate").click();
		const response = await responsePromise;
		expect(response.status()).toBe(201);
		const body = await response.json();
		expect(body).toMatchObject({ goalId: goal.id, projectId: goal.projectId });
		expect(body.id).toBeTruthy();
		expect(body.id).not.toBe(sourceId);
		sessionIds.push(body.id);

		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toBe(`#/session/${body.id}`);
		const dupResp = await apiFetch(`/api/sessions/${body.id}`);
		expect(dupResp.status).toBe(200);
		const dup = await dupResp.json();
		expect(dup).toMatchObject({ goalId: goal.id, projectId: goal.projectId, title: "Copy of Source context session" });
	});

	test("Open on GitHub uses PR URLs, branch fallback URLs, and stays hidden without a GitHub link", async ({ page, gateway, context }) => {
		const prGoal = await createGoal({ title: `GitHub PR goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const branchGoal = await createGoal({ title: `GitHub branch goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const noRemoteGoal = await createGoal({ title: `GitHub hidden goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(prGoal.id as string, branchGoal.id as string, noRemoteGoal.id as string);

		gateway.sessionManager.prStatusStore.set(prGoal.id, { state: "OPEN", url: "https://github.com/acme/widget/pull/123" });
		const repo = gitCwd();
		try { execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: "ignore" }); } catch {}
		execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo, stdio: "pipe" });
		gateway.sessionManager.getGoalStoreForProject(branchGoal.projectId).update(branchGoal.id, { branch: "feature/sidebar-actions", repoPath: repo, cwd: repo });
		gateway.sessionManager.getGoalStoreForProject(noRemoteGoal.projectId).update(noRemoteGoal.id, { branch: "feature/no-remote", repoPath: nonGitCwd(), cwd: nonGitCwd() });

		await openApp(page);
		await page.evaluate(() => {
			(window as any).__sidebarOpenedUrls = [];
			window.open = ((url: string | URL | undefined) => {
				(window as any).__sidebarOpenedUrls.push(String(url));
				return { opener: null } as any;
			}) as any;
		});

		for (const [goalId, expected] of [
			[prGoal.id as string, "https://github.com/acme/widget/pull/123"],
			[branchGoal.id as string, "https://github.com/acme/widget/tree/feature%2Fsidebar-actions"],
		] as const) {
			const row = await ensureGoalExpanded(page, goalId);
			await openMenu(row, "goal", goalId);
			await expect(menuItem(page, "open-github")).toBeVisible({ timeout: 10_000 });
			await menuItem(page, "open-github").click();
			await expectNoPopover(page);
			await expect.poll(() => page.evaluate(() => (window as any).__sidebarOpenedUrls.at(-1))).toBe(expected);
		}

		const row = await ensureGoalExpanded(page, noRemoteGoal.id as string);
		await openMenu(row, "goal", noRemoteGoal.id as string);
		await expect(menuItem(page, "open-github")).toHaveCount(0, { timeout: 2_000 });
		await page.keyboard.press("Escape");
		await expectNoPopover(page);
		await context.clearCookies(); // keeps the test from relying on a real external popup side effect.
	});

	test("reduced-motion opens and closes without FLIP/slide animations", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await page.emulateMedia({ reducedMotion: "reduce" });
		const row = await openSession(page, sessionId);
		await page.evaluate(() => {
			const original = Element.prototype.animate;
			(window as any).__sidebarAnimateCalls = 0;
			Element.prototype.animate = function(...args: any[]) {
				(window as any).__sidebarAnimateCalls += 1;
				return original.apply(this, args as any);
			};
		});

		await openMenu(row, "session", sessionId);
		await expect(menuItem(page, "copy-link")).toBeVisible();
		await page.keyboard.press("Escape");
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => (window as any).__sidebarAnimateCalls)).toBe(0);
	});

	test("mobile v1 hides hamburger while keeping existing inline quick actions visible", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 820 });
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({ title: `Mobile sidebar actions ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		await openApp(page);
		const sRow = sessionRow(page, sessionId);
		await expect(sRow).toBeVisible({ timeout: 10_000 });
		await expect(triggerFor(sRow, "session", sessionId)).toHaveCount(0);
		await expect(sRow.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(sRow.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(sRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);

		const gRow = await ensureGoalExpanded(page, goal.id as string);
		await expect(triggerFor(gRow, "goal", goal.id as string)).toHaveCount(0);
		await expect(gRow.locator('[data-sidebar-action-id="reattempt"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(gRow.locator('[data-sidebar-action-id="archive"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(gRow.locator('[data-sidebar-action-id="dashboard"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(gRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);
	});
});
