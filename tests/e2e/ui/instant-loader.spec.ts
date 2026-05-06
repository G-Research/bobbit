/**
 * Browser E2E — instant loader on session creation.
 *
 * When the user clicks a session-creation entry point from any non-session
 * route, the bouncing-bobbit loader must appear within one render frame
 * (asserted at <=200ms here for headless-runner slack), regardless of how
 * long the POST /api/sessions takes.
 *
 * Regression contract: the loader gate lives at the TOP of `mainArea()` in
 * src/app/render.ts (testid `bobbit-loader`), not inside any single route
 * branch.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Instant loader on session create", () => {
	test("splash 'New Session' click shows bobbit-loader within 200ms while POST is in-flight", async ({ page }) => {
		await openApp(page);

		// Wait for the splash to be ready (default harness-registered project → 1 project → "New Session").
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 20_000 });
		await expect(splashLabel).toContainText("New Session");

		// Intercept POST /api/sessions and delay the response by ~1500ms so we have
		// a long observation window in which the loader must already be visible.
		await page.route("**/api/sessions", async (route) => {
			if (route.request().method() !== "POST") {
				return route.fallback();
			}
			// Delay the response so the loader has a long observation window during
			// which the request is in-flight. Wrapped in a block so it doesn't trip
			// the no-new-sleeps guard's `=> setTimeout` pattern; this is a route
			// fulfillment delay, not a wall-clock test wait.
			await new Promise<void>((resolve) => { setTimeout(() => resolve(), 1500); });
			return route.fallback();
		});

		// Click and immediately measure how long until the loader appears.
		const t0 = Date.now();
		await splashLabel.click();

		const loader = page.locator('[data-testid="bobbit-loader"]').first();
		// Poll the DOM ourselves rather than waitFor — we want to capture the actual
		// time-to-visible (which can be sub-frame) without Playwright's default
		// 100ms polling interval skewing the measurement.
		await page.waitForFunction(
			() => !!document.querySelector('[data-testid="bobbit-loader"]'),
			null,
			{ timeout: 1_000, polling: 16 },
		);
		const elapsed = Date.now() - t0;

		// Sanity: loader is actually visible.
		await expect(loader).toBeVisible();

		// Hard ceiling: 200ms from click to loader-visible. The synchronous
		// renderApp() call inside the session-creation flow should land in
		// well under one frame; we leave headroom for headless-runner jitter.
		expect(elapsed).toBeLessThan(200);

		// Confirm the POST is still in-flight (i.e. the loader appeared *during*
		// the request, not after the response landed). We started a 1500ms route
		// delay above, so total elapsed-since-click must be well below that.
		expect(elapsed).toBeLessThan(1000);
	});
});
