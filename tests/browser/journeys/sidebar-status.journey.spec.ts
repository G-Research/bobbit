import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../../support/helpers/browser/fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-status-journey-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-status-journey-fixture-bundle.js");
const MARK = "SIDEBAR_STATUS_JOURNEY";

type FixtureIds = {
	project: string;
	pinnedNew: string;
	pinnedOld: string;
	unreadNew: string;
	unreadOld: string;
	readNew: string;
	readOld: string;
	busy: string;
	teamLead: string;
	teamMember: string;
	staffSession: string;
	archived: string;
};

const DEPS = [
	ENTRY,
	path.resolve("src/app/sidebar.ts"),
	path.resolve("src/app/sidebar-status.ts"),
	path.resolve("src/app/sidebar-status-motion.ts"),
	path.resolve("src/app/sidebar-view-preferences.ts"),
	path.resolve("src/app/render.ts"),
	path.resolve("src/app/render-helpers.ts"),
	path.resolve("src/app/session-actions.ts"),
	path.resolve("src/app/api.ts"),
	path.resolve("src/app/state.ts"),
	path.resolve("src/ui/components/sidebar-filters.ts"),
	path.resolve("src/ui/components/SidebarActionsPopover.ts"),
	path.resolve("src/shared/session-tags.ts"),
];

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: DEPS });
});

async function openFixture(page: Page, viewport = { width: 1280, height: 900 }): Promise<void> {
	await page.setViewportSize(viewport);
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarStatusJourneyReady === true, null, { timeout: 15_000 });
}

async function loadFixture(page: Page): Promise<FixtureIds> {
	await openFixture(page);
	await page.evaluate(() => (window as any).__resetSidebarStatusJourney());
	await expect(page.getByTestId("sidebar-expanded"), `${MARK}: desktop sidebar should render`).toBeVisible({ timeout: 10_000 });
	return page.evaluate(() => (window as any).__sidebarStatusJourneyIds);
}

type PersistedStatusSurface = "desktop" | "mobile" | "collapsed";

async function loadPersistedStatusFixture(page: Page, surface: PersistedStatusSurface): Promise<FixtureIds> {
	await openFixture(page, surface === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 900 });
	await page.evaluate((initialSurface) => (window as any).__resetSidebarStatusJourney({
		initialView: "status",
		surface: initialSurface,
		deferStaff: true,
	}), surface);
	if (surface === "collapsed") {
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible({ timeout: 10_000 });
		expect(await page.evaluate(() => (window as any).__bobbitState.sidebarSessionView)).toBe("status");
	} else {
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
	}
	return page.evaluate(() => (window as any).__sidebarStatusJourneyIds);
}

function row(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function section(page: Page, key: "pinned" | "unread" | "read"): Locator {
	return page.locator(`[data-status-section="${key}"]`);
}

async function sessionIdsInSection(page: Page, key: "pinned" | "unread" | "read"): Promise<string[]> {
	return section(page, key).locator("[data-session-id]").evaluateAll((elements) =>
		elements.map((element) => (element as HTMLElement).dataset.sessionId || "").filter(Boolean),
	);
}

async function headingMetrics(heading: Locator, labelSelector: string) {
	return heading.evaluate((element, selector) => {
		const label = element.querySelector<HTMLElement>(selector);
		if (!label) throw new Error(`Missing heading label: ${selector}`);
		const headingStyle = getComputedStyle(element);
		const labelStyle = getComputedStyle(label);
		return {
			height: element.getBoundingClientRect().height,
			contentHeight: label.getBoundingClientRect().height + Number.parseFloat(headingStyle.paddingTop) + Number.parseFloat(headingStyle.paddingBottom),
			padding: [headingStyle.paddingTop, headingStyle.paddingRight, headingStyle.paddingBottom, headingStyle.paddingLeft],
			fontSize: labelStyle.fontSize,
			fontWeight: labelStyle.fontWeight,
			letterSpacing: labelStyle.letterSpacing,
		};
	}, labelSelector);
}

function filtersButton(page: Page): Locator {
	return page.getByTestId("sidebar-filters-button");
}

function filterCheckbox(page: Page, id: "archived" | "busy" | "read" | "teams"): Locator {
	return page.getByTestId(`sidebar-filter-${id}`).locator('input[type="checkbox"]');
}

async function openFilters(page: Page): Promise<void> {
	await filtersButton(page).click();
	await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible();
}

async function closeFiltersWithEscape(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("sidebar-filters-popover")).toHaveCount(0);
	await expect(filtersButton(page)).toBeFocused();
}

async function openSessionMenu(page: Page, sessionId: string): Promise<void> {
	const targetRow = row(page, sessionId);
	await expect(targetRow).toBeVisible();
	await targetRow.hover();
	await targetRow.getByTestId("sidebar-actions-trigger").click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
}

async function menuItemIds(page: Page): Promise<string[]> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((elements) =>
		elements.map((element) => (element as HTMLElement).dataset.sidebarActionId || "").filter(Boolean),
	);
}

async function switchToStatus(page: Page): Promise<void> {
	await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
}

async function assertPersistedStatusStaffResolution(
	page: Page,
	ids: FixtureIds,
	surface: PersistedStatusSurface,
): Promise<void> {
	await expect(page.getByTestId("project-header"), `${MARK}: persisted Status must not require Project rendering`).toHaveCount(0);
	await expect.poll(() => page.evaluate(() =>
		(window as any).__sidebarStatusRequests.filter((request: any) => request.route === "/api/staff" && request.method === "GET").length,
	)).toBe(1);

	const staffRows = page.locator(`[data-session-id="${ids.staffSession}"]`);
	await expect(staffRows, `${MARK}: raw and synthesized staff rows must dedupe`).toHaveCount(1);
	const staffRow = staffRows.first();
	if (surface === "collapsed") {
		await expect(staffRow).toHaveAttribute("title", "Underlying Staff Runtime");
	} else {
		await expect(staffRow.getByTestId("sidebar-session-title-text")).toHaveText("Underlying Staff Runtime");
	}

	await page.evaluate(() => (window as any).__releaseSidebarStatusStaffResponse());
	await expect(staffRows, `${MARK}: async staff rerender must retain exactly one canonical row`).toHaveCount(1);
	if (surface === "collapsed") {
		await expect(staffRow).toHaveAttribute("title", "Async Status Staff");
		await page.getByTitle(/Expand sidebar/).click();
		await expect(page.getByTestId("sidebar-expanded")).toBeVisible();
	} else {
		await expect(staffRow.getByTestId("sidebar-session-title-text")).toHaveText("Async Status Staff");
	}

	await openSessionMenu(page, ids.staffSession);
	await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="modify"]')).toHaveText(/Edit staff/);
	await page.keyboard.press("Escape");
}

test.describe("Journey: Sidebar status views", () => {
	test("desktop journey covers status grouping, independent filters, search, pin, read, archives, actions, focus, reload, and collapse", async ({ page }) => {
		const ids = await loadFixture(page);

		// Clean profile: one search, By Project selected, and canonical tree intact.
		await expect(page.locator("input[data-search]")).toHaveCount(1);
		await expect(page.getByTestId("sidebar-view-project")).toHaveAttribute("aria-pressed", "true");
		const projectHeader = page.getByTestId("project-header").filter({ hasText: "Status Journey Project" });
		await expect(projectHeader).toBeVisible();
		const projectGroupingHeader = page.getByTestId("sidebar-sessions-header");
		await expect(projectGroupingHeader).toBeVisible();
		const projectHeadingMetrics = await headingMetrics(projectGroupingHeader, ":scope > .flex-1");
		await expect(row(page, ids.readNew)).toBeVisible();

		// Shared search and Full Search remain available in Project mode.
		const search = page.locator("input[data-search]");
		await search.fill("Read Newest");
		await expect(row(page, ids.readNew)).toBeVisible();
		await expect(row(page, ids.readOld)).toBeHidden();
		await expect(page.getByText("Full Search")).toBeVisible();
		await search.fill("");

		// An existing production action still opens before switching views.
		await openSessionMenu(page, ids.readNew);
		await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="modify"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator('sidebar-actions-popover [role="menu"]')).toBeHidden();

		await switchToStatus(page);
		await expect.poll(() => page.locator("[data-status-section]").evaluateAll((elements) =>
			elements.map((element) => (element as HTMLElement).dataset.statusSection),
		)).toEqual(["pinned", "unread", "read"]);
		await expect.poll(() => sessionIdsInSection(page, "pinned")).toEqual([ids.pinnedNew, ids.pinnedOld]);
		await expect.poll(() => sessionIdsInSection(page, "unread")).toEqual([ids.unreadNew, ids.unreadOld]);
		await expect.poll(() => sessionIdsInSection(page, "read")).toEqual([ids.busy, ids.readNew, ids.readOld, ids.teamLead, ids.staffSession]);
		const goalOwnedRow = row(page, ids.unreadNew);
		await expect(goalOwnedRow.getByTestId("sidebar-status-goal-title")).toHaveText("IMPROVE SESSION MANAGER SIDEBAR");
		await expect(goalOwnedRow.getByTestId("sidebar-session-title-text"), `${MARK}: agent title moves to the quiet second line`).toHaveText("Unread Newest");
		const goalIconColor = await goalOwnedRow.locator(".sidebar-status-goal-title-icon").evaluate(element => getComputedStyle(element).color);
		expect(["rgb(37, 99, 235)", "rgb(96, 165, 250)"], `${MARK}: goal icon uses the owning project colour`).toContain(goalIconColor);
		await expect(goalOwnedRow.getByTestId("sidebar-status-session-title-icon"), `${MARK}: goal rows do not duplicate the session identity icon`).toHaveCount(0);
		const standaloneRow = row(page, ids.unreadOld);
		await expect(standaloneRow.getByTestId("sidebar-status-goal-title"), `${MARK}: standalone sessions stay single-line`).toHaveCount(0);
		await expect(standaloneRow.getByTestId("sidebar-status-session-title-icon"), `${MARK}: standalone Status rows show a session icon`).toHaveAttribute("data-status-identity", "session");
		const staffRow = row(page, ids.staffSession);
		await expect(staffRow.getByTestId("sidebar-status-session-title-icon"), `${MARK}: staff Status rows use the staff icon instead of the session icon`).toHaveAttribute("data-status-identity", "staff");
		const sessionIconColor = await standaloneRow.getByTestId("sidebar-status-session-title-icon").evaluate(element => getComputedStyle(element).color);
		expect(["rgb(37, 99, 235)", "rgb(96, 165, 250)"], `${MARK}: session icon uses the owning project colour`).toContain(sessionIconColor);

		const motionResult = await page.evaluate((sessionId) => {
			(window as any).__reorderSidebarStatusUnreadRows();
			const movingRow = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)!;
			const clickTarget = movingRow.querySelector<HTMLElement>("[data-testid='sidebar-session-title-text']")!;
			const clickDispatched = clickTarget.dispatchEvent(new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				detail: 1,
			}));
			return {
				moving: movingRow.dataset.statusMoving,
				tracing: movingRow.dataset.statusChangeTracing,
				clickDispatched,
				selectedSessionId: (window as any).__bobbitState.selectedSessionId,
			};
		}, ids.unreadOld);
		expect(motionResult, `${MARK}: FLIP rows trace changes and suppress pointer clicks while moving`).toEqual({
			moving: "true",
			tracing: "true",
			clickDispatched: false,
			selectedSessionId: null,
		});
		await expect.poll(() => sessionIdsInSection(page, "unread")).toEqual([ids.unreadOld, ids.unreadNew]);
		await expect(row(page, ids.unreadOld)).not.toHaveAttribute("data-status-moving", "true", { timeout: 2_000 });

		for (const key of ["pinned", "unread", "read"] as const) {
			const heading = section(page, key).locator(".sidebar-status-heading");
			await expect(heading.locator(".sidebar-status-heading-icon svg"), `${MARK}: ${key} heading needs an icon`).toHaveCount(1);
			await expect(heading.locator(".sidebar-chevron-glyph"), `${MARK}: ${key} heading needs a disclosure chevron`).toHaveText("▾");
			const metrics = await headingMetrics(heading, ".sidebar-status-heading-label");
			expect(metrics.contentHeight, `${MARK}: ${key} heading content height should match By Project`).toBeCloseTo(projectHeadingMetrics.contentHeight, 2);
			expect(metrics.padding, `${MARK}: ${key} heading padding should match By Project`).toEqual(projectHeadingMetrics.padding);
			expect(
				{ fontSize: metrics.fontSize, fontWeight: metrics.fontWeight, letterSpacing: metrics.letterSpacing },
				`${MARK}: ${key} heading typography should match By Project`,
			).toEqual({
				fontSize: projectHeadingMetrics.fontSize,
				fontWeight: projectHeadingMetrics.fontWeight,
				letterSpacing: projectHeadingMetrics.letterSpacing,
			});
		}
		await expect(page.locator(".sidebar-status-separator"), `${MARK}: rules belong only between Status sections`).toHaveCount(2);
		expect(await section(page, "pinned").evaluate((element) => element.previousElementSibling?.classList.contains("sidebar-status-separator") ?? false)).toBe(false);
		for (const key of ["unread", "read"] as const) {
			expect(await section(page, key).evaluate((element) => element.previousElementSibling?.classList.contains("sidebar-status-separator") ?? false)).toBe(true);
		}

		// Status headings collapse like project groups and persist independently.
		const unreadHeading = section(page, "unread").locator(".sidebar-status-heading");
		await unreadHeading.click();
		await expect(unreadHeading).toHaveAttribute("aria-expanded", "false");
		await expect(section(page, "unread").locator("[data-session-id]")).toHaveCount(0);
		await expect(section(page, "pinned").locator("[data-session-id]")).toHaveCount(2);
		await page.evaluate(() => (window as any).__reloadSidebarStatusJourney());
		await expect(section(page, "unread").locator(".sidebar-status-heading")).toHaveAttribute("aria-expanded", "false");
		await section(page, "unread").locator(".sidebar-status-heading").press("Enter");
		await expect.poll(() => sessionIdsInSection(page, "unread")).toEqual([ids.unreadNew, ids.unreadOld]);

		const allIds = await page.locator("[data-status-section] [data-session-id]").evaluateAll((elements) =>
			elements.map((element) => (element as HTMLElement).dataset.sessionId),
		);
		expect(new Set(allIds).size, `${MARK}: status sessions must be exclusive`).toBe(allIds.length);

		// Show teams is Status-only and defaults off; the lead remains visible.
		await openFilters(page);
		await expect(filterCheckbox(page, "teams")).not.toBeChecked();
		await expect(row(page, ids.teamLead)).toBeVisible();
		await expect(row(page, ids.teamMember)).toHaveCount(0);
		await filterCheckbox(page, "teams").check();
		await expect(row(page, ids.teamMember)).toBeVisible();
		await closeFiltersWithEscape(page);

		// Status and Project filter values are independent across view switches.
		await openFilters(page);
		await filterCheckbox(page, "read").uncheck();
		await closeFiltersWithEscape(page);
		await page.getByTestId("sidebar-view-project").evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.getByTestId("sidebar-view-project")).toHaveAttribute("aria-pressed", "true");
		await openFilters(page);
		await expect(page.getByTestId("sidebar-filter-teams")).toHaveCount(0);
		await expect(filterCheckbox(page, "read")).toBeChecked();
		await filterCheckbox(page, "archived").check();
		await closeFiltersWithEscape(page);
		await switchToStatus(page);
		await openFilters(page);
		await expect(filterCheckbox(page, "read")).not.toBeChecked();
		await expect(filterCheckbox(page, "archived")).not.toBeChecked();
		await expect(filterCheckbox(page, "teams")).toBeChecked();
		await closeFiltersWithEscape(page);

		// Search bypasses Status visibility filters and clearing restores them.
		await expect(row(page, ids.readOld)).toHaveCount(0);
		await search.fill("Read Older");
		await expect(row(page, ids.readOld)).toBeVisible();
		await search.fill("");
		await expect(row(page, ids.readOld)).toHaveCount(0);

		// Production Show Read suppresses idle/terminated rows only. Serialized
		// archived rows remain visible when archives are enabled and Read is off.
		await openFilters(page);
		await expect(filterCheckbox(page, "read")).not.toBeChecked();
		await filterCheckbox(page, "archived").check();
		await closeFiltersWithEscape(page);
		await expect(row(page, ids.archived)).toBeVisible();
		await expect(row(page, ids.readOld)).toHaveCount(0);

		// Live quick actions remain Modify, Terminate, Menu; Pin is menu-only and third.
		await openSessionMenu(page, ids.unreadNew);
		expect((await menuItemIds(page)).slice(0, 3)).toEqual(["modify", "terminate", "pin"]);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="pin"][data-sidebar-action-quick="true"]')).toHaveCount(0);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]')).toHaveCount(1);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]')).toHaveCount(1);
		const trigger = row(page, ids.unreadNew).getByTestId("sidebar-actions-trigger");
		await expect(trigger).toHaveAttribute("aria-label", "Session actions");
		await expect(trigger.locator("svg")).toHaveCount(1);
		await expect(trigger.locator('path[d="M4 12h16"]')).toHaveCount(1);

		// Optimistic Pin moves immediately, reconciles, and survives fixture reload.
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]').click();
		await expect(section(page, "pinned").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();
		await expect.poll(() => page.evaluate((sessionId) =>
			(window as any).__sidebarStatusRequests.some((request: any) => request.route.endsWith(`/api/sessions/${sessionId}/pin`) && request.method === "PUT"),
		ids.unreadNew)).toBe(true);
		await page.evaluate(() => (window as any).__reloadSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
		await expect(section(page, "pinned").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();

		// Unpin reclassifies according to unread state.
		await openSessionMenu(page, ids.unreadNew);
		await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]')).toHaveText(/Unpin session/);
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]').click();
		await expect(section(page, "unread").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();

		// Marking an unread session read moves it to Read; enable Read first.
		await openFilters(page);
		await filterCheckbox(page, "read").check();
		await closeFiltersWithEscape(page);
		await page.evaluate((sessionId) => (window as any).__markSidebarStatusSessionRead(sessionId), ids.unreadOld);
		await expect(section(page, "read").locator(`[data-session-id="${ids.unreadOld}"]`)).toBeVisible();

		// Active work keeps canonical shimmer/time slot and never adds busy copy.
		await expect(row(page, ids.busy).locator(".sidebar-active-dot")).toHaveCount(1);
		await expect(row(page, ids.busy)).not.toContainText(/busy|streaming/i);
		await expect(row(page, ids.readNew).getByTestId("sidebar-session-last-activity")).toBeVisible();

		// Archived visibility is Status-owned and rows/actions remain archive-safe.
		await openFilters(page);
		await expect(filterCheckbox(page, "archived")).toBeChecked();
		await closeFiltersWithEscape(page);
		await expect(row(page, ids.archived)).toBeVisible();
		await expect(row(page, ids.archived).getByTestId("sidebar-status-session-title-icon"), `${MARK}: archived standalone rows retain the session identity icon`).toHaveCount(1);
		await expect(row(page, ids.archived)).toHaveCSS("filter", "grayscale(1)");
		await openSessionMenu(page, ids.archived);
		expect((await menuItemIds(page)).slice(0, 3)).toEqual(["continue-archived", "copy-link", "pin"]);
		await page.keyboard.press("Escape");

		// View, filters, and collapsed Status grouping persist over the reload boundary.
		await page.getByTitle(/Collapse sidebar/).click();
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible();
		await expect(page.getByTestId("sidebar-collapsed").getByRole("group", { name: /Pinned/ })).toBeVisible();
		await page.evaluate(() => (window as any).__reloadSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible();
		await page.getByTitle(/Expand sidebar/).click();
		await openFilters(page);
		await expect(filterCheckbox(page, "archived")).toBeChecked();
		await expect(filterCheckbox(page, "teams")).toBeChecked();
		await closeFiltersWithEscape(page);
	});

	test("persisted desktop Status resolves staff asynchronously without a Project render", async ({ page }) => {
		const ids = await loadPersistedStatusFixture(page, "desktop");
		await expect(page.getByTestId("sidebar-expanded")).toBeVisible();
		await assertPersistedStatusStaffResolution(page, ids, "desktop");
	});

	for (const surface of ["mobile", "collapsed"] as const) {
		test(`persisted ${surface} Status resolves staff asynchronously without a Project render`, async ({ page }) => {
			const ids = await loadPersistedStatusFixture(page, surface);
			if (surface === "collapsed") await expect(page.getByTestId("sidebar-collapsed")).toBeVisible();
			await assertPersistedStatusStaffResolution(page, ids, surface);
		});
	}

	test("mobile exposes status controls with always-visible actions and no row-click leakage", async ({ page }) => {
		const ids = await loadFixture(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => (window as any).__renderMobileSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
		const mobileGoalFontSize = await row(page, ids.unreadNew).getByTestId("sidebar-status-goal-title").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
		const mobileSessionFontSize = await row(page, ids.unreadOld).getByTestId("sidebar-session-title-text").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
		expect(mobileGoalFontSize, `${MARK}: mobile goal title is deliberately smaller than a standard session title`).toBeLessThan(mobileSessionFontSize);

		const targetRow = row(page, ids.readNew);
		await expect(targetRow).toBeVisible();
		await expect(targetRow.locator(".sidebar-mobile-action-cluster")).toBeVisible();
		await expect(targetRow.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(targetRow.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]')).toBeVisible();
		const hashBefore = await page.evaluate(() => window.location.hash);
		await targetRow.getByTestId("sidebar-actions-trigger").click();
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(hashBefore);

		await page.keyboard.press("Escape");
		await openFilters(page);
		await expect(filterCheckbox(page, "teams")).not.toBeChecked();
		await closeFiltersWithEscape(page);
	});
});
