import {
	MARK,
	expect,
	expectNoPopover,
	expectQuickActionHiddenAndNonInteractive,
	installSidebarActionsFixture,
	item,
	menuLabels,
	openMenu,
	row,
	test,
	trigger,
} from "../../../tests2/browser/fixtures/sidebar-actions-menu-fixture-support.js";

const { loadFixture } = installSidebarActionsFixture("sidebar-actions-menu-mobile-fixture-bundle.js");

test("mobile rows expose quick actions plus hamburger menus without row navigation", async ({ page }) => {
	const ids = await loadFixture(page, { width: 390, height: 820 });
	const sRow = row(page, "session", ids.session);
	const sessionModify = sRow.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]').first();
	const sessionTerminate = sRow.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]').first();
	await expect(sessionModify, "mobile session rows should expose quick modify before the hamburger opens").toBeVisible();
	await expect(sessionTerminate, "mobile session rows should expose quick terminate before the hamburger opens").toBeVisible();
	await expect(sRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);

	const startingHash = await page.evaluate(() => window.location.hash);
	const startingActive = await sRow.getAttribute("data-nav-active");
	await expect(trigger(page, "session", ids.session), "mobile session rows must expose a hamburger actions trigger").toBeVisible();
	await openMenu(page, "session", ids.session);
	await expectQuickActionHiddenAndNonInteractive(sessionModify, "mobile sidebar modify quick action");
	await expectQuickActionHiddenAndNonInteractive(sessionTerminate, "mobile sidebar terminate quick action");
	await expect.poll(() => menuLabels(page)).toEqual(["Modify", "Terminate", "Pin session", "Refresh agent", "Fork", "Copy link", "View system prompt", "Open in new window"]);
	await expect(item(page, "pin")).toBeVisible();
	await expect(item(page, "refresh-agent")).toBeVisible();
	await expect(item(page, "fork")).toBeVisible();
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "view-system-prompt")).toBeVisible();
	await expect(item(page, "open-new-window")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: session hamburger must not select/navigate the row` }).toBe(startingHash);
	await expect(sRow).toHaveAttribute("data-nav-active", startingActive ?? "false");
	await page.keyboard.press("Escape");
	await expectNoPopover(page);
	await expect(sessionModify, "mobile sidebar modify quick action should return after Escape").toBeVisible({ timeout: 5_000 });
	await expect(sessionTerminate, "mobile sidebar terminate quick action should return after Escape").toBeVisible({ timeout: 5_000 });

	await sessionModify.click();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: quick modify must not select/navigate the row` }).toBe(startingHash);
	await expect(sRow).toHaveAttribute("data-nav-active", startingActive ?? "false");
	await page.keyboard.press("Escape").catch(() => {});

	const gRow = row(page, "goal", ids.goal);
	await expect(gRow.locator('[data-sidebar-action-id="archive"][data-sidebar-action-quick="true"]')).toBeVisible();
	await expect(gRow.locator('[data-sidebar-action-id="dashboard"][data-sidebar-action-quick="true"]')).toBeVisible();
	await expect(gRow.locator('[data-sidebar-action-id="reattempt"]'), "re-attempt remains popover-only, not an inline quick action").toHaveCount(0);
	await expect(gRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);
	const emptyState = page.getByText("No sessions").first();
	const emptyStateWasVisible = await emptyState.isVisible();
	await expect(trigger(page, "goal", ids.goal), "mobile goal rows must expose a hamburger actions trigger").toBeVisible();
	await openMenu(page, "goal", ids.goal);
	await expect.poll(() => menuLabels(page)).toEqual(["Goal dashboard", "Archive", "Re-attempt", "Copy link"]);
	await expect(item(page, "reattempt")).toBeVisible();
	await expect(item(page, "copy-link")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: goal hamburger must not navigate the row` }).toBe(startingHash);
	if (emptyStateWasVisible) await expect(emptyState, `${MARK}: goal hamburger must not toggle expansion`).toBeVisible();
});
