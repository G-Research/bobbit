import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
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

	function actionStrip(row: Locator): Locator {
		return row.locator(".sidebar-actions").first();
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
		await expect(actionStrip(row), `${kind} action strip should be visually hidden until hover on desktop`).toHaveCSS("opacity", "0");
		await expect(actionStrip(row), `${kind} action strip should not accept pointer clicks until hover on desktop`).toHaveCSS("pointer-events", "none");
		await row.hover();
		await expect(actionStrip(row), `${kind} action strip should become visible on hover`).toHaveCSS("opacity", "1", { timeout: 5_000 });
		await expect(trigger, `${kind} hamburger should appear on hover`).toBeVisible({ timeout: 5_000 });
	}

	async function openMenuFromKeyboard(row: Locator, kind: "session" | "goal", id: string, lastQuickActionId: string): Promise<void> {
		const page = row.page();
		const trigger = triggerFor(row, kind, id);
		await page.mouse.move(1, 1);
		await expect(actionStrip(row), `${kind} action strip starts visually hidden before keyboard focus`).toHaveCSS("opacity", "0");
		const lastQuickAction = row.locator(`[data-sidebar-action-id="${lastQuickActionId}"][data-sidebar-action-quick="true"]`).first();
		await lastQuickAction.focus();
		await expect(lastQuickAction, `${kind} quick action should be focusable even before hover`).toBeFocused();
		await expect(actionStrip(row), `${kind} action strip should become visible on focus-within`).toHaveCSS("opacity", "1", { timeout: 5_000 });
		await page.keyboard.press("Tab");
		await expect(trigger, `${kind} hamburger should be reachable from the quick actions with Tab`).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
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
		await openMenuFromKeyboard(row, "session", sessionId, "terminate");
		// Popover lists quick actions in REVERSE strip order (right-most first),
		// then the menu-only actions in their declared order.
		await expect.poll(() => menuLabels(page)).toEqual(["Terminate", "Modify", "Copy link", "Duplicate session"]);
		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		await openMenu(row, "session", sessionId);
		await expect.poll(() => menuLabels(page)).toEqual(["Terminate", "Modify", "Copy link", "Duplicate session"]);
		await expect(triggerFor(row, "session", sessionId), "hamburger trigger stays visible while the menu is open").toBeVisible();

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

	test("idle activity-time stays flush right; the action strip reserves no layout width", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const row = await openSession(page, sessionId);

		await page.mouse.move(1, 1); // ensure the row is not hovered
		const strip = actionStrip(row);
		// The strip must be absolutely positioned so it does not push the idle
		// activity-time leftward (regression guard for the hover-strip layout).
		await expect(strip).toHaveCSS("position", "absolute");
		await expect(strip).toHaveCSS("opacity", "0");

		const idleTime = row.locator('span[class*="group-hover:hidden"]').first();
		await expect(idleTime).toBeVisible();
		const gap = await idleTime.evaluate((el) => {
			const rowRoot = el.closest("[data-sidebar-actions-row-root]") as HTMLElement;
			return rowRoot.getBoundingClientRect().right - el.getBoundingClientRect().right;
		});
		// Time sits flush against the row's right padding rather than being shoved
		// left by an always-laid-out action strip.
		expect(Math.abs(gap)).toBeLessThanOrEqual(8);
	});

	test("desktop goal hamburger opens the menu and dashboard quick action routes directly", async ({ page }) => {
		const goal = await createGoal({ title: `Sidebar goal actions ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		await openApp(page);
		const row = await ensureGoalExpanded(page, goal.id as string);
		await assertHamburgerAppearsOnHover(row, "goal", goal.id as string);
		// Re-attempt is popover-only: it must NOT render as a hover quick-action button.
		await row.hover();
		await expect(row.locator('[data-sidebar-action-id="reattempt"][data-sidebar-action-quick="true"]'), "re-attempt is not a hover quick action").toHaveCount(0);
		await openMenuFromKeyboard(row, "goal", goal.id as string, "dashboard");
		await expect.poll(() => menuLabels(page)).toEqual(["Goal dashboard", "Archive", "Re-attempt", "Copy link"]);
		await expect(menuItem(page, "reattempt"), "re-attempt still appears in the popover menu").toBeVisible();
		await expect(triggerFor(row, "goal", goal.id as string), "hamburger trigger stays visible while the menu is open").toBeVisible();

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

	test("dismissal closes on outside click, Escape, route change, item selection, repeated toggle, and direct menu switch", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({ title: `Sidebar switch cleanup ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);
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

		await openMenu(row, "session", sessionId);
		await triggerFor(row, "session", sessionId).click();
		await expectNoPopover(page);

		await openMenu(row, "session", sessionId);
		const goalMenuRow = await ensureGoalExpanded(page, goal.id as string);
		await goalMenuRow.hover();
		await triggerFor(goalMenuRow, "goal", goal.id as string).click();
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(1, { timeout: 5_000 });
		await expect(menuItem(page, "dashboard")).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Escape");
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

	test("Open on GitHub mirrors the goal-row PR badge: coloured PR icon + url only when the badge shows", async ({ page }) => {
		const prGoal = await createGoal({ title: `GitHub PR goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const gatedGoal = await createGoal({ title: `GitHub gated goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const noPrGoal = await createGoal({ title: `GitHub no-PR goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(prGoal.id as string, gatedGoal.id as string, noPrGoal.id as string);

		const PR_URL = "https://github.com/acme/widget/pull/123";

		// "Open on GitHub" must mirror the goal-row PR badge exactly. The badge is
		// derived from the same client caches `renderGoalBadge` reads: a PR entry,
		// plus — for workflow goals — a fully-passed gate summary. Two async refresh
		// paths race the menu-open and would otherwise clobber the injected caches:
		//   • refreshPrStatusCache() deletes a PR entry on a 404 (api.ts).
		//   • refreshGateStatusCache() overwrites the gate summary with the real
		//     (un-signed-off → passed:0) status, suppressing the prGoal badge.
		// Pin BOTH backing endpoints per-goal so any refresh re-AFFIRMS the desired
		// state instead of clobbering it. This makes the open-github item — which
		// reads the very same caches — deterministic regardless of refresh timing.
		const prById: Record<string, { status: number; body: unknown }> = {
			[prGoal.id as string]: { status: 200, body: { state: "OPEN", url: PR_URL } },
			[gatedGoal.id as string]: { status: 200, body: { state: "OPEN", url: PR_URL } },
			[noPrGoal.id as string]: { status: 404, body: { error: "no PR for goal" } },
		};
		const gateById: Record<string, unknown> = {
			[prGoal.id as string]: { passed: 1, total: 1 }, // all gates passed → badge shown
			[gatedGoal.id as string]: { passed: 0, total: 1 }, // gates pending → badge suppressed
			[noPrGoal.id as string]: { passed: 1, total: 1 }, // gates passed, but no PR → hidden
		};
		const goalIdFromUrl = (url: string) => new URL(url).pathname.split("/")[3];
		await page.route(/\/api\/goals\/[^/]+\/pr-status(\?|$)/, async (route) => {
			const entry = prById[goalIdFromUrl(route.request().url())];
			if (!entry) return route.continue();
			await route.fulfill({ status: entry.status, contentType: "application/json", body: JSON.stringify(entry.body) });
		});
		await page.route(/\/api\/goals\/[^/]+\/gates\?[^/]*view=summary/, async (route) => {
			const summary = gateById[goalIdFromUrl(route.request().url())];
			if (!summary) return route.continue();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
		});

		await openApp(page);
		await page.evaluate(() => {
			(window as any).__sidebarOpenedUrls = [];
			window.open = ((url: string | URL | undefined) => {
				(window as any).__sidebarOpenedUrls.push(String(url));
				return { opener: null } as any;
			}) as any;
		});

		// Drive the same client caches directly (the established cross-surface
		// pattern) so the contract is exercised without standing up real PRs or
		// gate verification. Also stop session polling — its piggybacked PR/gate
		// refreshes are the loudest clobber source (same approach as
		// notification-policy.spec.ts). Re-applied before each open so a prior
		// in-flight async refresh can never win the race.
		const injectBadgeCaches = () => page.evaluate(({ prId, gatedId, noPrId, url }) => {
			const state: any = (window as any).bobbitState ?? (window as any).__bobbitState;
			if (state?.sessionPollTimer) { clearInterval(state.sessionPollTimer); state.sessionPollTimer = null; }
			const passed = { passed: 1, total: 1, verifying: false, verifyingCount: 0, awaitingSignoffCount: 0, awaitingHumanSignoff: false, runningGateIds: [], gates: [] };
			const pending = { ...passed, passed: 0 };
			// prGoal: PR present + all gates passed → badge (and menu item) shown.
			state.gateStatusCache.set(prId, passed);
			state.prStatusCache.set(prId, { state: "OPEN", url });
			// gatedGoal: PR present but gates NOT all passed → badge suppressed.
			state.gateStatusCache.set(gatedId, pending);
			state.prStatusCache.set(gatedId, { state: "OPEN", url });
			// noPrGoal: gates passed but no PR → no badge.
			state.gateStatusCache.set(noPrId, passed);
			state.prStatusCache.delete(noPrId);
			(window as any).__bobbitRenderApp?.();
		}, { prId: prGoal.id, gatedId: gatedGoal.id, noPrId: noPrGoal.id, url: PR_URL });
		await injectBadgeCaches();

		// PR goal: visible, uses the SAME coloured PR/merge SVG as the goal row
		// (OPEN with no review decision → green #6bc485), and opens the PR url.
		const prRow = await ensureGoalExpanded(page, prGoal.id as string);
		// Gate on the goal ROW's PR badge actually rendering before opening the menu.
		// The badge (`<a href="<PR_URL>">` from renderGoalBadge) and the open-github
		// menu item are both derived from the now-pinned caches; once the badge is
		// visible the menu item is guaranteed present.
		await expect(prRow.locator(`a[href="${PR_URL}"]`), "prGoal row PR badge should render before opening the menu").toBeVisible({ timeout: 10_000 });
		await injectBadgeCaches();
		await openMenu(prRow, "goal", prGoal.id as string);
		const ghItem = menuItem(page, "open-github");
		await expect(ghItem).toBeVisible({ timeout: 10_000 });
		expect(await ghItem.locator("svg").first().getAttribute("stroke"), "open-github uses the coloured PR icon, not the lucide Github icon").toBe("#6bc485");
		await ghItem.click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => (window as any).__sidebarOpenedUrls.at(-1))).toBe(PR_URL);

		// Workflow goal with a PR but gates not fully passed: badge hidden → item hidden.
		await injectBadgeCaches();
		const gatedRow = await ensureGoalExpanded(page, gatedGoal.id as string);
		await openMenu(gatedRow, "goal", gatedGoal.id as string);
		await expect(menuItem(page, "open-github")).toHaveCount(0, { timeout: 2_000 });
		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		// Goal with no PR at all: hidden.
		await injectBadgeCaches();
		const noPrRow = await ensureGoalExpanded(page, noPrGoal.id as string);
		await openMenu(noPrRow, "goal", noPrGoal.id as string);
		await expect(menuItem(page, "open-github")).toHaveCount(0, { timeout: 2_000 });
		await page.keyboard.press("Escape");
		await expectNoPopover(page);
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
		await expect(gRow.locator('[data-sidebar-action-id="reattempt"]'), "re-attempt is popover-only and not an inline quick action").toHaveCount(0);
		await expect(gRow.locator('[data-sidebar-action-id="archive"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(gRow.locator('[data-sidebar-action-id="dashboard"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(gRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);
	});
});
