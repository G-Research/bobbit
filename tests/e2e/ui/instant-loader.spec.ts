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
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function showHeadquarters(): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(resp.ok, "Headquarters should be visible for the splash Quick Session path").toBeTruthy();
}

// `Locator.isVisible({ timeout })` does NOT wait — Playwright's own type
// declarations mark that `timeout` option `@deprecated ... ignored`, and
// `isVisible()` always resolves immediately against whatever is in the DOM
// *right now*. The splash click handler (`_onSplashSessionClick` in
// src/app/render.ts) flips `state.splashProjectPickerOpen` synchronously, but
// the actual render is deferred one frame via `renderApp()`'s
// `requestAnimationFrame` scheduling (src/app/state.ts) — so an immediate,
// non-waiting visibility check taken right after `.click()` resolves can
// observe the picker DOM before that frame has painted, and silently treat
// neither picker as present. `Locator.waitFor({ state: "visible" })` (unlike
// `isVisible()`) actually polls up to `timeout`, which is the real fix here.
async function isVisibleWithin(locator: import("@playwright/test").Locator, timeout: number): Promise<boolean> {
	try {
		await locator.waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

test.describe("Instant loader on session create", () => {
	test.beforeEach(async () => {
		await showHeadquarters();
	});

	test("splash 'Quick Session' click shows bobbit-loader while POST is in-flight", async ({ page }) => {
		await openApp(page);

		// Headquarters is the built-in first-run workspace, so the splash CTA is Quick Session.
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 20_000 });
		await expect(splashLabel).toContainText("Quick Session");

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
		// With Headquarters plus the harness default project visible, the splash
		// Quick Session CTA opens the same project picker as other session entry
		// points. Pick Headquarters to exercise the built-in first-run workspace;
		// single-visible-project states still POST immediately.
		const picker = page.locator("project-picker-popover").first();
		if (await isVisibleWithin(picker, 2_000)) {
			await picker.locator('button[data-project-id="headquarters"]').click();
		} else {
			const inlineHeadquartersOption = page.getByRole("button", { name: /Headquarters\s+Server workspace/i }).first();
			if (await isVisibleWithin(inlineHeadquartersOption, 2_000)) {
				await inlineHeadquartersOption.click();
			}
		}
		await postStarted;

		const loader = page.locator('[data-testid="bobbit-loader"]').first();
		try {
			// `renderApp()` (src/app/state.ts) schedules the actual DOM patch via
			// `requestAnimationFrame`, not synchronously — `state.creatingSession`
			// flips true before the fetch is even issued, but the loader only
			// paints on the next animation frame. Under heavy full-suite load
			// (many concurrent headless Chromium instances contending for the
			// host's compositor/paint scheduling — not reproducible with plain
			// CPU-spin load on this box), that next frame can be delayed well
			// past a tight 1s margin, same class of issue as the VER-07 fixed
			// flake in KNOWN-FLAKES.txt (tight wall-clock margin losing under
			// contention). Widening this does not weaken the regression check:
			// the POST is held open by the route handler above until we call
			// releasePost() in this `finally`, so a real regression (loader
			// gated behind POST completion) would still never satisfy this wait
			// and the test would still fail — just after a more realistic
			// budget for a browser-scheduled paint under load.
			await expect(
				loader,
				"bobbit-loader should be visible before POST /api/sessions is allowed to complete",
			).toBeVisible({ timeout: 5_000 });
			expect(postReleased).toBe(false);
		} finally {
			releasePost();
		}
	});
});
