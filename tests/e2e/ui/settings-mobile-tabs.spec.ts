import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Settings mobile tabs", () => {
	test("tab bar scrolls horizontally so right-side tabs are reachable", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const tabBar = page.getByTestId("settings-tab-bar");
		await expect(tabBar).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Maintenance" })).toBeAttached();

		const metrics = await tabBar.evaluate((el) => ({
			clientWidth: el.clientWidth,
			scrollWidth: el.scrollWidth,
			overflowX: getComputedStyle(el).overflowX,
		}));
		expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
		expect(["auto", "scroll"]).toContain(metrics.overflowX);

		await tabBar.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
		await expect.poll(() => tabBar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

		const maintenanceIsVisible = await page.getByRole("button", { name: "Maintenance" }).evaluate((button) => {
			const buttonBox = button.getBoundingClientRect();
			const tabBarBox = button.parentElement!.getBoundingClientRect();
			return buttonBox.left >= tabBarBox.left && buttonBox.right <= tabBarBox.right;
		});
		expect(maintenanceIsVisible).toBe(true);

		await page.getByRole("button", { name: "Maintenance" }).click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("/maintenance");
	});
});
