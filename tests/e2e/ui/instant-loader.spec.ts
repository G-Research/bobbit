/**
 * Browser E2E — instant loader on session creation.
 *
 * When the user clicks a session-creation entry point from any non-session
 * route, the bouncing-bobbit loader must appear while POST /api/sessions is
 * still in-flight, regardless of how long the POST takes.
 *
 * Regression contract: the loader gate lives at the TOP of `mainArea()` in
 * src/app/render.ts (testid `bobbit-loader`), not inside any single route
 * branch.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Instant loader on session create", () => {
	test("splash 'New Session' click shows bobbit-loader while POST is in-flight", async ({ page }) => {
		await openApp(page);

		// Wait for the splash to be ready (default harness-registered project → 1 project → "New Session").
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 20_000 });
		await expect(splashLabel).toContainText("New Session");

		// Hold the create-session POST open until after the loader assertion. This
		// avoids brittle wall-clock timing while still proving the loader is visible
		// before the response can complete. A regression that waits for POST to
		// return before showing the loader will time out below.
		let releasePost!: () => void;
		let postReleased = false;
		const releasePostPromise = new Promise<void>((resolve) => {
			releasePost = () => {
				postReleased = true;
				resolve();
			};
		});
		await page.route("**/api/sessions", async (route) => {
			if (route.request().method() !== "POST") {
				return route.fallback();
			}
			await releasePostPromise;
			return route.fallback();
		});

		const postStarted = page.waitForRequest(
			(request) => request.url().includes("/api/sessions") && request.method() === "POST",
			{ timeout: 10_000 },
		);
		await splashLabel.click();
		await postStarted;

		const loader = page.locator('[data-testid="bobbit-loader"]').first();
		try {
			await expect(
				loader,
				"bobbit-loader should be visible before POST /api/sessions is allowed to complete",
			).toBeVisible({ timeout: 1_000 });
			expect(postReleased).toBe(false);
		} finally {
			releasePost();
		}
	});
});
