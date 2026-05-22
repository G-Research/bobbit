import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test("authenticateGateway does not open Anthropic OAuth when Anthropic is unauthenticated", async ({ page }) => {
	let oauthStartRequests = 0;

	await page.route("**/api/oauth/status**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				provider: "anthropic",
				authenticated: false,
				configured: false,
				oauthSupported: true,
			}),
		});
	});

	await page.route("**/api/oauth/start", async (route) => {
		oauthStartRequests++;
		await route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({ error: "Anthropic OAuth must not start during gateway authentication" }),
		});
	});

	await openApp(page);

	await expect(page.getByText("Connect Anthropic")).toHaveCount(0);
	expect(oauthStartRequests).toBe(0);
});
