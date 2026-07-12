/**
 * Journey: Pi runtime upgrade — browser-facing compatibility coverage.
 * Covers server-backed model metadata, provider key testing through the
 * browser-safe pi-ai routes, and session restore after transcript parsing.
 */
import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash, apiFetch, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";

interface ApiModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	authenticated: boolean;
	cost: { input: number; output: number };
}

function assertModelMetadata(model: unknown): asserts model is ApiModel {
	expect(model).toEqual(expect.objectContaining({
		id: expect.any(String),
		name: expect.any(String),
		provider: expect.any(String),
		contextWindow: expect.any(Number),
		maxTokens: expect.any(Number),
		reasoning: expect.any(Boolean),
		input: expect.any(Array),
		authenticated: expect.any(Boolean),
		cost: expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }),
	}));
}

async function loadModelsFromApi(): Promise<ApiModel[]> {
	const res = await apiFetch("/api/models");
	expect(res.status).toBe(200);
	const models = await res.json();
	expect(Array.isArray(models)).toBe(true);
	expect(models.length).toBeGreaterThan(0);
	for (const model of models) assertModelMetadata(model);
	return models;
}

/**
 * Pi 0.80.6's central user-facing contract: the GPT 5.6 catalog entries must be
 * exposed through /api/models under the openai provider. Pinning these exact IDs
 * (instead of accepting any generic model) is the point of this journey — it
 * fails loudly if the Pi upgrade or the Bobbit model registry stops surfacing them.
 */
const GPT_5_6_IDS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

function requireGpt56Models(models: ApiModel[]): ApiModel[] {
	const selected: ApiModel[] = [];
	for (const id of GPT_5_6_IDS) {
		const model = models.find((m) => m.provider === "openai" && m.id === id);
		expect(model, `expected openai/${id} GPT 5.6 model in /api/models`).toBeTruthy();
		selected.push(model as ApiModel);
	}
	return selected;
}

async function openModelsSettings(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/models");
	await expect(page.getByTestId("models-tab")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Pi Runtime Upgrade", () => {
	test("settings selector exposes Pi 0.80.6 GPT 5.6 models from /api/models and selects one", async ({ page }) => {
		const models = await loadModelsFromApi();
		// Hard pin: all three GPT 5.6 catalog entries must be present, not just any model.
		const gpt56 = requireGpt56Models(models);
		for (const model of gpt56) {
			expect(model.contextWindow, `${model.id} contextWindow`).toBeGreaterThan(0);
			expect(model.maxTokens, `${model.id} maxTokens`).toBeGreaterThan(0);
			expect(model.reasoning, `${model.id} should be reasoning-capable`).toBe(true);
		}
		// Select the first GPT 5.6 entry through the settings picker.
		const model = gpt56[0];

		const modelResponses: string[] = [];
		page.on("response", (response) => {
			if (response.url().includes("/api/models") && response.request().method() === "GET" && response.ok()) {
				modelResponses.push(response.url());
			}
		});

		try {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": null }),
			});

			await openModelsSettings(page);
			const sessionRow = page.locator('[data-testid="model-row"][data-row-label="Session"]').first();
			await sessionRow.locator('button[title="Choose model"]').click();

			await expect(page.getByText("Select Model").first()).toBeVisible({ timeout: 15_000 });
			await page.getByPlaceholder("Search models...").fill(model.id);
			const item = page.locator("[data-model-item]").filter({ hasText: model.id }).filter({ hasText: model.provider }).first();
			await expect(item, `expected ${model.provider}/${model.id} in the model selector`).toBeVisible({ timeout: 15_000 });
			await item.click();

			await expect(page.getByText("Select Model")).toHaveCount(0, { timeout: 15_000 });
			await expect(sessionRow.locator('button[title="Choose model"]')).toContainText(model.id, { timeout: 15_000 });
			expect(modelResponses.length, "settings/model selector should fetch server model metadata").toBeGreaterThan(0);
		} finally {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": null }),
			});
		}
	});

	test("provider key settings use browser-safe pi-ai server routes", async ({ page }) => {
		const providersResponse = page.waitForResponse(
			(response) => response.url().includes("/api/pi-ai/providers") && response.request().method() === "GET" && response.ok(),
			{ timeout: 20_000 },
		);

		await openApp(page);
		const providers = await page.evaluate(async () => {
			const token = localStorage.getItem("gateway.token") || "";
			const res = await fetch("/api/pi-ai/providers", {
				headers: { Authorization: `Bearer ${token}` },
			});
			return res.json();
		});
		await providersResponse;
		expect(Array.isArray(providers.providers)).toBe(true);
		expect(providers.providers).toContain("openai");

		let keyTestBody: any = null;
		await page.route("**/api/pi-ai/provider-key-test", async (route) => {
			keyTestBody = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});
		await page.route("**/api/provider-keys/openai", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
		});

		await navigateToHash(page, "#/settings/system/models");
		await expect(page.getByTestId("provider-key-input-openai")).toBeVisible({ timeout: 20_000 });
		const openaiKey = page.getByTestId("provider-key-input-openai");
		await openaiKey.locator('input[name="bobbit-provider-api-key-openai"]').fill("sk-test-pi-runtime-browser-route");
		await openaiKey.locator("button").filter({ hasText: "Save" }).click();
		await expect.poll(() => keyTestBody, { timeout: 15_000 }).toEqual(expect.objectContaining({
			provider: "openai",
			modelId: "gpt-4o-mini",
			key: "sk-test-pi-runtime-browser-route",
		}));
	});

	test("session transcript survives reload and restore after a mock-agent exchange", async ({ page }) => {
		const parseErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" && /transcript|parse|message kind|unknown session entry/i.test(msg.text())) {
				parseErrors.push(msg.text());
			}
		});
		page.on("pageerror", (err) => {
			if (/transcript|parse|message kind|unknown session entry/i.test(err.message)) parseErrors.push(err.message);
		});

		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.locator("message-editor textarea").first().fill("Pi transcript restore smoke");
			await page.locator("message-editor textarea").first().press("Enter");
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			expect(parseErrors).toEqual([]);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
