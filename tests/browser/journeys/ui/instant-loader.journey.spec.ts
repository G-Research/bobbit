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
import { test, expect } from "../../_helpers/journey-fixture.js";
import { apiFetch } from "../../_helpers/e2e-setup.js";
import { openApp } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

async function showHeadquarters(): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(resp.ok, "Headquarters should be visible for the splash Quick Session path").toBeTruthy();
}

test.describe("Instant loader on session create", () => {
	test.beforeEach(async () => {
		await showHeadquarters();
	});

	test("splash 'Quick Session' click shows bobbit-loader while POST is in-flight", async ({ page }) => {
		await openApp(page);

		// Headquarters is the built-in first-run workspace, so the splash CTA is Quick Session.
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible();
		await expect(splashLabel).toContainText("Quick Session");

		// Hold the create-session POST open until after the loader assertion. The
		// route itself is the authoritative observation point: resolving a separate
		// waitForRequest beside an intercept can miss the event under a busy browser.
		let observePost!: () => void;
		const postObserved = new Promise<void>((resolve) => { observePost = resolve; });
		let releasePost!: () => void;
		let postReleased = false;
		const releasePostPromise = new Promise<void>((resolve) => {
			releasePost = () => {
				postReleased = true;
				resolve();
			};
		});
		await page.route("**/api/sessions", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			observePost();
			await releasePostPromise;
			return route.fallback();
		});

		// openApp's end-of-boot marker makes this hydrated project count the same
		// authority used by _onSplashSessionClick: one project posts directly,
		// while multiple projects render the splash-specific picker.
		const projectCount = await page.evaluate(() => (window as any).__bobbitState.projects.length as number);
		expect(projectCount, "Quick Session requires at least one hydrated visible project").toBeGreaterThan(0);
		await splashLabel.click();
		if (projectCount > 1) {
			const picker = page.locator('[data-testid="splash-project-picker"]');
			await expect(picker).toBeVisible();
			await picker
				.locator('[data-testid="splash-project-picker-item"]')
				.filter({ hasText: "Headquarters" })
				.first()
				.click();
		}
		await postObserved;

		const loader = page.locator('[data-testid="bobbit-loader"]').first();
		try {
			await expect(
				loader,
				"bobbit-loader should be visible before POST /api/sessions is allowed to complete",
			).toBeVisible();
			expect(postReleased).toBe(false);
		} finally {
			releasePost();
		}
	});
});
