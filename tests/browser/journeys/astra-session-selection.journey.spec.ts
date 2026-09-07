import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForHealth,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import { installFakeCodexOAuth } from "../../support/fixtures/models/fake-codex-oauth.js";

const ASTRA = {
	provider: "openai-codex",
	id: "gpt-6-astra",
} as const;

const ASTRA_THINKING_MAP = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

async function loadAstraModel(): Promise<Record<string, any>> {
	const response = await apiFetch("/api/models");
	expect(response.status).toBe(200);
	const models = await response.json() as Array<Record<string, any>>;
	const matches = models.filter((model) => model.provider === ASTRA.provider && model.id === ASTRA.id);
	expect(matches, "Astra must occur exactly once in the Pi-backed browser catalog").toHaveLength(1);
	return matches[0];
}

function persistedAstra(gateway: { sessionManager?: any }, sessionId: string): Record<string, unknown> | undefined {
	const row = gateway.sessionManager?.getPersistedSession(sessionId);
	if (!row) return undefined;
	return {
		modelProvider: row.modelProvider,
		modelId: row.modelId,
		effectiveThinkingLevel: row.effectiveThinkingLevel,
	};
}

function readRemoteAstra(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(() => {
		const win = window as any;
		const state = (win.bobbitState ?? win.__bobbitState)?.remoteAgent?.state;
		return {
			provider: state?.model?.provider,
			id: state?.model?.id,
			thinkingLevel: state?.thinkingLevel,
			contextWindow: state?.model?.contextWindow,
			maxTokens: state?.model?.maxTokens,
			reasoning: state?.model?.reasoning,
			input: state?.model?.input,
			thinkingLevelMap: state?.model?.thinkingLevelMap,
		};
	});
}

const expectedLiveAstra = (thinkingLevel: "minimal" | "max") => ({
	...ASTRA,
	thinkingLevel,
	contextWindow: 272_000,
	maxTokens: 128_000,
	reasoning: true,
	input: ["text", "image"],
	thinkingLevelMap: ASTRA_THINKING_MAP,
});

test.describe.serial("Journey: Astra session selection and persistence", () => {
	test("selects authenticated Astra, hides Off, exposes Max, and survives reload and restart", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const restoreAuth = installFakeCodexOAuth(join(gateway.bobbitDir, "agent"));
		const registry = await import("../../../dist/server/agent/model-registry.js");
		registry.clearOAuthCache();
		registry.invalidateModelCache();

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
		let gatewayOnline = true;
		try {
			const model = await loadAstraModel();
			expect(model).toMatchObject({
				...ASTRA,
				name: "GPT-6 Astra",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				authenticated: true,
				contextWindow: 272_000,
				maxTokens: 128_000,
				reasoning: true,
				input: ["text", "image"],
				thinkingLevelMap: ASTRA_THINKING_MAP,
				compat: {
					supportsOpenAIGrammarTools: true,
					supportsAdditionalTools: true,
					supportsToolSearch: true,
				},
			});

			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);

			const footerModel = page.getByTestId("footer-model-id");
			await expect(footerModel).toBeVisible({ timeout: 20_000 });
			await footerModel.click();
			const selector = page.locator("agent-model-selector");
			await expect(selector.getByText("Select Model").first()).toBeVisible({ timeout: 15_000 });
			await selector.getByPlaceholder("Search models...").fill(ASTRA.id);
			const item = selector
				.locator(`[data-model-item][data-model-id="${ASTRA.id}"][data-session-unavailable="false"]`)
				.filter({ hasText: ASTRA.provider })
				.first();
			await expect(item, "Astra should be selectable after fake Codex OAuth authentication").toBeVisible({ timeout: 15_000 });
			await expect(item).toContainText("272K/128K");
			await expect(item).not.toHaveAttribute("title", /required/i);

			await selector.getByText("Thinking", { exact: true }).click();
			await expect(item).toBeVisible();
			await selector.getByText("Vision", { exact: true }).click();
			await expect(item).toBeVisible();
			await item.click();

			await expect(footerModel).toHaveText(ASTRA.id, { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Minimal", { timeout: 20_000 });
			await expect.poll(
				() => sentFrames.find((frame) => frame.type === "set_model" && frame.modelId === ASTRA.id),
				{ timeout: 15_000, message: "selecting Astra from Off should send the clamped Minimal tuple" },
			).toEqual({ type: "set_model", provider: ASTRA.provider, modelId: ASTRA.id, thinkingLevel: "minimal" });
			await expect.poll(() => readRemoteAstra(page), { timeout: 20_000 }).toEqual(expectedLiveAstra("minimal"));
			await expect.poll(() => persistedAstra(gateway, sessionId!), { timeout: 20_000 }).toEqual({
				modelProvider: ASTRA.provider,
				modelId: ASTRA.id,
				effectiveThinkingLevel: "minimal",
			});

			const thinking = page.locator(".thinking-select-compact");
			await thinking.locator("button").click();
			const listbox = page.locator('[role="listbox"]').last();
			await expect(listbox).toBeVisible();
			const labels = (await listbox.locator('[role="option"]').allTextContents())
				.map((text) => text.replace(/\s+/g, " ").trim());
			expect(labels, "Pi marks Off unsupported for Astra").not.toContain("Off");
			expect(labels, "Pi exposes Astra reasoning through Max").toContain("Max");
			await listbox.getByRole("option", { name: "Max", exact: true }).click();

			await expect(thinking).toHaveAttribute("title", "Max", { timeout: 20_000 });
			await expect.poll(() => readRemoteAstra(page), { timeout: 20_000 }).toEqual(expectedLiveAstra("max"));
			await expect.poll(() => persistedAstra(gateway, sessionId!), { timeout: 20_000 }).toEqual({
				modelProvider: ASTRA.provider,
				modelId: ASTRA.id,
				effectiveThinkingLevel: "max",
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(footerModel).toHaveText(ASTRA.id, { timeout: 20_000 });
			await expect(thinking).toHaveAttribute("title", "Max", { timeout: 20_000 });
			await expect.poll(() => readRemoteAstra(page), { timeout: 20_000 }).toEqual(expectedLiveAstra("max"));

			await sendMessage(page, "Astra persistence restart marker");
			await waitForAgentResponse(page);
			await waitForSessionStatus(sessionId, "idle");

			await gateway.crash();
			gatewayOnline = false;
			await gateway.restart();
			gatewayOnline = true;
			await waitForHealth(20_000);
			await waitForSessionStatus(sessionId, "idle", 40_000);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(footerModel).toHaveText(ASTRA.id, { timeout: 20_000 });
			await expect(thinking).toHaveAttribute("title", "Max", { timeout: 20_000 });
			await expect.poll(() => readRemoteAstra(page), { timeout: 20_000 }).toEqual(expectedLiveAstra("max"));
			expect(persistedAstra(gateway, sessionId)).toEqual({
				modelProvider: ASTRA.provider,
				modelId: ASTRA.id,
				effectiveThinkingLevel: "max",
			});
		} finally {
			if (!gatewayOnline) {
				await gateway.restart().catch(() => undefined);
				await waitForHealth(20_000).catch(() => undefined);
			}
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			restoreAuth();
			registry.clearOAuthCache();
			registry.invalidateModelCache();
		}
	});
});
