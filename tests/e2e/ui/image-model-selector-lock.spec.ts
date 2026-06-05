/**
 * Browser E2E for the "lock image model to selector" goal.
 *
 * The bottom-controls image-model selector is the single source of truth for
 * the model `generate_image` uses (the tool no longer exposes a `model` param —
 * that half is pinned by `tests/image-generate-no-model-param.test.ts`). This
 * test confirms the live control still works end-to-end: opening the selector,
 * picking a different model, and that the choice persists across a reload.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";
import { createSession, apiFetch } from "../e2e-setup.js";

test.describe("image-model selector (single source of truth)", () => {
	test("selector changes the session image model and persists across reload", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// The footer image-model button shows the resolved model. With no
			// per-session override the server broadcasts the default (gpt-image-2).
			const footer = page.locator("[data-testid='footer-image-model-id']");
			await expect(footer).toBeVisible({ timeout: 15_000 });
			await expect(footer).toHaveText("gpt-image-2", { timeout: 10_000 });

			// Open the selector dialog and pick a different model. The dialog
			// content renders into the page (DialogBase overlay), so assert against
			// its header / search input rather than the custom-element host.
			await footer.click();
			await expect(page.getByText("Select Image Model")).toBeVisible({ timeout: 10_000 });
			await page.getByPlaceholder("Search models...").fill("dall-e-3");
			const item = page.locator("[data-image-model-item]").first();
			await expect(item).toBeVisible({ timeout: 10_000 });
			await item.click();

			// Footer reflects the new selection immediately.
			await expect(footer).toHaveText("dall-e-3", { timeout: 10_000 });

			// Persistence: reload and re-open the same session — the per-session
			// image model survives (persisted via WS set_image_model).
			await page.reload();
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(
				page.locator("[data-testid='footer-image-model-id']"),
			).toHaveText("dall-e-3", { timeout: 15_000 });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
