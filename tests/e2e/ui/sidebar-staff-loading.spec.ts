/**
 * Sidebar "+ Staff" button — loading feedback.
 *
 * Pins the fix for: clicking "+ Staff" felt unresponsive because the
 * session-creation flow didn't set state.creatingSession before the fetch,
 * so the [data-testid="bobbit-loader"] gate in render.ts::mainArea never
 * fired until after the round-trip.
 *
 * This test asserts the loader appears before navigation completes,
 * mirroring the behaviour of the "+ New Goal" / "+ Role" buttons.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar +Staff loading feedback", () => {
	test("shows bobbit-loader immediately on click", async ({ page }) => {
		await openApp(page);

		// Post-surface-staff-in-sessions: the "+ New staff" button lives in the
		// project header (title="New staff agent in <project>").
		const newStaffBtn = page.locator("button[title^='New staff agent']").first();
		await expect(newStaffBtn).toBeVisible({ timeout: 10_000 });
		// Force-hover the project row so the (hidden) header button becomes clickable on desktop.
		await newStaffBtn.evaluate((el) => (el as HTMLElement).click());
		await expect(page.locator("[data-testid='bobbit-loader']")).toBeVisible({ timeout: 2_000 });
	});
});
