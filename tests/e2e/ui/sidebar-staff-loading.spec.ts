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
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar +Staff loading feedback", () => {
	test("shows bobbit-loader immediately on click", async ({ page }) => {
		await openApp(page);

		// The Staff section header is always rendered, and the "+" button
		// inside it has title="New staff agent".
		const newStaffBtn = page.locator("button[title='New staff agent']").first();
		await expect(newStaffBtn).toBeVisible({ timeout: 10_000 });

		// Click and immediately assert the loader is visible — must appear
		// within one render frame (before navigation completes).
		await newStaffBtn.click();
		await expect(page.locator("[data-testid='bobbit-loader']")).toBeVisible({
			timeout: 2_000,
		});

		// Wait for navigation to complete and verify a staff assistant session was created.
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 10_000 });

		// Clean up the created session.
		const hash = await page.evaluate(() => window.location.hash);
		const m = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (m) await apiFetch(`/api/sessions/${m[1]}`, { method: "DELETE" }).catch(() => {});
	});
});
