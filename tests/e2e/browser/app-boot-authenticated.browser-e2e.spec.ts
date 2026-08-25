import { test, expect } from "../_helpers/gateway-harness.js";
import { base } from "../_helpers/e2e-setup.js";
import { openApp } from "./_helpers/ui-helpers.js";

// A retry would hide an initialization ordering regression: token-query boot
// must leave the startup shell on its first attempt.
test.describe.configure({ retries: 0 });

test("token-query boot reaches the authenticated landing shell", async ({ page }) => {
	await openApp(page);

	await expect(page.locator('[data-testid="bobbit-loader"]')).toHaveCount(0);
	expect(await page.evaluate(() => ({
		appView: (window as any).__bobbitState?.appView,
		gatewayUrl: localStorage.getItem("gateway.url"),
		tokenPresent: Boolean(localStorage.getItem("gateway.token")),
		query: window.location.search,
	}))).toEqual({
		appView: "authenticated",
		gatewayUrl: base(),
		tokenPresent: true,
		query: "",
	});
});
