import type { Page } from "@playwright/test";
import { test, expect, apiFetch, createSession, deleteSession, navigateToHash, openApp, sendMessage, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import {
	CLAUDE_LIVE_MODELS,
	PACED_ROOT_PARTIAL,
	PACED_ROOT_PROMPT,
	PACED_ROOT_RESPONSE,
	claudeLiveControlsDepsFactory,
	claudeLiveControlsSdk,
} from "../_helpers/claude-live-controls-sdk-fixture.js";

const PROVIDER = "claude-agent-sdk";
const INITIAL_MODEL = CLAUDE_LIVE_MODELS.sonnet.resolvedModel;

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

async function expectOneSettledRootResponse(page: Page): Promise<void> {
	const response = page.locator("assistant-message").filter({ hasText: PACED_ROOT_RESPONSE });
	await expect(response).toHaveCount(1, { timeout: 15_000 });
	await expect(response).toContainText(PACED_ROOT_RESPONSE);
	await expect(page.locator("user-message").filter({ hasText: PACED_ROOT_PROMPT })).toHaveCount(1);
	// A replay must contain only transcript rows. Empty assistant cards here render
	// as the dark rounded pills seen after navigating away and back.
	expect(await page.locator("assistant-message").evaluateAll(nodes =>
		nodes.filter(node => !(node.textContent ?? "").trim()).length,
	)).toBe(0);
}

test.describe.serial("Journey: Claude Agent SDK live controls", () => {
	test("uses built-in aliases for advertised effort, paced root streaming, durable reload, and failed-selection rollback", async ({ page, gateway }) => {
		test.setTimeout(60_000);
		claudeLiveControlsSdk.reset();
		const preferences = await (await apiFetch("/api/preferences")).json() as Record<string, unknown>;
		let sessionId: string | undefined;

		try {
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
			await expect(page.getByTestId("footer-model-id")).toHaveText(INITIAL_MODEL, { timeout: 15_000 });

			// The fixture emits three paced SDK stream frames. Its first text must be
			// visible before the final assistant frame, proving the translator uses
			// message_update rather than bulk message_end cards.
			await sendMessage(page, PACED_ROOT_PROMPT);
			const partial = page.locator("assistant-message").filter({ hasText: PACED_ROOT_PARTIAL });
			await expect(partial).toBeVisible({ timeout: 15_000 });
			await expect(partial).not.toContainText(PACED_ROOT_RESPONSE);
			await expect(partial).toHaveCount(1);
			await expect(partial).toContainText(PACED_ROOT_RESPONSE, { timeout: 15_000 });
			await waitForSessionStatus(sessionId, "idle", 15_000);
			await expectOneSettledRootResponse(page);

			// Exercise the same snapshot rehydration as navigating away and back,
			// then a full reload. Neither may leave a stale stream shell behind.
			await navigateToHash(page, "#/settings");
			await navigateToHash(page, `#/session/${sessionId}`);
			await expectOneSettledRootResponse(page);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expectOneSettledRootResponse(page);

			await expect.poll(() => readRuntimeTuple(page), { timeout: 15_000 }).toEqual({
				provider: PROVIDER,
				id: INITIAL_MODEL,
				thinkingLevel: "off",
				reasoning: true,
			});

			const sonnetLevels = await selectThinkingLevel(page, "Low");
			expect(sonnetLevels).toEqual(["Off", "Low", "High"]);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 15_000 }).toMatchObject({ id: INITIAL_MODEL, thinkingLevel: "low" });
			expect(claudeLiveControlsSdk.queries[0]?.effortSettings).toContainEqual({ effortLevel: "low" });

			await chooseModel(page, CLAUDE_LIVE_MODELS.haiku.resolvedModel);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 15_000 }).toMatchObject({
				provider: PROVIDER,
				id: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				thinkingLevel: "low",
				reasoning: true,
			});
			expect(claudeLiveControlsSdk.queries[0]?.setModels).toContain(CLAUDE_LIVE_MODELS.haiku.value);
			expect(claudeLiveControlsSdk.queries[0]?.effortSettings.at(-1)).toEqual({ effortLevel: "low" });

			const haikuLevels = await selectThinkingLevel(page, "Medium");
			expect(haikuLevels).toEqual(["Off", "Low", "Medium"]);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 15_000 }).toMatchObject({
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
			await expect(page.getByTestId("footer-model-id")).toHaveText(CLAUDE_LIVE_MODELS.haiku.resolvedModel, { timeout: 15_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Medium", { timeout: 15_000 });
			await expectOneSettledRootResponse(page);
			expect(claudeLiveControlsSdk.nativeSdkLoads).toBe(0);

			await chooseModel(page, CLAUDE_LIVE_MODELS.opus.resolvedModel);
			await expect.poll(() => readRuntimeTuple(page), { timeout: 15_000 }).toMatchObject({
				provider: PROVIDER,
				id: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				thinkingLevel: "medium",
			});
			expect(claudeLiveControlsSdk.queries[0]?.setModels).toContain(CLAUDE_LIVE_MODELS.opus.value);
			expect(gateway.sessionManager.getPersistedSession(sessionId)).toMatchObject({
				modelProvider: PROVIDER,
				modelId: CLAUDE_LIVE_MODELS.haiku.resolvedModel,
				effectiveThinkingLevel: "medium",
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.getByTestId("footer-model-id")).toHaveText(CLAUDE_LIVE_MODELS.haiku.resolvedModel, { timeout: 15_000 });
			await expect(page.locator(".thinking-select-compact")).toHaveAttribute("title", "Medium", { timeout: 15_000 });
			await expectOneSettledRootResponse(page);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
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
