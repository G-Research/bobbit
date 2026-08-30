import {
	MARK,
	checkbox,
	expect,
	expectNoPopover,
	focusMenuStop,
	installSidebarActionsFixture,
	item,
	menu,
	menuLabels,
	menuTitleMap,
	openMenu,
	row,
	test,
	trigger,
} from "../../../tests2/browser/fixtures/sidebar-actions-menu-fixture-support.js";

const { loadFixture } = installSidebarActionsFixture("sidebar-actions-menu-contracts-fixture-bundle.js");

test("render-time session updates use the mounted active gateway connection", async ({ page }) => {
	const ids = await loadFixture(page);
	await expect.poll(() => page.evaluate((sessionId) =>
		(window as any).__sidebarActionsRequests.find((request: any) =>
			request.method === "PATCH" && request.url.endsWith(`/api/sessions/${sessionId}`)), ids.session), {
		message: `${MARK}: rendering should persist the assigned session colour through the gateway boundary`,
	}).toMatchObject({
		url: `https://fixture.test/team/bobbit/api/sessions/${ids.session}`,
		method: "PATCH",
		credentials: null,
		authorization: "Bearer fixture-token",
	});
});

test("hover strip layout keeps action controls out of idle-time layout flow", async ({ page }) => {
	const ids = await loadFixture(page);
	const sessionRow = row(page, "session", ids.session);
	const stripClass = await sessionRow.locator(".sidebar-actions").first().getAttribute("class");
	expect(stripClass).toContain("absolute");
	expect(stripClass).toContain("opacity-0");
	expect(stripClass).toContain("pointer-events-none");
	await expect(sessionRow.locator('span[class*="group-hover:hidden"]').first()).toBeVisible();
});

test("session and goal menus preserve popover ordering and title contracts", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect.poll(() => menuLabels(page)).toEqual(["Modify", "Terminate", "Pin session", "Refresh agent", "Fork", "Copy link", "View system prompt", "Open in new window"]);
	await expect.poll(() => menuTitleMap(page)).toMatchObject({
		modify: "Modify session. Edit the name, colour, and Role",
		pin: "Keep this session in Pinned",
		"refresh-agent": "Restart this agent with the latest prompt, tools, and auth state",
		fork: "Create a new session from this session's history",
		"copy-link": "Copy a link to this session",
		"view-system-prompt": "View system prompt",
		"open-new-window": "Open this session in a new browser window",
	});
	expect((await menuTitleMap(page)).terminate).toContain("Terminate this session");
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "goal", ids.goal);
	await expect.poll(() => menuLabels(page)).toEqual(["Goal dashboard", "Archive", "Re-attempt", "Copy link"]);
	await expect.poll(() => menuTitleMap(page)).toEqual({
		dashboard: "Open this goal's dashboard",
		archive: "Archive this goal",
		reattempt: "Start a new attempt for this goal",
		"copy-link": "Copy a link to this goal",
	});
});

test("dismissal closes on outside click, Escape, route change, item selection, repeated toggle, and direct switch", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await page.mouse.click(5, 5);
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await page.evaluate(() => { window.location.hash = "#/settings"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await item(page, "copy-link").click();
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await trigger(page, "session", ids.session).click();
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await trigger(page, "goal", ids.goal).click();
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(1, { timeout: 5_000 });
	await expect(item(page, "dashboard")).toBeVisible({ timeout: 5_000 });
});

test("copy link fallback uses legacy execCommand without surfacing a modal", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await item(page, "copy-link").click();
	await expectNoPopover(page);
	await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsExecCopies)).toContain(
		await page.evaluate((id) => `${location.origin}${location.pathname}${location.search}#/session/${id}`, ids.session),
	);

	await openMenu(page, "goal", ids.goal);
	await item(page, "copy-link").click();
	await expectNoPopover(page);
	await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsExecCopies)).toContain(
		await page.evaluate((id) => `${location.origin}${location.pathname}${location.search}#/goal/${id}`, ids.goal),
	);
});

test("goal GitHub action labels PR-numbered pull requests and opens the cached URL", async ({ page }) => {
	const ids = await loadFixture(page);
	const prUrl = "https://github.com/acme/widget/pull/1241";

	await page.evaluate(({ goalId, url }) => {
		(window as any).__bobbitState.prStatusCache.set(goalId, { state: "OPEN", url, number: 1241 });
	}, { goalId: ids.goal, url: prUrl });

	await openMenu(page, "goal", ids.goal);
	await expect(item(page, "open-github")).toHaveText("Open #1241 on GitHub");
	await expect(item(page, "open-github")).toHaveAttribute("title", "Open this goal's pull request on GitHub");
	await item(page, "open-github").click();
	await expectNoPopover(page);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsOpenedUrls.at(-1))).toBe(prUrl);

	await page.evaluate(({ goalId, url }) => {
		(window as any).__bobbitState.prStatusCache.set(goalId, { state: "OPEN", url });
	}, { goalId: ids.goal, url: prUrl });

	await openMenu(page, "goal", ids.goal);
	await expect(item(page, "open-github")).toHaveText("Open on GitHub");
});

test("fork checkbox toggles independently and fork reads the current New worktree state", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect(item(page, "fork")).toBeVisible();
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");

	await checkbox(page).click();
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "false");
	await expect(menu(page)).toBeVisible();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);

	await item(page, "fork").click();
	await expectNoPopover(page);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([{ newWorktree: false }]);
});

test("fork checkbox is a roving-focus stop and Space toggles without dismissing", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");
	await focusMenuStop(page, "fork", "menuitem");
	await expect(item(page, "fork")).toBeFocused();

	await page.keyboard.press("ArrowDown");
	await expect(checkbox(page)).toBeFocused();
	await page.keyboard.press(" ");
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "false");
	await expect(menu(page)).toBeVisible();
	await expect(checkbox(page)).toBeFocused();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);

	await page.keyboard.press(" ");
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");
	await expect(menu(page)).toBeVisible();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);
});

test("role-based fork visibility mirrors the server-supported session model", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.generalSession);
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "fork"), "role:general sessions remain forkable").toBeVisible();
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "session", ids.teamLeadSession);
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "fork"), "team-lead sessions are genuinely non-forkable").toHaveCount(0);
});

test("reduced-motion opens and closes without component animations", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const ids = await loadFixture(page);
	await page.evaluate(() => {
		const original = Element.prototype.animate;
		(window as any).__sidebarActionsAnimateCalls = 0;
		Element.prototype.animate = function(...args: any[]) {
			(window as any).__sidebarActionsAnimateCalls += 1;
			return original.apply(this, args as any);
		};
	});

	await openMenu(page, "session", ids.session);
	await expect(item(page, "copy-link")).toBeVisible();
	await page.keyboard.press("Escape");
	await expectNoPopover(page);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsAnimateCalls)).toBe(0);
});
