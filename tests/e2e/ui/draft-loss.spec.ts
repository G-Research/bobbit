/** Browser E2E coverage for prompt draft persistence across session switches and hard reloads. */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForHealth, waitForSessionStatus, apiFetch, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

async function navigateToSession(page: import("@playwright/test").Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

async function waitForAppShell(page: import("@playwright/test").Page): Promise<void> {
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Draft persistence bugs", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("draft survives send→switch→reload and immediate hard reload", async ({ page }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		const sessionC = await createSession();
		try {
			await Promise.all([sessionA, sessionB, sessionC].map((id) => waitForSessionStatus(id, "idle")));
			await openApp(page);

			// Scenario 1: after sending in A, switching away and back must not make
			// the next saved draft look stale compared with draft-send-gen.
			await navigateToSession(page, sessionA);
			await sendMessage(page, "hello agent");
			await waitForAgentResponse(page, { timeout: 15_000 });
			const sendGen = await page.evaluate((id) => parseInt(sessionStorage.getItem(`draft-send-gen-${id}`) || "0", 10), sessionA);
			expect(sendGen).toBeGreaterThan(0);

			await navigateToSession(page, sessionB);
			await navigateToSession(page, sessionA);
			const draftAfterSwitch = "important draft after switch";
			await page.locator("textarea").first().fill(draftAfterSwitch);
			const manualGen = 1;
			await apiFetch(`/api/sessions/${sessionA}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: draftAfterSwitch, gen: manualGen } }),
			});
			expect(manualGen).toBeLessThanOrEqual(sendGen);

			await page.reload();
			await waitForAppShell(page);
			await navigateToSession(page, sessionA);
			await expect(async () => {
				const val = await page.locator("textarea").first().inputValue();
				expect(val).toBe(draftAfterSwitch);
			}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });

			// Scenario 2: an immediate hard reload in the same JS tick as typing
			// must still flush the prompt draft via beforeunload/sendBeacon.
			await navigateToSession(page, sessionC);
			await page.waitForFunction(() => {
				const ta = document.querySelector("textarea");
				const me = document.querySelector("message-editor");
				return !!ta && !!me;
			}, null, { timeout: 5_000 });
			const hardReloadDraft = "draft lost on immediate reload";
			await page.evaluate((text) => {
				const textarea = document.querySelector("textarea");
				if (!textarea) throw new Error("No textarea");
				textarea.value = text;
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
				window.location.reload();
			}, hardReloadDraft);

			await waitForAppShell(page);
			await navigateToSession(page, sessionC);
			await expect(async () => {
				const val = await page.locator("textarea").first().inputValue();
				expect(val).toBe(hardReloadDraft);
			}).toPass({ intervals: [250, 500, 1000, 1000, 2000, 2000], timeout: 20_000 });
		} finally {
			await Promise.all([sessionA, sessionB, sessionC].map((id) => deleteSession(id).catch(() => { /* best-effort */ })));
		}
	});
});
