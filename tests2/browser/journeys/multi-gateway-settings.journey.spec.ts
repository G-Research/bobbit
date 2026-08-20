import type { Page } from "@playwright/test";
import { expect, openApp, test } from "../_helpers/journey-fixture.js";

type Gateway = {
	id: string;
	name: string;
	url: string;
	type: "aigw" | "openai-compatible";
	enabled: boolean;
	apiKeyConfigured?: boolean;
};

async function installGatewayStubs(page: Page): Promise<{ saves: Array<{ gateways: Gateway[]; apiKeys: unknown[] }>; tests: Array<{ gatewayId: unknown }> }> {
	let saved: Gateway[] = [];
	const saves: Array<{ gateways: Gateway[]; apiKeys: unknown[] }> = [];
	const tests: Array<{ gatewayId: unknown }> = [];

	await page.route("**/api/aigw/gateways", async route => {
		if (route.request().method() !== "PUT") return route.fulfill({ json: { gateways: saved } });
		const body = route.request().postDataJSON() as { gateways: Array<Gateway & { apiKey?: unknown }> };
		saves.push({
			gateways: body.gateways.map(({ apiKey: _apiKey, ...gateway }) => gateway),
			apiKeys: body.gateways.map(gateway => gateway.apiKey),
		});
		saved = body.gateways.map(({ apiKey, ...gateway }) => ({ ...gateway, apiKeyConfigured: apiKey === null ? false : apiKey !== undefined || gateway.apiKeyConfigured === true }));
		return route.fulfill({ json: { gateways: saved } });
	});
	await page.route("**/api/aigw/gateways/*/status", route => route.fulfill({ json: { state: "reachable", models: [{ id: "local-model", name: "Local model", contextWindow: 128000, maxTokens: 4096, reasoning: false }] } }));
	await page.route("**/api/aigw/gateways/*/refresh", route => route.fulfill({ json: { state: "empty", models: [] } }));
	await page.route("**/api/aigw/test", route => {
		const body = route.request().postDataJSON() as { gatewayId?: unknown };
		tests.push({ gatewayId: body.gatewayId });
		if (typeof body.gatewayId !== "string") return route.fulfill({ status: 400, json: { error: "Missing gateway id" } });
		return route.fulfill({ json: { ok: true, models: [{ id: "local-model", name: "Local model", contextWindow: 128000, maxTokens: 4096, reasoning: false }] } });
	});
	await page.route("**/api/preferences", route => route.fulfill({ json: {} }));
	await page.route("**/api/models", route => route.fulfill({ json: [] }));
	await page.route("**/api/image-models", route => route.fulfill({ json: [] }));
	return { saves, tests };
}

test.describe("Journey: multi-gateway Models settings", () => {
	test("adds, saves, reloads, tests, disables, clears a key, and removes a gateway without exposing its key", async ({ page }) => {
		const state = await installGatewayStubs(page);
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/models"; });
		await expect(page.getByTestId("gateways-editor")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("No gateways configured")).toBeVisible();

		await page.getByTestId("gateways-add-btn").click();
		const row = page.getByTestId("gateway-row");
		await row.getByTestId("gateway-name-input").fill("local");
		await row.getByTestId("gateway-url-input").fill("http://local.test");
		await row.getByTestId("gateway-api-key-input").fill("secret-gateway-key");
		await page.getByTestId("gateways-save-btn").click();
		await expect.poll(() => state.saves.length).toBe(1);
		expect(state.saves[0].apiKeys).toEqual(["secret-gateway-key"]);
		await expect(page.locator("body")).not.toContainText("secret-gateway-key");
		await expect(row.getByTestId("gateway-key-configured")).toHaveText("Key configured");

		await page.reload();
		await expect(page.getByTestId("gateway-row")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("gateway-key-configured")).toHaveText("Key configured");
		await expect(page.locator("body")).not.toContainText("secret-gateway-key");

		await page.getByTestId("gateway-test-btn").click();
		await expect.poll(() => state.tests.length).toBe(1);
		expect(state.tests[0].gatewayId).toBe(state.saves[0].gateways[0].id);
		await expect(page.getByTestId("gateway-status")).toContainText("Connected");
		await page.getByTestId("gateway-refresh-btn").click();
		await expect(page.getByTestId("gateway-status")).toContainText("no models reported");

		await page.getByTestId("gateway-enabled-checkbox").uncheck();
		await page.getByTestId("gateway-clear-key-btn").click();
		await expect(page.getByTestId("gateway-key-clearing")).toBeVisible();
		await page.getByTestId("gateways-save-btn").click();
		await expect.poll(() => state.saves.length).toBe(2);
		expect(state.saves[1].gateways[0].enabled).toBe(false);
		expect(state.saves[1].apiKeys).toEqual([null]);

		await page.getByTestId("gateway-remove-btn").click();
		await page.getByTestId("gateways-save-btn").click();
		await expect.poll(() => state.saves.length).toBe(3);
		expect(state.saves[2].gateways).toEqual([]);
		await expect(page.getByText("No gateways configured")).toBeVisible();
	});
});
