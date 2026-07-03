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
		if (await picker.isVisible({ timeout: 1_000 }).catch(() => false)) {
			await picker.locator('button[data-project-id="headquarters"]').click();
		} else {
			const inlineHeadquartersOption = page.getByRole("button", { name: /Headquarters\s+Server workspace/i }).first();
			if (await inlineHeadquartersOption.isVisible({ timeout: 1_000 }).catch(() => false)) {
				await inlineHeadquartersOption.click();
			}
		}
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
