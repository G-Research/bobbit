import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const TOGGLE = "allow-session-model-fallback-toggle";

async function setFallbackPreference(value: boolean | null): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ allowSessionModelFallback: value }),
	});
	expect(resp.ok).toBe(true);
}

async function readFallbackPreference(): Promise<unknown> {
	const resp = await apiFetch("/api/preferences");
	expect(resp.ok).toBe(true);
	const prefs = await resp.json();
	return prefs.allowSessionModelFallback;
}

async function openModelsSettings(page: Parameters<typeof openApp>[0]) {
	await navigateToHash(page, "#/settings/system/models");
	const toggle = page.getByTestId(TOGGLE);
	await expect(toggle).toBeVisible({ timeout: 10_000 });
	return toggle;
}

test.describe("Settings → Models controlled fallback", () => {
	test("defaults off, persists on across reload, then persists off", async ({ page }) => {
		await setFallbackPreference(null);
		expect(await readFallbackPreference()).toBeUndefined();

		try {
			await openApp(page);
			let toggle = await openModelsSettings(page);

			await expect(toggle).not.toBeChecked();
			await expect(page.getByText(/Off by default/)).toBeVisible();
			await expect(page.getByText(/default\.sessionModel/)).toBeVisible();
			await expect(page.getByText(/Image generation is separate/)).toBeVisible();

			let put = page.waitForResponse((resp) =>
				resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
			);
			await toggle.check();
			await put;
			await expect(toggle).toBeChecked();
			await expect.poll(readFallbackPreference, { timeout: 10_000 }).toBe(true);

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			toggle = await openModelsSettings(page);
			await expect(toggle).toBeChecked({ timeout: 10_000 });

			put = page.waitForResponse((resp) =>
				resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
			);
			await toggle.uncheck();
			await put;
			await expect(toggle).not.toBeChecked();
			await expect.poll(readFallbackPreference, { timeout: 10_000 }).toBe(false);
		} finally {
			await setFallbackPreference(null);
		}
	});
});
