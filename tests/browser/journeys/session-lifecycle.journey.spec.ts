/**
 * Retained session lifecycle smoke.
 *
 * CRUD routes are covered by session-lifecycle-api.gateway.test.ts; action
 * eligibility/copy/fork UI is covered by session-actions and fork-history
 * fixtures. Keep one real WebSocket turn plus transcript/sidebar reload.
 */
import {
	test,
	expect,
	openApp,
	navigateToHash,
	createSession,
	createSessionViaUI,
	deleteSession,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";

async function openModifySessionRole(page: import("@playwright/test").Page, sessionId: string) {
	const row = page.locator(`[data-session-id="${sessionId}"]`).first();
	await expect(row).toBeVisible({ timeout: 20_000 });
	await row.hover();
	const modify = row.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]').first();
	await expect(modify).toBeVisible({ timeout: 15_000 });
	await modify.click();
	const roleControl = page.locator('#role-picker-container button[title="Select role"]').first();
	await expect(roleControl).toBeVisible({ timeout: 15_000 });
	return roleControl;
}

test.describe("Journey: Session Lifecycle — retained full-stack smoke", () => {
	test("WebSocket turn and session route survive a durable page reload", async ({ page }) => {
		const sessionId = await createSession();
		const marker = `SESSION_RELOAD_${Date.now()}`;
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill(marker);
			await editor.press("Enter");
			await expect(page.locator("user-message").filter({ hasText: marker }).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("user-message").filter({ hasText: marker }).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("standard session role stays General across reload and both picker surfaces", async ({ page }) => {
		let sessionId = "";
		try {
			await openApp(page);
			sessionId = await createSessionViaUI(page);
			await waitForSessionStatus(sessionId, "idle");

			let roleControl = await openModifySessionRole(page, sessionId);
			await expect(roleControl).toContainText("General");
			await page.getByRole("button", { name: "Cancel" }).click();

			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			roleControl = await openModifySessionRole(page, sessionId);
			await expect(roleControl).toContainText("General");
			await page.getByRole("button", { name: "Cancel" }).click();

			const newSessionWithRole = page.locator('button[title="New session with role"]').first();
			if (await newSessionWithRole.count() === 0) {
				const projectHeader = page.locator('[data-testid="project-header"]').first();
				await expect(projectHeader).toBeVisible({ timeout: 15_000 });
				await projectHeader.click();
			}
			await expect(newSessionWithRole).toBeVisible({ timeout: 15_000 });
			await newSessionWithRole.click();
			const pickerPanel = page.locator("div.fixed.z-50")
				.filter({ has: page.locator("#picker-role-container") })
				.last();
			await expect(pickerPanel).toBeVisible({ timeout: 15_000 });
			const pickerRole = pickerPanel.locator('#picker-role-container button[title="Select role"]');
			await expect(pickerRole).toContainText("General");
			await pickerRole.click();
			await expect(pickerPanel.locator('#picker-role-container button[title="Select General role"]')).toBeVisible();
			await expect(pickerPanel.locator('#picker-role-container button[title="No role"]')).toHaveCount(0);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
		}
	});
});
