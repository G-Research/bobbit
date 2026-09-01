/**
 * Journey: Pi runtime upgrade — browser-facing compatibility coverage.
 * Covers Pi-authoritative model picker/runtime metadata, provider key testing
 * through browser-safe pi-ai routes, and session restore after transcript parsing.
 */
import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash, apiFetch, createSession, deleteSession, waitForSessionStatus } from "../../support/helpers/browser/journeys/journey-fixture.js";

interface ApiModel {
	id: string;
	name: string;
	provider: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	authenticated: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
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

const AUTHORITATIVE_CLAUDE = { provider: "anthropic", id: "claude-opus-4-5", thinkingLevel: "high" } as const;
const AUTHORITATIVE_CLAUDE_LEVEL_LABELS = ["Off", "Minimal", "Low", "Medium", "High"] as const;

function requireAuthoritativeClaude(models: ApiModel[]): ApiModel {
	const model = models.find((candidate) => candidate.provider === AUTHORITATIVE_CLAUDE.provider && candidate.id === AUTHORITATIVE_CLAUDE.id);
	expect(model, `expected ${AUTHORITATIVE_CLAUDE.provider}/${AUTHORITATIVE_CLAUDE.id} in /api/models`).toBeTruthy();
	return model as ApiModel;
}

async function openModelsSettings(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/models");
	await expect(page.getByTestId("models-tab")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Pi Runtime Upgrade", () => {
	test("selects a formerly inflated Claude row and restores exact Pi metadata after reload", async ({ page }) => {
		test.setTimeout(90_000);
		const models = await loadModelsFromApi();
		const model = requireAuthoritativeClaude(models);
		expect(model).toMatchObject({
			name: "Claude Opus 4.5 (latest)",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 200_000,
			maxTokens: 64_000,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(model.thinkingLevelMap).toBeUndefined();

		const beforePreferences = await (await apiFetch("/api/preferences")).json();
		const sentFrames: Array<Record<string, unknown>> = [];
		page.on("websocket", (socket) => {
			socket.on("framesent", (event) => {
				try {
					const payload = typeof event.payload === "string" ? event.payload : event.payload.toString("utf8");
					sentFrames.push(JSON.parse(payload));
				} catch { /* non-JSON frame */ }
			});
		});

		let sessionId: string | undefined;
		try {
			const seeded = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": "anthropic/claude-fable-5",
					"default.sessionThinkingLevel": "xhigh",
				}),
			});
			expect(seeded.status).toBe(200);

			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);

			const footerModel = page.getByTestId("footer-model-id");
			await expect(footerModel).toHaveText("claude-fable-5", { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Extra high", { timeout: 20_000 });
			await footerModel.click();

			const selector = page.locator("agent-model-selector");
			await expect(selector.getByText("Select Model").first()).toBeVisible({ timeout: 15_000 });
			await selector.getByPlaceholder("Search models...").fill(AUTHORITATIVE_CLAUDE.id);
			const item = selector.locator(`[data-model-item][data-model-id="${AUTHORITATIVE_CLAUDE.id}"]`).filter({ hasText: AUTHORITATIVE_CLAUDE.provider }).first();
			await expect(item, `expected ${AUTHORITATIVE_CLAUDE.provider}/${AUTHORITATIVE_CLAUDE.id} in the session picker`).toBeVisible({ timeout: 15_000 });
			// The selector must render the exact /api/models limits rather than the
			// retired blanket Claude 1M override.
			await expect(item).toContainText("200K/64K");

			// These filters consume the same reasoning/image metadata as the row icons.
			await selector.getByText("Thinking", { exact: true }).click();
			await expect(item).toBeVisible();
			await selector.getByText("Vision", { exact: true }).click();
			await expect(item).toBeVisible();
			await item.click();

			await expect(footerModel).toHaveText(AUTHORITATIVE_CLAUDE.id, { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "High", { timeout: 20_000 });
			await expect.poll(
				() => sentFrames.find((frame) => frame.type === "set_model" && frame.modelId === AUTHORITATIVE_CLAUDE.id),
				{ timeout: 15_000, message: "picker should send one combined exact model/thinking request" },
			).toEqual({ type: "set_model", provider: AUTHORITATIVE_CLAUDE.provider, modelId: AUTHORITATIVE_CLAUDE.id, thinkingLevel: AUTHORITATIVE_CLAUDE.thinkingLevel });

			const readRemoteTuple = () => page.evaluate(() => {
				const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
				const state = appState?.remoteAgent?.state;
				return {
					provider: state?.model?.provider,
					id: state?.model?.id,
					thinkingLevel: state?.thinkingLevel,
					contextWindow: state?.model?.contextWindow,
					maxTokens: state?.model?.maxTokens,
					reasoning: state?.model?.reasoning,
					input: state?.model?.input,
					thinkingLevelMap: state?.model?.thinkingLevelMap ?? null,
				};
			});
			const expectedLiveMetadata = {
				...AUTHORITATIVE_CLAUDE,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				input: model.input,
				thinkingLevelMap: model.thinkingLevelMap ?? null,
			};
			await expect.poll(readRemoteTuple, { timeout: 20_000 }).toEqual(expectedLiveMetadata);

			const thinking = page.locator(".thinking-select-compact");
			await thinking.locator("button").click();
			const listbox = page.locator('[role="listbox"]').last();
			await expect(listbox).toBeVisible();
			const labels = (await listbox.locator('[role="option"]').allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
			expect(labels).toEqual(AUTHORITATIVE_CLAUDE_LEVEL_LABELS);
			await thinking.locator("button").click();

			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("Authoritative Claude metadata browser journey");
			await editor.press("Enter");
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(footerModel).toHaveText(AUTHORITATIVE_CLAUDE.id, { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "High", { timeout: 20_000 });
			await expect.poll(readRemoteTuple, { timeout: 20_000 }).toEqual(expectedLiveMetadata);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": beforePreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": beforePreferences["default.sessionThinkingLevel"] ?? null,
				}),
			});
		}
	});

	test("AIGW provenance is searchable, badges stay stable, and bare preference survives reload", async ({ page }) => {
		const aigwId = "gpt-5.6-sol";
		const registryProviderId = `pi-runtime-aigw-${Date.now()}`;
		const models = [
			{
				id: aigwId,
				name: "GPT 5.6 Sol",
				provider: "aigw",
				upstreamProvider: "aws-mantle",
				api: "openai-responses",
				baseUrl: "https://203.0.113.1/openai/v1",
				contextWindow: 272000,
				maxTokens: 128000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
				authenticated: true,
			},
			{
				id: "gpt-4o",
				name: "GPT 4o",
				provider: "openai",
				api: "openai-completions",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 128000,
				maxTokens: 16384,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
			},
		];
		await page.route("**/api/models", async (route) => {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(models) });
		});

		try {
			const registered = await apiFetch("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: registryProviderId,
					name: "aigw",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: aigwId, name: "GPT 5.6 Sol" }],
				}),
			});
			expect(registered.status, await registered.clone().text()).toBe(200);

			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": null }),
			});
			await openModelsSettings(page);
			let sessionRow = page.locator('[data-testid="model-row"][data-row-label="Session"]').first();
			await sessionRow.locator('button[title="Choose model"]').click();
			const search = page.getByPlaceholder("Search models...");
			await search.fill("aws-mantle");
			const aigwItem = page.locator("[data-model-item]").filter({ hasText: aigwId }).first();
			await expect(aigwItem).toBeVisible({ timeout: 15_000 });
			await expect(aigwItem.locator('[title="AIGW provider: aws-mantle"]')).toContainText("aws-mantle");

			await search.fill("gpt-4o");
			const openAiItem = page.locator("[data-model-item]").filter({ hasText: "gpt-4o" }).first();
			await expect(openAiItem).toBeVisible();
			await expect(openAiItem.locator('[title="openai"]')).toContainText("openai");
			await expect(openAiItem).not.toContainText("aws-mantle");

			await search.fill("aws-mantle");
			await aigwItem.click();
			await expect(sessionRow.locator('button[title="Choose model"]')).toContainText(aigwId, { timeout: 15_000 });
			await expect(sessionRow).toContainText("aws-mantle");
			const saved = await (await apiFetch("/api/preferences")).json();
			expect(saved["default.sessionModel"]).toBe(`aigw/${aigwId}`);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, "#/settings/system/models");
			sessionRow = page.locator('[data-testid="model-row"][data-row-label="Session"]').first();
			await expect(sessionRow.locator('button[title="Choose model"]')).toContainText(aigwId, { timeout: 20_000 });
			await expect(sessionRow).toContainText("aws-mantle");
		} finally {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": null }),
			});
			await apiFetch(`/api/custom-providers/${encodeURIComponent(registryProviderId)}`, { method: "DELETE" });
			await page.unroute("**/api/models");
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
