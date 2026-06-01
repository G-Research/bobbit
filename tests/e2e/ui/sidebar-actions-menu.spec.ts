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
		// then the menu-only actions in their declared order. The Fork row carries
		// a trailing "New worktree" checkbox, but only its `[role=menuitem]` label
		// counts here (the checkbox is a sibling `[role=menuitemcheckbox]`).
		await expect.poll(() => menuLabels(page)).toEqual(["Terminate", "Modify", "Copy link", "Fork"]);
		await page.keyboard.press("Escape");
		await expectNoPopover(page);

		await openMenu(row, "session", sessionId);
		await expect.poll(() => menuLabels(page)).toEqual(["Terminate", "Modify", "Copy link", "Fork"]);
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
		await expect(page.locator('[data-testid="header-toast"]'), "session copy flashes the header toast").toHaveText("Link copied", { timeout: 5_000 });

		await navigateToHash(page, "#/landing");
		const gRow = await ensureGoalExpanded(page, goal.id as string);
		await openMenu(gRow, "goal", goal.id as string);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await expectedHashUrl(page, `#/goal/${goal.id}`));
		await expect(page.locator('[data-testid="header-toast"]'), "goal copy flashes the toast even with no active session").toHaveText("Link copied", { timeout: 5_000 });
	});

	test("copy link falls back to legacy copy + toast (no modal) when the Clipboard API is blocked", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const goal = await createGoal({ title: `Sidebar fallback goal ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		goalIds.push(goal.id as string);

		// Simulate an insecure context (http:// over NordLynx): the async
		// Clipboard API rejects, so copySidebarLink must use the legacy
		// execCommand("copy") path and still flash the toast — never a modal.
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: { writeText: () => Promise.reject(new Error("forced clipboard failure")) },
			});
			(window as any).__execCopies = [];
			const orig = document.execCommand?.bind(document);
			document.execCommand = ((cmd: string, ...rest: unknown[]) => {
				if (cmd === "copy") {
					const el = document.activeElement as HTMLTextAreaElement | null;
					const text = el && typeof el.value === "string" ? el.value : (window.getSelection?.()?.toString() ?? "");
					(window as any).__execCopies.push(text);
					return true;
				}
				return orig ? (orig as any)(cmd, ...rest) : false;
			}) as typeof document.execCommand;
		});

		const row = await openSession(page, sessionId);
		const sessionUrl = await expectedHashUrl(page, `#/session/${sessionId}`);
		await openMenu(row, "session", sessionId);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
		// No modal — the fallback dialog must never appear.
		await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0, { timeout: 5_000 });
		// The header toast flashes "Link copied".
		await expect(page.locator('[data-testid="header-toast"]')).toHaveText("Link copied", { timeout: 5_000 });
		// The link was still copied via the legacy execCommand path.
		await expect.poll(() => page.evaluate(() => (window as any).__execCopies)).toContain(sessionUrl);

		const goalUrl = await expectedHashUrl(page, `#/goal/${goal.id}`);
		await navigateToHash(page, "#/landing");
		const gRow = await ensureGoalExpanded(page, goal.id as string);
		await openMenu(gRow, "goal", goal.id as string);
		await menuItem(page, "copy-link").click();
		await expectNoPopover(page);
		await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0, { timeout: 5_000 });
		await expect(page.locator('[data-testid="header-toast"]')).toHaveText("Link copied", { timeout: 5_000 });
		await expect.poll(() => page.evaluate(() => (window as any).__execCopies)).toContain(goalUrl);
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

	test("fork menu action toggles the New worktree checkbox without firing, then forks and navigates", async ({ page }) => {
		const sourceId = await createSession();
		sessionIds.push(sourceId);
		await waitForSessionStatus(sourceId, "idle");
		const navTarget = "11111111-2222-3333-4444-555555555555";

		// Mock the fork endpoint so the test never spins up a real worktree/clone.
		// Capture every request body so we can assert the checkbox state is read
		// at fork time (and that toggling alone never POSTs).
		await page.route(`**/api/sessions/${sourceId}/fork`, async (route) => {
			const post = route.request().postDataJSON?.() ?? {};
			await page.evaluate((b) => { (window as any).__forkBodies = [...((window as any).__forkBodies || []), b]; }, post);
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({ id: navTarget, cwd: "/tmp/fork", status: "idle", title: "Fork: Source", projectId: "p", goalId: undefined }),
			});
		});

		const row = await openSession(page, sourceId);
		await page.evaluate(() => { (window as any).__forkBodies = []; });
		await openMenu(row, "session", sourceId);

		const forkItem = menuItem(page, "fork");
		await expect(forkItem).toBeVisible();
		const checkbox = page.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]').first();
		await expect(checkbox).toBeVisible();
		// Default: checked (new worktree on).
		await expect(checkbox).toHaveAttribute("aria-checked", "true");

		// Clicking the checkbox toggles it WITHOUT firing fork or closing the menu.
		await checkbox.click();
		await expect(checkbox).toHaveAttribute("aria-checked", "false");
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
		expect(await page.evaluate(() => (window as any).__forkBodies.length)).toBe(0);

		// Toggle back on so the fork posts newWorktree:true.
		await checkbox.click();
		await expect(checkbox).toHaveAttribute("aria-checked", "true");
		expect(await page.evaluate(() => (window as any).__forkBodies.length)).toBe(0);

		// Clicking the rest of the row forks using the current checkbox state.
		await forkItem.click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => (window as any).__forkBodies), { timeout: 10_000 }).toEqual([{ newWorktree: true }]);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toBe(`#/session/${navTarget}`);
	});

	test("fork posts newWorktree:false when the New worktree checkbox is unchecked", async ({ page }) => {
		const sourceId = await createSession();
		sessionIds.push(sourceId);
		await waitForSessionStatus(sourceId, "idle");
		const navTarget = "66666666-7777-8888-9999-aaaaaaaaaaaa";

		await page.route(`**/api/sessions/${sourceId}/fork`, async (route) => {
			const post = route.request().postDataJSON?.() ?? {};
			await page.evaluate((b) => { (window as any).__forkBodies = [...((window as any).__forkBodies || []), b]; }, post);
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({ id: navTarget, cwd: "/tmp/fork", status: "idle", title: "Fork: Source", projectId: "p" }),
			});
		});

		const row = await openSession(page, sourceId);
		await page.evaluate(() => { (window as any).__forkBodies = []; });
		await openMenu(row, "session", sourceId);

		const checkbox = page.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]').first();
		await checkbox.click();
		await expect(checkbox).toHaveAttribute("aria-checked", "false");
		await menuItem(page, "fork").click();
		await expectNoPopover(page);
		await expect.poll(() => page.evaluate(() => (window as any).__forkBodies), { timeout: 10_000 }).toEqual([{ newWorktree: false }]);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toBe(`#/session/${navTarget}`);
	});

	test("the New worktree checkbox is a keyboard roving-focus stop; Space toggles it without dismissing", async ({ page }) => {
		const sourceId = await createSession();
		sessionIds.push(sourceId);
		await waitForSessionStatus(sourceId, "idle");

		const row = await openSession(page, sourceId);
		await openMenu(row, "session", sourceId);

		const forkRow = page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="fork"]').first();
		const checkbox = page.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]').first();
		const menu = page.locator("sidebar-actions-popover [role='menu']");
		await expect(checkbox).toHaveAttribute("aria-checked", "true");

		// Walk down to the Fork row: Terminate(0) > Modify(1) > Copy link(2) > Fork(3).
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await expect(forkRow).toBeFocused();

		// ArrowDown from the Fork row lands on its trailing checkbox (its own stop).
		await page.keyboard.press("ArrowDown");
		await expect(checkbox).toBeFocused();

		// ArrowUp returns to the Fork row, ArrowDown comes back to the checkbox.
		await page.keyboard.press("ArrowUp");
		await expect(forkRow).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(checkbox).toBeFocused();

		// Space on the focused checkbox toggles aria-checked WITHOUT firing Fork or
		// dismissing the popover.
		await page.keyboard.press(" ");
		await expect(checkbox).toHaveAttribute("aria-checked", "false");
		await expect(menu).toBeVisible();
		await expect(checkbox).toBeFocused();

		await page.keyboard.press(" ");
		await expect(checkbox).toHaveAttribute("aria-checked", "true");
		await expect(menu).toBeVisible();
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

	// Assign a role to an existing session via the real PATCH endpoint (which
	// drives sessionManager.assignRole → respawn) and wait for the role to
	// persist on the server session and the agent to return to idle. Mirrors
	// how the product assigns roles; faithful to the bug because the sidebar
	// Fork guard reads the persisted `session.role`.
	async function assignSessionRole(sessionId: string, roleId: string): Promise<void> {
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ roleId }),
		});
		expect(resp.ok, `PATCH roleId=${roleId} should succeed (got ${resp.status})`).toBeTruthy();
		// assignRole kills + respawns the agent; wait for it to settle back to idle.
		await waitForSessionStatus(sessionId, "idle");
		// Confirm the role actually persisted on the session — otherwise the
		// test would not be exercising the role-gated Fork path at all.
		await expect.poll(async () => {
			const get = await apiFetch(`/api/sessions/${sessionId}`);
			if (!get.ok) return undefined;
			return (await get.json()).role;
		}, { timeout: 15_000 }).toBe(roleId);
	}

	// REPRODUCING TEST (must FAIL on current code, PASS once canForkSidebarSession
	// stops gating on `!session.role`). A standard session carrying the default
	// `role: "general"` must still expose Fork — the server's
	// isUnsupportedForkSource() permits forking role:"general", so the client
	// must not hide it. On current code the `!session.role` clause suppresses
	// Fork for ANY truthy role, so the Fork menu item is absent here.
	test("standard role:general session still shows Fork in the sidebar menu", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await assignSessionRole(sessionId, "general");

		const row = await openSession(page, sessionId);
		await openMenu(row, "session", sessionId);
		// Sanity: the menu opened and lists the standard items.
		await expect(menuItem(page, "copy-link")).toBeVisible();

		const forkItem = menuItem(page, "fork");
		await expect(
			forkItem,
			"Fork menu item must be VISIBLE for role:general sessions (server permits forking them; client must agree)",
		).toBeVisible({ timeout: 5_000 });
	});

	// NEGATIVE (must PASS now and stay passing): a team-lead session is genuinely
	// non-forkable — the server's isUnsupportedForkSource() rejects role:"team-lead"
	// — so the client must hide Fork. This is the one role-based exclusion the fix
	// must preserve.
	test("role:team-lead session hides Fork in the sidebar menu", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await assignSessionRole(sessionId, "team-lead");

		const row = await openSession(page, sessionId);
		await openMenu(row, "session", sessionId);
		// The menu opened (standard item present) but Fork must be absent.
		await expect(menuItem(page, "copy-link")).toBeVisible();
		await expect(
			menuItem(page, "fork"),
			"Fork must stay hidden for team-lead sessions",
		).toHaveCount(0, { timeout: 5_000 });
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
