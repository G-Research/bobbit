import { test, expect, openApp } from "../_helpers/journey-fixture.js";

type Gateway = { id: string; name: string; url: string; type: "aigw" | "openai-compatible"; enabled: boolean; apiKeyConfigured?: boolean };

const gateways: Gateway[] = [
	{ id: "local-1", name: "local", url: "http://local.test", type: "openai-compatible", enabled: true, apiKeyConfigured: true },
	{ id: "empty-1", name: "empty", url: "http://empty.test", type: "openai-compatible", enabled: true },
	{ id: "down-1", name: "down", url: "http://down.test", type: "openai-compatible", enabled: true },
];

async function stubModelsApi(page: import("@playwright/test").Page): Promise<void> {
	await page.route("**/api/aigw/gateways", async route => {
		if (route.request().method() === "PUT") return route.fulfill({ json: { gateways } });
		return route.fulfill({ json: { gateways } });
	});
	await page.route("**/api/aigw/gateways/*/status", async route => {
		const url = route.request().url();
		if (url.includes("empty")) return route.fulfill({ json: { state: "empty", models: [] } });
		if (url.includes("down")) return route.fulfill({ json: { state: "unreachable", models: [{ id: "retained", name: "Retained", contextWindow: 128000, maxTokens: 4096, reasoning: false }], error: "Gateway unavailable" } });
		return route.fulfill({ json: { state: "reachable", models: [{ id: "current", name: "Current", contextWindow: 128000, maxTokens: 4096, reasoning: false }] } });
	});
	await page.route("**/api/aigw/test", route => route.fulfill({ json: { ok: true, models: [] } }));
	await page.route("**/api/aigw/gateways/*/refresh", route => route.fulfill({ json: { state: "empty", models: [] } }));
	await page.route("**/api/preferences", route => route.fulfill({ json: { "default.sessionModel": "openai/current" } }));
	await page.route("**/api/image-models", route => route.fulfill({ json: [] }));
	await page.route("**/api/models", route => route.fulfill({ json: [
		{ provider: "openai", id: "current", name: "Current", authenticated: false, reasoning: false, input: [], contextWindow: 128000, maxTokens: 4096, cost: {} },
		{ provider: "openai", id: "hidden", name: "Hidden", authenticated: false, reasoning: false, input: [], contextWindow: 128000, maxTokens: 4096, cost: {} },
		{ provider: "local", id: "ready", name: "Ready", authenticated: true, reasoning: false, input: [], contextWindow: 128000, maxTokens: 4096, cost: {} },
	] }));
}

test.describe("Journey: gateway statuses and picker visibility", () => {
	test("never exposes a configured key, distinguishes empty from retained outage, and persists the display-only filter", async ({ page }) => {
		await stubModelsApi(page);
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/models"; });
		await expect(page.getByTestId("gateways-editor")).toBeVisible({ timeout: 15_000 });

		await expect(page.getByTestId("gateway-key-configured")).toHaveText("Key configured");
		await expect(page.locator("body")).not.toContainText("secret-gateway-key");
		await expect(page.getByTestId("gateway-status").filter({ hasText: "Connected · no models reported" })).toBeVisible();
		await expect(page.getByTestId("gateway-status").filter({ hasText: "Unavailable · 1 retained model" })).toBeVisible();
		await page.getByTestId("gateway-test-btn").first().click();

		await page.locator('[data-testid="model-row"][data-row-label="Session"]').first().locator('button[title="Choose model"]').click();
		const modelPicker = page.locator("agent-model-selector").filter({ has: page.getByRole("heading", { name: "Select Model" }) });
		await expect(modelPicker.getByRole("heading", { name: "Select Model" })).toBeVisible();
		await expect(modelPicker.getByTestId("model-filter-has-key")).toBeVisible();
		await modelPicker.getByTestId("model-filter-has-key").click();
		await expect(modelPicker.locator('[data-model-id="hidden"]')).toHaveCount(0);
		await expect(modelPicker.locator('[data-model-id="current"]')).toBeVisible();
		await expect(modelPicker.locator('[data-model-id="ready"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await page.reload();
		await expect(page.getByTestId("gateways-editor")).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="model-row"][data-row-label="Session"]').first().locator('button[title="Choose model"]').click();
		await expect(modelPicker.locator('[data-model-id="hidden"]')).toHaveCount(0);
	});
});
