import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	base,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.describe.configure({ mode: "serial" });

const ARCHIVED_SAFE_ACTION_IDS = [
	"continue-archived",
	"copy-link",
	"view-system-prompt",
	"open-new-window",
] as const;
const ARCHIVED_ACTION_LABELS: Record<typeof ARCHIVED_SAFE_ACTION_IDS[number], string> = {
	"continue-archived": "Continue in new session",
	"copy-link": "Copy link",
	"view-system-prompt": "View System Prompt",
	"open-new-window": "Open in new window",
};
const ARCHIVED_READ_ONLY_ACTION_IDS = ARCHIVED_SAFE_ACTION_IDS.filter((id) => id !== "continue-archived");
const FORBIDDEN_LABELS = [
	"Modify",
	"Terminate",
	"End team",
	"Refresh agent",
	"Fork",
	"PR Walkthrough",
	"Open Terminal",
] as const;

function sessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function sidebarTrigger(row: Locator, sessionId: string): Locator {
	return row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
}

function menuItem(page: Page, actionId: string): Locator {
	return page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="${actionId}"]`).first();
}

function headerTrigger(page: Page): Locator {
	return page.locator(`[data-testid="session-actions-trigger"]`).first();
}

async function createArchivedSession(): Promise<string> {
	const sessionId = await createSession();
	await waitForSessionStatus(sessionId, "idle");
	const resp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
	expect(resp.ok, `archive session ${sessionId}`).toBe(true);
	await expect.poll(async () => {
		const archived = await apiFetch(`/api/sessions/${sessionId}?include=archived`);
		if (!archived.ok) return false;
		const body = await archived.json() as { archived?: boolean; status?: string };
		return body.archived === true || body.status === "archived" || body.status === "terminated";
	}, { timeout: 15_000 }).toBe(true);
	return sessionId;
}

async function createIneligibleArchivedSession(): Promise<{ sessionId: string; goalId: string }> {
	const goal = await createGoal({ title: "Archived actions ineligible goal fixture" });
	const goalId = String(goal.id);
	const sessionId = await createSession({ goalId });
	await waitForSessionStatus(sessionId, "idle");
	const resp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
	expect(resp.ok, `archive goal-linked session ${sessionId}`).toBe(true);
	await expect.poll(async () => {
		const archived = await apiFetch(`/api/sessions/${sessionId}?include=archived`);
		if (!archived.ok) return false;
		const body = await archived.json() as { archived?: boolean; goalId?: string };
		return body.archived === true && body.goalId === goalId;
	}, { timeout: 15_000 }).toBe(true);
	return { sessionId, goalId };
}

async function showArchivedInSidebar(page: Page): Promise<void> {
	const appLoaded = await page.locator("button").filter({ hasText: "Settings" }).first().isVisible().catch(() => false);
	if (!appLoaded) await openApp(page);
	const alreadyShown = await page.evaluate(() => (window as any).bobbitState?.showArchived === true).catch(() => false);
	if (!alreadyShown) {
		await page.getByTestId("sidebar-filters-button").click();
		await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible({ timeout: 5_000 });
		await page.getByTestId("sidebar-filter-archived").locator('input[type="checkbox"]').check();
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.showArchived === true), { timeout: 10_000 }).toBe(true);
	}
}

async function ensureArchivedRowVisible(page: Page, sessionId: string): Promise<Locator> {
	await expect.poll(() => page.evaluate((id) => {
		const sessions = (window as any).bobbitState?.archivedSessions ?? [];
		return sessions.some((s: { id?: string }) => s.id === id);
	}, sessionId), { timeout: 15_000 }).toBe(true);

	const row = sessionRow(page, sessionId);
	if (!(await row.isVisible().catch(() => false))) {
		const headers = page.locator('[data-nav-id^="archived-header:"]');
		const count = await headers.count();
		for (let i = 0; i < count; i++) {
			const header = headers.nth(i);
			if (!(await header.isVisible().catch(() => false))) continue;
			await header.click();
			if (await row.isVisible().catch(() => false)) break;
		}
	}
	await expect(row, `archived row ${sessionId}`).toBeVisible({ timeout: 10_000 });
	return row;
}

async function openArchivedSidebarMenu(page: Page, sessionId: string): Promise<void> {
	const menu = page.locator("sidebar-actions-popover [role='menu']");
	let lastError: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		const row = await ensureArchivedRowVisible(page, sessionId);
		const trigger = sidebarTrigger(row, sessionId);
		try {
			// Keyboard focus exposes the desktop action cluster without depending on a
			// hover target that can be replaced by an asynchronous sidebar render.
			await trigger.focus({ timeout: 1_000 });
			await trigger.press("Enter", { timeout: 1_000 });
			await expect(menu).toBeVisible({ timeout: 1_000 });
			return;
		} catch (error) {
			lastError = error;
			if (await menu.isVisible().catch(() => false)) return;
		}
	}
	throw lastError;
}

async function openHeaderMenu(page: Page): Promise<void> {
	const trigger = headerTrigger(page);
	await expect(trigger, "archived header actions trigger should be visible").toBeVisible({ timeout: 10_000 });
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
	return page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id]').evaluateAll((els) =>
		els.map((el) => (el as HTMLElement).dataset.sessionActionId || "").filter(Boolean),
	);
}

async function popoverLabels(page: Page): Promise<string[]> {
	return page.locator('sidebar-actions-popover [role="menuitem"]').evaluateAll((els) =>
		els.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
	);
}

async function expectArchivedSafeMenu(page: Page, expectedIds: readonly string[] = ARCHIVED_SAFE_ACTION_IDS): Promise<void> {
	expect(await popoverActionIds(page)).toEqual([...expectedIds]);
	const labels = await popoverLabels(page);
	const expectedLabels = expectedIds.map((id) => ARCHIVED_ACTION_LABELS[id as typeof ARCHIVED_SAFE_ACTION_IDS[number]]);
	expect(labels).toEqual(expectedLabels);
	for (const forbidden of FORBIDDEN_LABELS) {
		expect(labels.join("\n"), `${forbidden} must not appear in archived session menus`).not.toContain(forbidden);
	}
}

async function openArchivedSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(headerTrigger(page), "archived session header actions should render after read-only open").toBeVisible({ timeout: 15_000 });
	await expect.poll(() => page.evaluate(() => {
		const s = (window as any).bobbitState;
		return {
			selected: s?.selectedSessionId ?? null,
			readOnly: s?.chatPanel?.agentInterface?.readOnly === true,
		};
	}), { timeout: 15_000 }).toEqual({ selected: sessionId, readOnly: true });
}

async function stubWindowOpen(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as any).__opened = [];
		window.open = ((url?: string | URL, target?: string, features?: string) => {
			(window as any).__opened.push({
				url: url === undefined ? undefined : String(url),
				target: target === undefined ? undefined : String(target),
				features: features === undefined ? undefined : String(features),
			});
			return { opener: null } as any;
		}) as any;
	});
}

test.describe("archived session actions", () => {
	const sessionsToDelete = new Set<string>();
	const goalsToDelete = new Set<string>();

	test.afterAll(async () => {
		for (const sessionId of sessionsToDelete) await deleteSession(sessionId).catch(() => {});
		for (const goalId of goalsToDelete) await deleteGoal(goalId).catch(() => {});
	});

	test("desktop sidebar and header expose only archived-safe actions", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const archivedId = await createArchivedSession();
		const activeId = await createSession();
		sessionsToDelete.add(archivedId);
		sessionsToDelete.add(activeId);
		await waitForSessionStatus(activeId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${activeId}`);
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? null), {
			message: "active session should finish loading before archived sidebar interactions",
			timeout: 15_000,
		}).toBe(activeId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await showArchivedInSidebar(page);

		const { hashBefore, selectedBefore } = await page.evaluate(() => ({
			hashBefore: window.location.hash,
			selectedBefore: (window as any).bobbitState?.selectedSessionId ?? null,
		}));
		await openArchivedSidebarMenu(page, archivedId);
		await expectArchivedSafeMenu(page);
		await expect.poll(() => page.evaluate(() => window.location.hash), { message: "archived sidebar hamburger must not navigate" }).toBe(hashBefore);
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? null), { message: "archived sidebar hamburger must not select the row" }).toBe(selectedBefore);

		await menuItem(page, "copy-link").click();
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toBe(`${base()}/#/session/${archivedId}`);
		await expect.poll(() => page.evaluate(() => window.location.hash), { message: "copy link must not navigate" }).toBe(hashBefore);
		await closePopover(page);

		await stubWindowOpen(page);
		await openArchivedSidebarMenu(page, archivedId);
		await menuItem(page, "open-new-window").click();
		await expect.poll(() => page.evaluate(() => (window as any).__opened), { timeout: 5_000 }).toEqual([
			{ url: `${base()}/#/session/${archivedId}`, target: "_blank", features: "noopener" },
		]);
		await expect.poll(() => page.evaluate(() => window.location.hash), { message: "open in new window must not navigate in-place" }).toBe(hashBefore);
		await closePopover(page);

		const archivedRow = await ensureArchivedRowVisible(page, archivedId);
		await archivedRow.click();
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toContain(`#/session/${archivedId}`);
		await expect.poll(() => page.evaluate((id) => {
			const s = (window as any).bobbitState;
			return s?.selectedSessionId === id && s?.chatPanel?.agentInterface?.readOnly === true;
		}, archivedId), { timeout: 15_000 }).toBe(true);

		await openHeaderMenu(page);
		await expectArchivedSafeMenu(page);
	});

	test("mobile archived header menu exposes the same safe actions", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		const archivedId = await createArchivedSession();
		sessionsToDelete.add(archivedId);

		await openApp(page);
		await openArchivedSession(page, archivedId);
		await openHeaderMenu(page);
		await expectArchivedSafeMenu(page);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow, "mobile archived header menu must not create horizontal overflow").toBeLessThanOrEqual(1);
	});

	test("ineligible archived sessions hide Continue but keep read-only actions", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { sessionId: ineligibleId, goalId } = await createIneligibleArchivedSession();
		sessionsToDelete.add(ineligibleId);
		goalsToDelete.add(goalId);

		await showArchivedInSidebar(page);
		if (!(await sessionRow(page, ineligibleId).isVisible().catch(() => false))) {
			await page.locator(`[data-nav-id="goal:${goalId}"]`).first().click();
		}
		await openArchivedSidebarMenu(page, ineligibleId);
		await expectArchivedSafeMenu(page, ARCHIVED_READ_ONLY_ACTION_IDS);
		await expect(menuItem(page, "continue-archived"), "goal-linked archived sessions must not offer Continue").toHaveCount(0);
	});
});
