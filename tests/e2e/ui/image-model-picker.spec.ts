/**
 * Browser E2E for the image-model picker (Settings → Models → Image row).
 *
 * Coverage:
 *  1. Navigation: open Settings → Models, locate the Image model row.
 *  2. Happy path: open the picker dialog, pick a non-default model, assert
 *     the row label updates.
 *  3. Persistence: reload the page, assert the selection persisted.
 *  4. Unavailable badge: seed `default.imageModel` with an id absent from the
 *     registry; the row shows the red "Unavailable" badge.
 *  5. Clear: click the per-row clear button; the row resets to "Auto …".
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.setTimeout(30_000);

async function setPref(key: string, value: any): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: value }),
	});
	expect(resp.ok).toBe(true);
}

type ImageProvider = "openai" | "google";
const IMAGE_PROVIDERS: ImageProvider[] = ["openai", "google"];

async function saveImageProviderKey(provider: ImageProvider, key = `test-${provider}-image-key`): Promise<void> {
	const resp = await apiFetch(`/api/provider-keys/${provider}`, {
		method: "POST",
		body: JSON.stringify({ key, enable: true }),
	});
	expect(resp.ok).toBe(true);
}

async function cleanupImageProviders(): Promise<void> {
	for (const provider of IMAGE_PROVIDERS) {
		await apiFetch(`/api/provider-keys/${provider}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/cloud-providers/${provider}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		}).catch(() => {});
	}
}

test.describe("Image model picker (Settings → Models)", () => {
	test.beforeEach(async () => {
		for (const provider of IMAGE_PROVIDERS) await saveImageProviderKey(provider);
	});

	test.afterEach(async () => {
		// Reset the system default image model and image provider opt-ins between tests.
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "default.imageModel": null }),
		}).catch(() => {});
		await cleanupImageProviders();
	});

	test("navigation: image model row is visible in Settings → Models", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible({ timeout: 10_000 });
		// Default value (no pref set) reads "Auto (GPT Image 2)".
		await expect(row).toContainText("Auto", { timeout: 5_000 });
	});

	test("happy path: opening the picker and selecting a model updates the row", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible({ timeout: 10_000 });

		// Open the picker — the row's clickable button hosts the click handler.
		await row.locator("button").first().click();
		// Picker dialog renders an <image-model-selector> custom element appended
		// to <body>. The custom element itself has no rendered geometry; we wait
		// on its child items instead.
		const items = page.locator("image-model-selector [data-image-model-item]");
		await expect(items.first()).toBeVisible({ timeout: 10_000 });

		// Pick a non-default Imagen model id which we know is in the registry.
		const target = page.locator("image-model-selector [data-image-model-item]", {
			hasText: "imagen-4.0-fast-generate-001",
		}).first();
		await expect(target).toBeVisible({ timeout: 5_000 });

		// Listen for the preferences PUT to confirm persistence happens.
		const respPromise = page.waitForResponse(
			(r) => r.url().includes("/api/preferences") && r.request().method() === "PUT" && r.ok(),
			{ timeout: 10_000 },
		);
		await target.click();
		await respPromise;

		// Row label now reflects the new selection (model id appears as suffix).
		await expect(row).toContainText("imagen-4.0-fast-generate-001", { timeout: 5_000 });
	});

	test("persists after reload", async ({ page }) => {
		// Pre-seed the pref via API so the test isn't coupled to picker UI flake.
		await setPref("default.imageModel", "google/gemini-2.5-flash-image");
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toContainText("gemini-2.5-flash-image", { timeout: 5_000 });

		// Reload — selection survives.
		await page.reload();
		await navigateToHash(page, "#/settings/system/models");
		const row2 = page.locator("[data-testid='image-model-row']").first();
		await expect(row2).toBeVisible({ timeout: 10_000 });
		await expect(row2).toContainText("gemini-2.5-flash-image", { timeout: 5_000 });
	});

	test("shows Unavailable badge for stale image-model pref", async ({ page }) => {
		// Seed a pref that the registry will not match.
		await setPref("default.imageModel", "openai/this-model-does-not-exist");
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");

		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible({ timeout: 10_000 });
		const badge = row.locator("[data-testid='image-model-unavailable-badge']");
		await expect(badge).toBeVisible({ timeout: 10_000 });
		await expect(badge).toContainText("Unavailable", { timeout: 5_000 });
		// The model id must still be rendered alongside the badge so the user
		// can see *which* stale id triggered the warning.
		await expect(row).toContainText("this-model-does-not-exist", { timeout: 5_000 });
	});

	test("clear button resets to Auto", async ({ page }) => {
		await setPref("default.imageModel", "google/gemini-2.5-flash-image");
		await openApp(page);
		await navigateToHash(page, "#/settings/system/models");
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toContainText("gemini-2.5-flash-image", { timeout: 5_000 });

		const respPromise = page.waitForResponse(
			(r) => r.url().includes("/api/preferences") && r.request().method() === "PUT" && r.ok(),
			{ timeout: 10_000 },
		);
		await row.locator("[data-testid='image-model-clear-btn']").click();
		await respPromise;

		await expect(row).toContainText("Auto", { timeout: 5_000 });
	});
});
