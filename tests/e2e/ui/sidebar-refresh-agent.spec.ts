import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Sidebar Refresh agent action", () => {
	const sessionIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	test.afterAll(async () => {
		for (const id of sessionIds.splice(0)) await deleteSession(id).catch(() => {});
	});

	function sessionRow(page: Page, sessionId: string): Locator {
		return page.locator(`[data-session-id="${sessionId}"]`).first();
	}

	function triggerFor(row: Locator, sessionId: string): Locator {
		return row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
	}

	function refreshMenuItem(page: Page): Locator {
		return page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="refresh-agent"]').first();
	}

	async function renameSession(sessionId: string, title: string): Promise<void> {
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		});
		expect(resp.ok, `renaming ${sessionId} should succeed`).toBeTruthy();
	}

	async function createIdleSession(title: string): Promise<string> {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await renameSession(sessionId, title);
		await waitForSessionStatus(sessionId, "idle");
		return sessionId;
	}

	async function openSession(page: Page, sessionId: string): Promise<Locator> {
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		const row = sessionRow(page, sessionId);
		await expect(row).toBeVisible({ timeout: 10_000 });
		return row;
	}

	async function openMenu(row: Locator, sessionId: string): Promise<void> {
		await expect(row).toBeVisible({ timeout: 10_000 });
		const trigger = triggerFor(row, sessionId);
		await row.hover();
		await expect(trigger, "session hamburger should appear on hover").toBeVisible({ timeout: 5_000 });
		await trigger.click();
		await expect(row.page().locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	}

	async function closeMenu(page: Page): Promise<void> {
		await page.keyboard.press("Escape");
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
	}

	async function patchClientSession(page: Page, sessionId: string, patch: Record<string, unknown>): Promise<void> {
		await page.evaluate(({ id, patch }) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			if (!state?.gatewaySessions) throw new Error("missing bobbit gatewaySessions state");
			const idx = state.gatewaySessions.findIndex((s: any) => s.id === id);
			if (idx < 0) throw new Error(`missing session ${id}`);
			state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], ...patch };
			(window as any).__bobbitRenderApp?.();
		}, { id: sessionId, patch });
	}

	async function expectRefreshHiddenForPatchedSession(page: Page, row: Locator, sessionId: string): Promise<void> {
		const trigger = triggerFor(row, sessionId);
		await row.hover();
		if (await trigger.isVisible().catch(() => false)) {
			await trigger.click();
			await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
			await expect(refreshMenuItem(page), "Refresh agent must not appear for ineligible sessions").toHaveCount(0, { timeout: 15_000 });
			await closeMenu(page);
		} else {
			await expect(trigger, "ineligible sessions may hide the whole action trigger").not.toBeVisible();
		}
	}

	test("eligible live session menu shows exact non-quick Refresh agent item", async ({ page }) => {
		const sessionId = await createIdleSession(`Refresh eligible ${Date.now()}`);
		const row = await openSession(page, sessionId);

		await row.hover();
		await expect(
			row.locator('[data-sidebar-action-id="refresh-agent"][data-sidebar-action-quick="true"]'),
			"Refresh agent must be hamburger-only, not a quick action",
		).toHaveCount(0);

		await openMenu(row, sessionId);
		const item = refreshMenuItem(page);
		await expect(item).toBeVisible({ timeout: 5_000 });
		await expect.poll(async () => (await item.textContent() || "").replace(/\s+/g, " ").trim()).toBe("Refresh agent");
	});

	test("inactive session row refresh posts to that exact session id and shows feedback", async ({ page }) => {
		const activeId = await createIdleSession(`Refresh active ${Date.now()}`);
		const inactiveId = await createIdleSession(`Refresh inactive ${Date.now()}`);
		await openSession(page, activeId);

		let releaseRestart!: () => void;
		const restartCanFinish = new Promise<void>((resolve) => { releaseRestart = resolve; });
		const restartPaths: string[] = [];
		await page.route("**/api/sessions/*/restart", async (route) => {
			const req = route.request();
			restartPaths.push(new URL(req.url()).pathname);
			await restartCanFinish;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, sessionId: inactiveId }),
			});
		});

		const inactiveRow = sessionRow(page, inactiveId);
		await openMenu(inactiveRow, inactiveId);
		const requestPromise = page.waitForRequest((req) => {
			const url = new URL(req.url());
			return req.method() === "POST" && url.pathname === `/api/sessions/${inactiveId}/restart`;
		});
		await refreshMenuItem(page).click();

		const toast = page.locator('[data-testid="header-toast"]').first();
		await expect(toast, "refresh should show visible pending feedback").toContainText(/Refreshing agent/i, { timeout: 5_000 });
		const req = await requestPromise;
		expect(req.method()).toBe("POST");
		expect(new URL(req.url()).pathname).toBe(`/api/sessions/${inactiveId}/restart`);
		expect(restartPaths).not.toContain(`/api/sessions/${activeId}/restart`);

		releaseRestart();
		await expect(toast, "refresh should leave visible refresh feedback after completion").toContainText(/refresh/i, { timeout: 5_000 });
	});

	test("refresh failure shows visible error feedback", async ({ page }) => {
		const sessionId = await createIdleSession(`Refresh error ${Date.now()}`);
		const row = await openSession(page, sessionId);
		let releaseFailure!: () => void;
		const failureCanFinish = new Promise<void>((resolve) => { releaseFailure = resolve; });
		await page.route(`**/api/sessions/${sessionId}/restart`, async (route) => {
			await failureCanFinish;
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "forced restart failure", code: "FORCED_REFRESH_FAILURE" }),
			});
		});

		await openMenu(row, sessionId);
		await refreshMenuItem(page).click();
		const toast = page.locator('[data-testid="header-toast"]').first();
		await expect(toast).toContainText(/Refreshing agent/i, { timeout: 5_000 });
		releaseFailure();
		await expect(toast, "restart failures must not be silent").toContainText(/fail|error|unable|could not/i, { timeout: 10_000 });
	});

	test("ineligible sessions hide Refresh agent and busy sessions are confirmation-guarded or disabled", async ({ page }) => {
		const ineligibleId = await createIdleSession(`Refresh ineligible ${Date.now()}`);
		const busyId = await createIdleSession(`Refresh busy ${Date.now()}`);
		const ineligibleRow = await openSession(page, ineligibleId);

		await patchClientSession(page, ineligibleId, { readOnly: true });
		await expectRefreshHiddenForPatchedSession(page, ineligibleRow, ineligibleId);

		await patchClientSession(page, ineligibleId, { readOnly: false, nonInteractive: true });
		await expectRefreshHiddenForPatchedSession(page, ineligibleRow, ineligibleId);

		await navigateToHash(page, `#/session/${busyId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		const busyRow = sessionRow(page, busyId);
		await patchClientSession(page, busyId, { status: "streaming" });
		let restartCalls = 0;
		await page.route(`**/api/sessions/${busyId}/restart`, async (route) => {
			restartCalls += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, sessionId: busyId }),
			});
		});

		await openMenu(busyRow, busyId);
		const item = refreshMenuItem(page);
		await expect(item, "busy sessions should keep Refresh agent visible but safe").toBeVisible({ timeout: 5_000 });
		const disabled = await item.evaluate((el) =>
			el.getAttribute("aria-disabled") === "true"
			|| el.hasAttribute("disabled")
			|| (el as HTMLButtonElement).disabled === true,
		);
		if (disabled) {
			const affordance = `${await item.textContent() || ""} ${await item.getAttribute("title") || ""}`;
			expect(affordance).toMatch(/busy|streaming|running|finish|wait|interrupt/i);
			expect(restartCalls).toBe(0);
		} else {
			await item.click();
			const dialog = page.locator(".fixed.inset-0, [role='dialog']").filter({ hasText: /Refresh agent|interrupt|restart/i }).last();
			await expect(dialog, "busy refresh must ask for confirmation before interrupting").toBeVisible({ timeout: 5_000 });
			expect(restartCalls, "opening the confirmation must not call restart yet").toBe(0);
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			expect(restartCalls, "cancel must not call restart").toBe(0);
		}
	});
});
