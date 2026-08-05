// v2-native — real gateway/browser journey for durable prompt-prefix attribution.
import { createPrefixSeed } from "../../../src/server/agent/prompt-prefix-attribution.ts";
import {
	test,
	expect,
	apiFetch,
	createSession,
	deleteSession,
	openApp,
	navigateToHash,
	sendMessage,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const RAW_SENTINEL = "BROWSER-PREFIX-RAW-SENTINEL";

function attributionSeed(toolDescription: string) {
	return createPrefixSeed({
		system: `${RAW_SENTINEL}-system`,
		tools: { description: toolDescription, schema: { marker: `${RAW_SENTINEL}-tool-schema` } },
		skills: `${RAW_SENTINEL}-skills`,
		sessionSetupDynamicContext: `${RAW_SENTINEL}-dynamic-context`,
	});
}

async function prefixEntries(sessionId: string): Promise<any[]> {
	const response = await apiFetch(`/api/sessions/${sessionId}/prompt-prefix-attribution?limit=20`);
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(Array.isArray(body.entries)).toBe(true);
	return body.entries;
}

async function sendAndFinalize(page: import("@playwright/test").Page, sessionId: string, text: string): Promise<void> {
	const responses = page.getByText("OK", { exact: true });
	const before = await responses.count();
	await sendMessage(page, text);
	await expect(responses).toHaveCount(before + 1, { timeout: 15_000 });

	const finalized = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt: text }),
	});
	expect(finalized.status).toBe(200);
}

async function openPromptInspector(page: import("@playwright/test").Page): Promise<void> {
	const directAction = page.locator('[data-session-action-surface="header"][data-session-action-id="view-system-prompt"]').first();
	if (await directAction.isVisible().catch(() => false)) {
		await directAction.click();
	} else {
		await page.getByTestId("session-actions-trigger").first().click();
		const action = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="view-system-prompt"]').first();
		await expect(action).toBeVisible({ timeout: 5_000 });
		await action.click();
	}
	await expect(page.locator("system-prompt-dialog").getByText("System Prompt Inspector", { exact: true })).toBeVisible({ timeout: 10_000 });
}

test.describe("Journey: Prompt Prefix Attribution", () => {
	test("persists a hash-only stable prefix in the inspector across reload, then names a tool change", async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			const live = gateway.sessionManager?.getSession(sessionId) as any;
			expect(live, "journey requires the real session created by the gateway").toBeTruthy();
			live.prefixSeed = attributionSeed(`${RAW_SENTINEL}-tools-v1`);
			gateway.sessionManager.setupPromptPrefixAttribution(live, true);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			await sendAndFinalize(page, sessionId, `${RAW_SENTINEL} stable one`);
			await sendAndFinalize(page, sessionId, `${RAW_SENTINEL} stable two`);
			const stableEntries = await prefixEntries(sessionId);
			expect(stableEntries).toHaveLength(2);
			expect(stableEntries.at(-1)).toMatchObject({ comparison: "stable", providerCacheTelemetry: "unknown" });
			expect(JSON.stringify(stableEntries)).not.toContain(RAW_SENTINEL);

			await openPromptInspector(page);
			const dialog = page.locator("system-prompt-dialog");
			await expect(dialog.getByTestId("prompt-prefix-attribution-status")).toHaveText(/Stable prefix/);
			await expect(dialog.getByTestId("prompt-prefix-cache-status")).toHaveText("Provider cache: unknown");
			await dialog.getByTestId("prompt-prefix-attribution-details").locator("summary").click();
			const componentRows = dialog.getByTestId("prompt-prefix-component");
			await expect(componentRows).toHaveCount(4);
			await expect(componentRows).toHaveText([
				/^[a-f\d]{12} · \d+ bytes$/i,
				/^[a-f\d]{12} · \d+ bytes$/i,
				/^[a-f\d]{12} · \d+ bytes$/i,
				/^[a-f\d]{12} · \d+ bytes$/i,
			]);
			await expect(dialog).not.toContainText(RAW_SENTINEL);

			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await openPromptInspector(page);
			const reloadedDialog = page.locator("system-prompt-dialog");
			await expect(reloadedDialog.getByTestId("prompt-prefix-attribution-status")).toHaveText(/Stable prefix/);
			await expect(reloadedDialog.getByTestId("prompt-prefix-cache-status")).toHaveText("Provider cache: unknown");

			await reloadedDialog.evaluate((element) => element.remove());
			live.prefixSeed = attributionSeed(`${RAW_SENTINEL}-tools-v2`);
			await sendAndFinalize(page, sessionId, `${RAW_SENTINEL} tools changed`);
			const changedEntries = await prefixEntries(sessionId);
			expect(changedEntries.at(-1)).toMatchObject({ comparison: "changed", culprit: "tools", changed: ["tools"] });
			expect(JSON.stringify(changedEntries)).not.toContain(RAW_SENTINEL);

			await openPromptInspector(page);
			await expect(page.locator("system-prompt-dialog").getByTestId("prompt-prefix-attribution-status")).toContainText("Prefix changed: Tools");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
