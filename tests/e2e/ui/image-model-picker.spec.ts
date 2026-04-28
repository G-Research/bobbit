/**
 * Browser E2E for the image-model picker (Settings → Models → Image row).
 *
 * Coverage required (Phase 2 — flesh out after Agent A/B merge):
 *  1. Navigation: open Settings → Models, locate the Image model row.
 *  2. Happy path: open the picker, select a non-default model, assert UI updates.
 *  3. Persistence after reload: reload the page, assert selection persisted.
 *  4. Unavailable badge: when the active image-model pref points at a model the
 *     server reports as unavailable, the row shows the red "Unavailable" badge.
 *  5. Cleanup / clear: clear the per-session override, assert the row falls
 *     back to the system default.
 *
 * Phase 1 (this file): scaffold only — no real assertions on Agent A/B exports.
 * Tests are wrapped in test.skip so the suite passes type-check + run while the
 * picker UI lands.
 *
 * See AGENTS.md → "Add a UI E2E test" and `tests/e2e/ui/settings.spec.ts` for
 * the canonical pattern.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Image model picker (Settings → Models)", () => {
	test.skip("navigation: image model row is visible in Settings → Models", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		// TODO Phase 2: locate the image model row by stable testid / heading.
		// e.g. await expect(page.getByTestId("image-model-row")).toBeVisible();
	});

	test.skip("happy path: selecting a model updates the row", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		// TODO Phase 2: open the picker, click a non-default option, await
		// settle (PUT /api/preferences or PUT /api/projects/.../config), assert
		// the row label reflects the new selection.
	});

	test.skip("persists after reload", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		// TODO Phase 2: change selection → reload → re-open Settings → Models →
		// assert the same selection is rendered.
	});

	test.skip("shows Unavailable badge for stale image model pref", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		// TODO Phase 2: seed a pref pointing at a known-unavailable model
		// (e.g. via PUT /api/preferences { imageModel: "openai/nonsense" })
		// then navigate to Models tab and assert the red Unavailable badge.
	});

	test.skip("clear restores default image model", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		// TODO Phase 2: click clear/reset on the image row, assert the row
		// renders the default (defaultImageModelPref()).
	});
});
