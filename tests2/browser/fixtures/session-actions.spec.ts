import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	base,
	createGoal,
	createSession,
	defaultProject,
	deleteGoal,
	deleteSession,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.describe.configure({ mode: "serial" });

const CANONICAL_SESSION_ACTION_IDS = [
	"modify",
	"terminate",
	"refresh-agent",
	"fork",
	"copy-link",
	"view-system-prompt",
	"open-new-window",
] as const;

const HEADER_ACTION_SELECTOR = `[data-session-action-surface="header"][data-session-action-id]`;
const POPOVER_ACTION_SELECTOR = `sidebar-actions-popover [role="menuitem"][data-session-action-id]`;

type StaffRecord = { id: string; currentSessionId?: string; name: string };

function sessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function staffSessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-nav-id="session:${sessionId}"]`).first();
}

function sidebarTrigger(row: Locator, sessionId: string): Locator {
	return row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
}

function headerTrigger(page: Page): Locator {
	return page.locator(`[data-testid="session-actions-trigger"]`).first();
}

function popoverAction(page: Page, actionId: string): Locator {
	return page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="${actionId}"]`).first();
}

function headerDirectAction(page: Page, actionId: string): Locator {
	return page.locator(`[data-session-action-surface="header"][data-session-action-id="${actionId}"]`).first();
}

async function openSessionView(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openSession(page: Page, sessionId: string, rowTimeout = 10_000): Promise<Locator> {
	await openSessionView(page, sessionId);
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: rowTimeout });
	return row;
}

async function openSidebarActions(page: Page, sessionId: string): Promise<void> {
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.hover();
	const trigger = sidebarTrigger(row, sessionId);
	await expect(trigger).toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
}

async function openHeaderActions(page: Page): Promise<void> {
	const menu = page.locator("sidebar-actions-popover [role='menu']").first();
	if (await menu.isVisible().catch(() => false)) return;

	const trigger = headerTrigger(page);
	await expect(trigger).toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(menu).toBeVisible({ timeout: 5_000 });
}

async function closePopover(page: Page): Promise<void> {
	if (await page.locator("sidebar-actions-popover").count()) {
		await page.keyboard.press("Escape");
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
	}
}

async function expectQuickActionHiddenAndNonInteractive(action: Locator, description: string): Promise<void> {
	await expect(action, `${description} should be hidden while the hamburger menu is open`).toBeHidden({ timeout: 5_000 });
	const interactiveTargets = await action.evaluateAll((els) => els.map((el, index) => {
		const target = el as HTMLElement;
		let current: HTMLElement | null = target;
		let hiddenByStyle = false;
		while (current) {
			const style = getComputedStyle(current);
			if (style.display === "none" || style.visibility === "hidden") {
				hiddenByStyle = true;
				break;
			}
			current = current.parentElement;
		}
		const hiddenByAttribute = Boolean(target.closest("[hidden],[aria-hidden='true'],[inert]"));
		const disabled = (target as HTMLButtonElement).disabled || target.getAttribute("aria-disabled") === "true";
		const focusBlocked = hiddenByStyle || hiddenByAttribute || disabled || target.getAttribute("tabindex") === "-1" || target.tabIndex < 0;
		const rect = target.getBoundingClientRect();
		let pointerBlocked = rect.width <= 0 || rect.height <= 0 || getComputedStyle(target).pointerEvents === "none";
		if (!pointerBlocked) {
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			pointerBlocked = !hit || (hit !== target && !target.contains(hit));
		}
		return focusBlocked && pointerBlocked ? "" : `target ${index}: focusBlocked=${focusBlocked} pointerBlocked=${pointerBlocked}`;
	}).filter(Boolean));
	expect(interactiveTargets, `${description} should not leave clickable or focusable targets`).toEqual([]);
}

async function expectHeaderDirectActionHiddenAndNonInteractive(page: Page, actionId: string, description: string): Promise<void> {
	const action = headerDirectAction(page, actionId);
	await expect(action, `${description} should remain mounted while the hamburger menu is open so FLIP can own its visibility`).toHaveCount(1);
	await expectQuickActionHiddenAndNonInteractive(action, description);
}

async function visibleHeaderDirectActionIds(page: Page): Promise<string[]> {
	return page.locator(HEADER_ACTION_SELECTOR).evaluateAll((els) => els
		.filter((el) => {
			const target = el as HTMLElement;
			const style = getComputedStyle(target);
			const rect = target.getBoundingClientRect();
			return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
		})
		.map((el) => (el as HTMLElement).dataset.sessionActionId || "")
		.filter(Boolean));
}

async function popoverSourceActionIds(page: Page): Promise<string[]> {
	return page.locator("sidebar-actions-popover").first().evaluate((el) => ((el as any).sourceRects || []).map((rect: { actionId: string }) => rect.actionId));
}

async function installActionAnimationRecorder(page: Page, key: string): Promise<void> {
	await page.evaluate((recorderKey) => {
		const win = window as any;
		const original = win.__sessionActionOriginalAnimate || Element.prototype.animate;
		win.__sessionActionOriginalAnimate = original;
		win[recorderKey] = [];
		Element.prototype.animate = function(keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
			const el = this as HTMLElement;
			const row = el.closest<HTMLElement>("[role='menuitem'][data-session-action-id],[role='menuitemcheckbox'][data-session-action-id]");
			win[recorderKey].push({
				actionId: el.dataset.sidebarActionId || el.dataset.sessionActionId || row?.dataset.sessionActionId || "",
				rowActionId: row?.dataset.sessionActionId || "",
				quick: el.dataset.sidebarActionQuick || row?.dataset.sidebarActionQuick || "",
				keyframes,
				keyframesText: JSON.stringify(keyframes),
				options,
			});
			return original.call(this, keyframes, options);
		};
	}, key);
}

async function expectPopoverTranslateAnimationsForActionIds(page: Page, recorderKey: string, actionIds: readonly string[], description: string): Promise<void> {
	await expect.poll(() => page.evaluate(({ key, ids }) => {
		const calls = ((window as any)[key] || []) as Array<{ actionId: string; rowActionId: string; keyframesText: string }>;
		return ids.filter((id) => calls.some((call) => call.actionId === id && call.rowActionId === id && call.keyframesText.includes("translate")));
	}, { key: recorderKey, ids: actionIds }), { timeout: 5_000, message: description }).toEqual([...actionIds]);
}

async function popoverActionIds(page: Page): Promise<string[]> {
	return page.locator(POPOVER_ACTION_SELECTOR).evaluateAll((els) =>
		els.map((el) => (el as HTMLElement).dataset.sessionActionId || "").filter(Boolean),
	);
}

async function headerActionIds(page: Page): Promise<string[]> {
	const directIds = await page.locator(HEADER_ACTION_SELECTOR).evaluateAll((els) =>
		els.map((el) => (el as HTMLElement).dataset.sessionActionId || "").filter(Boolean),
	);
	let overflowIds: string[] = [];
	if (await headerTrigger(page).isVisible().catch(() => false)) {
		await openHeaderActions(page);
		overflowIds = await popoverActionIds(page);
		await closePopover(page);
	}
	return uniqueInOrder([...directIds, ...overflowIds]);
}

function uniqueInOrder(ids: string[]): string[] {
	return ids.filter((id, index) => ids.indexOf(id) === index);
}

function canonicalSessionActionIds(ids: readonly string[], expected = CANONICAL_SESSION_ACTION_IDS): string[] {
	return ids.filter((id) => (expected as readonly string[]).includes(id));
}

function expectCanonicalOrder(ids: string[], expected = CANONICAL_SESSION_ACTION_IDS): void {
	expect(canonicalSessionActionIds(ids, expected)).toEqual(expected.filter((id) => ids.includes(id)));
}

function expectCanonicalActionsPresentInPriorityOrder(ids: string[], expected = CANONICAL_SESSION_ACTION_IDS): void {
	expect(canonicalSessionActionIds(ids, expected)).toEqual([...expected]);
}

async function actionLabel(page: Page, actionId: string): Promise<string> {
	const direct = headerDirectAction(page, actionId);
	if (await direct.isVisible().catch(() => false)) {
		return ((await direct.textContent()) || "").replace(/\s+/g, " ").trim();
	}
	await openHeaderActions(page);
	const label = ((await popoverAction(page, actionId).textContent()) || "").replace(/\s+/g, " ").trim();
	await closePopover(page);
	return label;
}

async function clickHeaderAction(page: Page, actionId: string): Promise<void> {
	await closePopover(page);
	const direct = headerDirectAction(page, actionId);
	if (await direct.isVisible().catch(() => false)) {
		await direct.click();
		return;
	}

	await openHeaderActions(page);
	await expect(popoverAction(page, actionId)).toBeVisible({ timeout: 5_000 });
	await page.evaluate((id) => {
		const selector = `sidebar-actions-popover [role="menuitem"][data-session-action-id="${CSS.escape(id)}"]`;
		const items = Array.from(document.querySelectorAll<HTMLElement>(selector));
		const item = items.find((el) => {
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
		});
		if (!item) throw new Error(`Visible header action not found: ${id}`);
		item.click();
	}, actionId);
}

async function createStaffAgent(name: string): Promise<StaffRecord> {
	const project = await defaultProject();
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			description: "Session actions E2E staff agent",
			systemPrompt: "You are a staff session action test bot.",
			cwd: project.rootPath,
			projectId: project.id,
		}),
	});
	expect(resp.status, `create staff ${name}`).toBe(201);
	return await resp.json() as StaffRecord;
}

async function waitForStaffSession(staffId: string): Promise<string> {
	let sessionId = "";
	await expect.poll(async () => {
		const resp = await apiFetch(`/api/staff/${staffId}`);
		if (!resp.ok) return "";
		const staff = await resp.json() as StaffRecord;
		sessionId = staff.currentSessionId || "";
		return sessionId;
	}, { timeout: 20_000 }).not.toBe("");
	return sessionId;
}

test.describe("unified session actions", () => {
	const sessionsToDelete = new Set<string>();
	const staffToDelete = new Set<string>();
	const goalsToDelete = new Set<string>();
	const teamsToTeardown = new Set<string>();

	test.afterAll(async () => {
		for (const goalId of teamsToTeardown) await teardownTeam(goalId).catch(() => {});
		for (const staffId of staffToDelete) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
		for (const sessionId of sessionsToDelete) await deleteSession(sessionId).catch(() => {});
		for (const goalId of goalsToDelete) await deleteGoal(goalId).catch(() => {});
	});

	test("sidebar and header expose the same action ids with canonical priority order", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openSession(page, sessionId);

		await openSidebarActions(page, sessionId);
		const sidebarIds = await popoverActionIds(page);
		const sidebarSourceIds = await popoverSourceActionIds(page);
		expect(sidebarSourceIds, "sidebar session menus should keep quick-only FLIP sources").toEqual(["modify", "terminate"]);
		await closePopover(page);

		const headerIds = await headerActionIds(page);
		expect(headerIds).toEqual(sidebarIds);
		expectCanonicalActionsPresentInPriorityOrder(sidebarIds);
	});

	test("staff and team-lead sessions keep canonical labels and visibility", async ({ page }) => {
		test.slow(); // staff-session sidebar lookup: extend timeout for concurrent verification load
		await page.setViewportSize({ width: 900, height: 900 });

		const staff = await createStaffAgent(`ActionsBot-${Date.now()}`);
		staffToDelete.add(staff.id);
		const staffSessionId = await waitForStaffSession(staff.id);
		sessionsToDelete.add(staffSessionId);
		await waitForSessionStatus(staffSessionId, "idle", 30_000);
		await openSessionView(page, staffSessionId);

		expect(await actionLabel(page, "modify")).toContain("Edit staff");
		await clickHeaderAction(page, "modify");
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain(`#/staff/${staff.id}`);

		await openSessionView(page, staffSessionId);
		const staffRow = staffSessionRow(page, staffSessionId);
		await expect(staffRow, "staff sidebar rows use nav ids and expose an existing Edit button").toBeVisible({ timeout: 30_000 });
		await staffRow.hover();
		const staffSidebarEdit = staffRow.locator(`button[title="Edit"]`).first();
		await expect(staffSidebarEdit).toBeVisible({ timeout: 5_000 });
		await staffSidebarEdit.click();
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain(`#/staff/${staff.id}`);

		const goal = await createGoal({ title: `Session actions team ${Date.now()}`, team: false, worktree: false });
		goalsToDelete.add(goal.id as string);
		const teamLeadId = await startTeam(goal.id as string);
		teamsToTeardown.add(goal.id as string);
		sessionsToDelete.add(teamLeadId);
		await waitForSessionStatus(teamLeadId, "idle", 30_000);
		await openSession(page, teamLeadId, 30_000);

		expect(await actionLabel(page, "terminate")).toContain("End team");
		const teamHeaderIds = await headerActionIds(page);
		expect(teamHeaderIds).not.toContain("fork");
		await openSidebarActions(page, teamLeadId);
		await expect(popoverAction(page, "terminate")).toContainText("End team");
		expect(await popoverActionIds(page)).not.toContain("fork");
		await closePopover(page);
	});

	test("constrained desktop header hamburger opens the full menu and FLIP-animates every visible direct action", async ({ page }) => {
		await page.setViewportSize({ width: 1_000, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await openSession(page, sessionId);

		const directIds = await visibleHeaderDirectActionIds(page);
		expect(directIds.length, "constrained desktop should render more than two direct actions before overflowing the rest").toBeGreaterThan(2);
		expect(directIds.length, "constrained desktop should not render every action directly").toBeLessThan(CANONICAL_SESSION_ACTION_IDS.length);
		expectCanonicalOrder(directIds);
		expect(directIds, "the constrained desktop reproducer must include a non-quick direct action").toContain("refresh-agent");

		await installActionAnimationRecorder(page, "__desktopHeaderActionAnimations");
		await expect(headerTrigger(page), "overflow trigger should expose the complete header action menu").toBeVisible({ timeout: 5_000 });
		await openHeaderActions(page);
		const popoverIds = await popoverActionIds(page);
		expect(
			canonicalSessionActionIds(popoverIds),
			"header hamburger popover should contain the full canonical session action list, including direct buttons",
		).toEqual([...CANONICAL_SESSION_ACTION_IDS]);
		expect(await popoverSourceActionIds(page), "desktop header hamburger should capture every visible direct action as a FLIP source").toEqual(expect.arrayContaining(directIds));
		await expectPopoverTranslateAnimationsForActionIds(
			page,
			"__desktopHeaderActionAnimations",
			directIds,
			"desktop header hamburger should animate each visible direct action into its matching popover row",
		);
		for (const actionId of directIds) {
			await expectHeaderDirectActionHiddenAndNonInteractive(page, actionId, `desktop header ${actionId} direct action`);
		}

		await closePopover(page);
		for (const actionId of directIds) {
			await expect(headerDirectAction(page, actionId), `desktop header ${actionId} direct action should return after close`).toBeVisible({ timeout: 5_000 });
		}
	});

	test("mobile session header shows icon-only quick actions and opens the remaining menu with FLIP sources", async ({ page }) => {
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await openSession(page, sessionId);
		await page.setViewportSize({ width: 375, height: 667 });

		await expect(page.getByTitle("Back to session list")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".mobile-header-title").first()).toBeVisible({ timeout: 5_000 });
		await expect(headerTrigger(page), "mobile session view must expose the unified session actions menu").toBeVisible({ timeout: 5_000 });

		const directIds = await page.locator(HEADER_ACTION_SELECTOR).evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.sessionActionId || "").filter(Boolean),
		);
		expect(directIds, "mobile header should render exactly the icon-only quick actions next to the hamburger").toEqual(["modify", "terminate"]);
		const quickButtons = {
			modify: headerDirectAction(page, "modify"),
			terminate: headerDirectAction(page, "terminate"),
		};
		for (const actionId of ["modify", "terminate"] as const) {
			const button = quickButtons[actionId];
			await expect(button, `${actionId} quick action should be visible in the mobile header`).toBeVisible({ timeout: 5_000 });
			await expect(button).toHaveAttribute("aria-label", actionId === "modify" ? /Edit|Modify/ : /Terminate|End team/);
			const visibleLabelText = await button.evaluate((el) => {
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
				const visible: string[] = [];
				while (walker.nextNode()) {
					const node = walker.currentNode as Text;
					const text = node.textContent?.trim();
					if (!text) continue;
					const parent = node.parentElement;
					if (!parent) continue;
					const style = getComputedStyle(parent);
					if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
					const range = document.createRange();
					range.selectNodeContents(node);
					const rect = range.getBoundingClientRect();
					range.detach();
					if (rect.width > 2 && rect.height > 2) visible.push(text);
				}
				return visible.join(" ");
			});
			expect(visibleLabelText, `${actionId} quick action should not expose a visible text label on mobile`).toBe("");
		}

		await installActionAnimationRecorder(page, "__mobileHeaderActionAnimations");

		await openHeaderActions(page);
		const popoverIds = await popoverActionIds(page);
		expect(
			canonicalSessionActionIds(popoverIds),
			"mobile header hamburger popover should contain the full canonical session action list",
		).toEqual([...CANONICAL_SESSION_ACTION_IDS]);
		await expectHeaderDirectActionHiddenAndNonInteractive(page, "modify", "mobile header modify quick action");
		await expectHeaderDirectActionHiddenAndNonInteractive(page, "terminate", "mobile header terminate quick action");
		const sourceIds = await popoverSourceActionIds(page);
		expect(sourceIds, "mobile header hamburger should capture quick-action source rects for FLIP").toEqual(expect.arrayContaining(["modify", "terminate"]));
		await expectPopoverTranslateAnimationsForActionIds(
			page,
			"__mobileHeaderActionAnimations",
			["modify", "terminate"],
			"mobile header hamburger should animate visible quick actions into their matching popover rows",
		);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow, "mobile header must not create horizontal document overflow").toBeLessThanOrEqual(1);

		await closePopover(page);
		await expect(quickButtons.modify, "mobile header modify quick action should return after close").toBeVisible({ timeout: 5_000 });
		await expect(quickButtons.terminate, "mobile header terminate quick action should return after close").toBeVisible({ timeout: 5_000 });
	});

	test("fork trailing toggle is keyboard-accessible and does not fire fork until the row action runs", async ({ page }) => {
		await page.setViewportSize({ width: 820, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		const forkedId = "11111111-2222-3333-4444-555555555555";

		await page.route(`**/api/sessions/${sessionId}/fork`, async (route) => {
			const body = route.request().postDataJSON?.() ?? {};
			await page.evaluate((payload) => {
				(window as any).__sessionActionForkBodies = [...((window as any).__sessionActionForkBodies || []), payload];
			}, body);
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({ id: forkedId, cwd: "/tmp/fork", status: "idle", title: "Fork: Source", projectId: "p" }),
			});
		});
		await openSession(page, sessionId);
		await page.evaluate(() => { (window as any).__sessionActionForkBodies = []; });
		await openHeaderActions(page);

		const forkRow = popoverAction(page, "fork");
		const checkbox = page.locator(`sidebar-actions-popover [role="menuitemcheckbox"][data-session-action-id="fork"]`).first();
		await expect(forkRow).toBeVisible({ timeout: 5_000 });
		await expect(checkbox).toBeVisible({ timeout: 5_000 });
		await expect(checkbox).toHaveAttribute("aria-checked", "true");

		await checkbox.focus();
		await expect(checkbox).toBeFocused();
		await page.keyboard.press(" ");
		await expect(checkbox).toHaveAttribute("aria-checked", "false");
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
		expect(await page.evaluate(() => (window as any).__sessionActionForkBodies)).toEqual([]);

		await page.keyboard.press("Enter");
		await expect(checkbox).toHaveAttribute("aria-checked", "true");
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
		expect(await page.evaluate(() => (window as any).__sessionActionForkBodies)).toEqual([]);

		await forkRow.click();
		await expect.poll(() => page.evaluate(() => (window as any).__sessionActionForkBodies), { timeout: 10_000 }).toEqual([{ newWorktree: true }]);
	});

	test("copy link, system prompt, and open-in-new-window are reachable from header actions", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await openSession(page, sessionId);
		await page.evaluate(() => {
			(window as any).__sessionActionOpenedUrls = [];
			window.open = ((url?: string | URL) => {
				(window as any).__sessionActionOpenedUrls.push(String(url || ""));
				return null;
			}) as typeof window.open;
		});

		await clickHeaderAction(page, "copy-link");
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toBe(`${base()}/#/session/${sessionId}`);

		await clickHeaderAction(page, "view-system-prompt");
		await expect(page.locator("system-prompt-dialog").getByText("System Prompt Inspector")).toBeVisible({ timeout: 10_000 });
		await page.locator("system-prompt-dialog").evaluate((el) => el.remove());

		await clickHeaderAction(page, "open-new-window");
		await expect.poll(() => page.evaluate(() => (window as any).__sessionActionOpenedUrls), { timeout: 5_000 }).toEqual([
			`${base()}/#/session/${sessionId}`,
		]);
	});
});
