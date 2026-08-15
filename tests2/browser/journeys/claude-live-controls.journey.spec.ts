import type { Page } from "@playwright/test";
import { test, expect, apiFetch, createSession, deleteSession, navigateToHash, openApp, sendMessage, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { CLAUDE_LIVE_MODELS, claudeLiveControlsDepsFactory, claudeLiveControlsSdk } from "../_helpers/claude-live-controls-sdk-fixture.js";

const PROVIDER = "claude-agent-sdk";
const INITIAL_MODEL = "sonnet-live";

test.use({ claudeAgentSdkBridgeDepsFactory: claudeLiveControlsDepsFactory });

type RuntimeTuple = { provider?: string; id?: string; thinkingLevel?: string; reasoning?: boolean };

async function readRuntimeTuple(page: Page): Promise<RuntimeTuple> {
	return page.evaluate(() => {
		const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
		const remote = appState?.remoteAgent?.state;
		return {
			provider: remote?.model?.provider,
			id: remote?.model?.id,
			thinkingLevel: remote?.thinkingLevel,
			reasoning: remote?.model?.reasoning,
		};
	});
}

async function chooseModel(page: Page, modelId: string): Promise<void> {
	await page.getByTestId("footer-model-id").click();
	const selector = page.locator("agent-model-selector");
	await expect(selector.getByText("Select Model").first()).toBeVisible({ timeout: 15_000 });
	await selector.getByPlaceholder("Search models...").fill(modelId);
	const row = selector.locator(`[data-model-item][data-model-id="${modelId}"]`).first();
	await expect(row).toBeVisible();
	await row.click();
}

async function selectThinkingLevel(page: Page, label: string): Promise<string[]> {
	const compact = page.locator(".thinking-select-compact");
	await compact.locator("button").click();
	const listbox = page.locator('[role="listbox"]').last();
	await expect(listbox).toBeVisible();
	const labels = (await listbox.locator('[role="option"]').allTextContents())
		.map(text => text.replace(/\s+/g, " ").trim());
	await listbox.getByRole("option", { name: label, exact: true }).click();
	return labels;
}

test.describe.serial("Journey: Claude Agent SDK live controls", () => {
	test("advertises live SDK effort choices, persists verified changes, and rolls back a failed model without persisting it", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		claudeLiveControlsSdk.reset();
		const preferences = await (await apiFetch("/api/preferences")).json() as Record<string, unknown>;
		const providers = await (await apiFetch("/api/custom-providers")).json() as Array<Record<string, unknown>>;
		const originalProvider = providers.find(provider => provider.id === PROVIDER);
		let sessionId: string | undefined;

		try {
			await apiFetch(`/api/custom-providers/${encodeURIComponent(PROVIDER)}`, { method: "DELETE" }).catch(() => undefined);
			const providerResponse = await apiFetch("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: PROVIDER,
					// Manual provider discovery uses config.name as the catalog provider.
					// Keep it equal to the SDK bridge's canonical provider so the
					// default session model passes current-catalog validation.
					name: PROVIDER,
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: Object.values(CLAUDE_LIVE_MODELS).map(model => ({ id: model.resolvedModel, name: model.resolvedModel })),
				}),
			});
			expect(providerResponse.status, await providerResponse.clone().text()).toBe(200);
			const preferenceResponse = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": `${PROVIDER}/${INITIAL_MODEL}`,
					"default.sessionThinkingLevel": "off",
				}),
			});
			expect(preferenceResponse.status, await preferenceResponse.clone().text()).toBe(200);

			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);

			await expect(page.getByTestId("footer-model-id")).toHaveText(INITIAL_MODEL, { timeout: 20_000 });
			// SDK capabilities become authoritative only once the production bridge
			// accepts its first genuine prompt. Initializing here avoids exercising
			// live controls against the intentionally pre-initialization tuple.
			await sendMessage(page, "Initialize Claude SDK live controls");
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 20_000 }).toEqual({
				provider: PROVIDER,
				id: INITIAL_MODEL,
				thinkingLevel: "off",
				reasoning: true,
			});

			// The SDK advertises only low/high for Sonnet. Missing levels must not be
			// shown as clamped choices in the browser.
			const sonnetLevels = await selectThinkingLevel(page, "High");
			expect(sonnetLevels).toEqual(["Off", "Low", "High"]);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 20_000 }).toMatchObject({ id: INITIAL_MODEL, thinkingLevel: "high" });
			expect(claudeLiveControlsSdk.queries[0]?.effortSettings).toContainEqual({ effortLevel: "high" });

			await chooseModel(page, CLAUDE_LIVE_MODELS.haiku.resolvedModel);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 20_000 }).toMatchObject({
				provider: PROVIDER,
				id: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				thinkingLevel: "off",
				reasoning: true,
			});
			expect(claudeLiveControlsSdk.queries[0]?.setModels).toContain(CLAUDE_LIVE_MODELS.haiku.value);
			expect(claudeLiveControlsSdk.queries[0]?.effortSettings.at(-1)).toEqual({ effortLevel: null });

			const haikuLevels = await selectThinkingLevel(page, "Medium");
			expect(haikuLevels).toEqual(["Off", "Medium"]);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 20_000 }).toMatchObject({
				id: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				thinkingLevel: "medium",
			});
			expect(claudeLiveControlsSdk.queries[0]?.effortSettings).toContainEqual({ effortLevel: "medium" });
			expect(gateway.sessionManager.getPersistedSession(sessionId)).toMatchObject({
				modelProvider: PROVIDER,
				modelId: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				effectiveThinkingLevel: "medium",
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.getByTestId("footer-model-id")).toHaveText(CLAUDE_LIVE_MODELS.haiku.resolvedModel, { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Medium", { timeout: 20_000 });

			await chooseModel(page, CLAUDE_LIVE_MODELS.broken.resolvedModel);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 20_000 }).toMatchObject({
				provider: PROVIDER,
				id: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				thinkingLevel: "medium",
			});
			expect(claudeLiveControlsSdk.queries[0]?.setModels).toContain(CLAUDE_LIVE_MODELS.broken.value);
			expect(gateway.sessionManager.getPersistedSession(sessionId)).toMatchObject({
				modelProvider: PROVIDER,
				modelId: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				effectiveThinkingLevel: "medium",
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.getByTestId("footer-model-id")).toHaveText(CLAUDE_LIVE_MODELS.haiku.resolvedModel, { timeout: 20_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Medium", { timeout: 20_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			await apiFetch(`/api/custom-providers/${encodeURIComponent(PROVIDER)}`, { method: "DELETE" }).catch(() => undefined);
			if (originalProvider) {
				await apiFetch("/api/custom-providers", { method: "POST", body: JSON.stringify(originalProvider) }).catch(() => undefined);
			}
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": preferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": preferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
		}
	});
});
