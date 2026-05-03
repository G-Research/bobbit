// Browser E2E coverage for PWA Resume v2 §F (relanded A1/A3/A4).
//
// Verifies:
//  - After authentication, state.gatewaySessions hydrates without the previous
//    awaited bootstrap step. Consumers that need the list use the hydration
//    latch; tests use the `waitForGatewaySessions` helper.
//  - Navigating directly to a non-existent /session/<uuid> hash surfaces the
//    new dedicated session-not-found view (data-testid="session-not-found-view")
//    instead of the previous /api/sessions/:id existence-probe redirect.
//  - The "Back to sessions" button on the not-found view returns to landing.
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, waitForGatewaySessions } from "./ui-helpers.js";

test.describe("PWA Resume v2 §F — relanded A1/A3/A4", () => {
	test("session list hydrates after auth (waitForGatewaySessions helper resolves)", async ({ page }) => {
		await openApp(page);
		// Create one session so we have something to hydrate
		await createSessionViaUI(page);
		// Reload to exercise the post-auth hydration latch path on a warm tab.
		await page.reload();
		await waitForGatewaySessions(page, 1, 15_000);
		const len = await page.evaluate(() => (window as any).bobbitState?.gatewaySessions?.length ?? 0);
		expect(len).toBeGreaterThanOrEqual(1);
	});

	test("direct nav to non-existent /session/<id> renders session-not-found view", async ({ page }) => {
		await openApp(page);
		// Use a syntactically valid but non-existent UUID.
		const fakeId = "deadbeef-1234-1234-1234-deadbeefcafe";
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, fakeId);
		await expect(page.locator("[data-testid='session-not-found-view']"))
			.toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Session not found").first()).toBeVisible();

		// Click the back button — the view goes away and we land on the
		// authenticated empty state.
		await page.getByRole("button", { name: /back to sessions/i }).click();
		await expect(page.locator("[data-testid='session-not-found-view']"))
			.toHaveCount(0, { timeout: 5_000 });
	});
});
