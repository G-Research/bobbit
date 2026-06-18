/**
 * Sidebar session actions E2E smokes — the start-team/start-one action matrix now
 * lives in tests/ui-fixtures/sidebar-navigation-fixture.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	apiFetch,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar session actions", () => {
	const sessionIds: string[] = [];

	test.afterAll(async () => {
		for (const id of sessionIds) await deleteSession(id).catch(() => {});
	});

	test("SB-14/SB-19: New session button creates a session and rename persists", async ({ page }) => {
		await openApp(page);
		await page.locator("button[title^='New session']").first().click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });

		const hash = await page.evaluate(() => window.location.hash);
		const match = hash.match(/#\/session\/([a-f0-9-]+)/i);
		expect(match).toBeTruthy();
		const sessionId = match![1];
		sessionIds.push(sessionId);

		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();
		const renameBtn = sessionRow.getByRole("button", { name: "Modify", exact: true });
		await expect(renameBtn).toBeVisible({ timeout: 5_000 });
		await renameBtn.click();

		await expect(page.getByText("Edit Session").first()).toBeVisible({ timeout: 5_000 });
		const titleInput = page.locator("input[placeholder='Session title…']").first();
		await expect(titleInput).toBeVisible({ timeout: 5_000 });
		await titleInput.fill("Renamed Session E2E");
		await titleInput.press("Enter");
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });
	});

	test("SB-20: terminate button removes session from sidebar @smoke", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();

		const trashBtn = sessionRow.locator("button[title*='Terminate']");
		await expect(trashBtn).toBeVisible({ timeout: 5_000 });
		await trashBtn.click();

		const backdrop = page.locator(".fixed.inset-0").first();
		await expect(backdrop).toBeVisible({ timeout: 5_000 });
		await backdrop.locator("button").filter({ hasText: "Terminate" }).click();

		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).not.toContain(sessionId);
		}).toPass({ timeout: 5_000 });

		await deleteSession(sessionId);
		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const sessions = ((await resp.json()).sessions || []);
			expect(sessions.find((s: { id: string }) => s.id === sessionId)).toBeFalsy();
		}).toPass({ timeout: 10_000 });
	});
});
