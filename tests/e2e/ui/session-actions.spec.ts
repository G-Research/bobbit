import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
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

async function openSession(page: Page, sessionId: string): Promise<Locator> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 10_000 });
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
	const trigger = headerTrigger(page);
	await expect(trigger).toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
}

async function closePopover(page: Page): Promise<void> {
	if (await page.locator("sidebar-actions-popover").count()) {
		await page.keyboard.press("Escape");
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
	}
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

function expectCanonicalOrder(ids: string[], expected = CANONICAL_SESSION_ACTION_IDS): void {
	expect(ids).toEqual(expected.filter((id) => ids.includes(id)));
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
	const direct = headerDirectAction(page, actionId);
	if (await direct.isVisible().catch(() => false)) {
		await direct.click();
		return;
	}
	await openHeaderActions(page);
	const item = popoverAction(page, actionId);
	await expect(item).toBeVisible({ timeout: 5_000 });
	await item.click();
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

	test("sidebar and header expose the same canonical action ids in priority order", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openSession(page, sessionId);

		await openSidebarActions(page, sessionId);
		const sidebarIds = await popoverActionIds(page);
		await closePopover(page);

		const headerIds = await headerActionIds(page);
		expect(sidebarIds).toEqual(CANONICAL_SESSION_ACTION_IDS);
		expect(headerIds).toEqual(sidebarIds);
		expectCanonicalOrder(headerIds);
	});

	test("staff and team-lead sessions keep canonical labels and visibility", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 900 });

		const staff = await createStaffAgent(`ActionsBot-${Date.now()}`);
		staffToDelete.add(staff.id);
		const staffSessionId = await waitForStaffSession(staff.id);
		sessionsToDelete.add(staffSessionId);
		await waitForSessionStatus(staffSessionId, "idle", 30_000);
		await openSession(page, staffSessionId);

		expect(await actionLabel(page, "modify")).toContain("Edit staff");
		await openSidebarActions(page, staffSessionId);
		await expect(popoverAction(page, "modify")).toContainText("Edit staff");
		await closePopover(page);
		await clickHeaderAction(page, "modify");
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain(`#/staff/${staff.id}`);

		const goal = await createGoal({ title: `Session actions team ${Date.now()}`, team: false, worktree: false });
		goalsToDelete.add(goal.id as string);
		const teamLeadId = await startTeam(goal.id as string);
		teamsToTeardown.add(goal.id as string);
		sessionsToDelete.add(teamLeadId);
		await waitForSessionStatus(teamLeadId, "idle", 30_000);
		await openSession(page, teamLeadId);

		expect(await actionLabel(page, "terminate")).toContain("End team");
		const teamHeaderIds = await headerActionIds(page);
		expect(teamHeaderIds).not.toContain("fork");
		await openSidebarActions(page, teamLeadId);
		await expect(popoverAction(page, "terminate")).toContainText("End team");
		expect(await popoverActionIds(page)).not.toContain("fork");
		await closePopover(page);
	});

	test("desktop header overflows lower-priority actions into the hamburger at constrained width", async ({ page }) => {
		await page.setViewportSize({ width: 820, height: 900 });
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await openSession(page, sessionId);

		const directIds = await page.locator(HEADER_ACTION_SELECTOR).evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.sessionActionId || "").filter(Boolean),
		);
		expect(directIds.length, "constrained desktop should not render every action directly").toBeLessThan(CANONICAL_SESSION_ACTION_IDS.length);
		expectCanonicalOrder(directIds);

		await expect(headerTrigger(page), "overflow trigger should expose hidden header actions").toBeVisible({ timeout: 5_000 });
		await openHeaderActions(page);
		const overflowIds = await popoverActionIds(page);
		const combinedIds = uniqueInOrder([...directIds, ...overflowIds]);
		expect(combinedIds).toEqual(CANONICAL_SESSION_ACTION_IDS);
		expect(overflowIds, "overflow should contain actions that were not direct buttons").toEqual(
			expect.arrayContaining(CANONICAL_SESSION_ACTION_IDS.filter((id) => !directIds.includes(id))),
		);
	});

	test("mobile session header keeps back/title usable and exposes full actions through hamburger", async ({ page }) => {
		const sessionId = await createSession();
		sessionsToDelete.add(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await openSession(page, sessionId);
		await page.setViewportSize({ width: 375, height: 667 });

		await expect(page.getByTitle("Back to session list")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".mobile-header-title").first()).toBeVisible({ timeout: 5_000 });
		await expect(headerTrigger(page), "mobile session view must expose the unified session actions menu").toBeVisible({ timeout: 5_000 });
		await expect(page.locator(HEADER_ACTION_SELECTOR), "mobile should suppress individual header action buttons").toHaveCount(0);

		await openHeaderActions(page);
		expect(await popoverActionIds(page)).toEqual(CANONICAL_SESSION_ACTION_IDS);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow, "mobile header must not create horizontal document overflow").toBeLessThanOrEqual(1);
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
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toContain(`#/session/${sessionId}`);

		await clickHeaderAction(page, "view-system-prompt");
		await expect(page.locator("system-prompt-dialog").getByText("System Prompt Inspector")).toBeVisible({ timeout: 10_000 });
		await page.locator("system-prompt-dialog").evaluate((el) => el.remove());

		await clickHeaderAction(page, "open-new-window");
		await expect.poll(() => page.evaluate(() => (window as any).__sessionActionOpenedUrls), { timeout: 5_000 }).toEqual([
			expect.stringContaining(`#/session/${sessionId}`),
		]);
	});
});
