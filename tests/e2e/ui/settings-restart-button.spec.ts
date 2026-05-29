import { test, expect, type Page } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const devHarnessTest = test.extend<{}, { enableDevHarnessRestart: boolean }>({
	enableDevHarnessRestart: [true, { scope: "worker", option: true }],
});

async function openSettings(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
}

async function expectRestartHidden(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /Restart Server|Restart Requested|Requesting/i })).toHaveCount(0);
}

test.describe("Settings restart button without dev harness", () => {
	test("is hidden by default and remains hidden after reload and navigation", async ({ page }) => {
		await openSettings(page);
		await expectRestartHidden(page);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expectRestartHidden(page);

		await navigateToHash(page, "#/");
		await navigateToHash(page, "#/settings/system/general");
		await expectRestartHidden(page);
	});
});

devHarnessTest.describe("Settings restart button with dev harness", () => {
	devHarnessTest("is visible, requests restart with feedback, and remains visible after reload and navigation", async ({ page }) => {
		let releaseRestart!: () => void;
		const restartFulfilled = new Promise<void>((resolve) => {
			releaseRestart = resolve;
		});
		let restartCalls = 0;
		await page.route("**/api/harness/restart", async (route) => {
			restartCalls += 1;
			await restartFulfilled;
			await route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, restartRequested: true }),
			});
		});

		await openSettings(page);
		const restartButton = page.getByRole("button", { name: "Restart Server" });
		await expect(restartButton).toBeVisible({ timeout: 10_000 });

		await restartButton.click();
		await expect(page.getByRole("button", { name: /Requesting/i })).toBeDisabled({ timeout: 5_000 });
		expect(restartCalls).toBe(1);

		releaseRestart();
		await expect(page.getByRole("button", { name: "Restart Requested" })).toBeDisabled({ timeout: 10_000 });

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByRole("button", { name: "Restart Server" })).toBeVisible({ timeout: 10_000 });

		await navigateToHash(page, "#/");
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByRole("button", { name: "Restart Server" })).toBeVisible({ timeout: 10_000 });
	});
});
