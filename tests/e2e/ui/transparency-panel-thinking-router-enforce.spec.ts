/**
 * Browser E2E: Transparency Panel — real F14 thinking router in CLF-W3 apply
 * mode (`BOBBIT_CLF_THINKING_ROUTER=enforce`).
 *
 * This is a sibling of transparency-panel.spec.ts instead of another describe
 * in that file because the gateway env flag is worker-scoped. The default spec
 * proves observe mode renders `selected: xhigh` without `(applied)`; this file
 * boots its own worker with enforce mode and proves the same real production
 * decision row renders `selected: xhigh (applied)`.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.use({ enableThinkingRouterApply: true });

test.describe("Transparency Panel — real F14 thinking router (CLF-W3 enforce mode)", () => {
	let sessionId = "";

	test.afterEach(async () => {
		if (sessionId) {
			try {
				await deleteSession(sessionId);
			} catch {
				/* best-effort cleanup */
			}
			sessionId = "";
		}
	});

	test("a real 'ultrathink' prompt renders the xhigh SELECT decision as applied", async ({ page }) => {
		sessionId = await createSession();

		const beforePromptResp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(beforePromptResp.ok).toBe(true);

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await sendMessage(page, "ultrathink: please redesign the auth flow");
		await waitForAgentResponse(page);

		const toggle = page.locator('[data-testid="transparency-panel-toggle"]').first();
		await expect(toggle).toBeVisible({ timeout: 15_000 });
		await expect(toggle).toContainText("1 decision");

		await toggle.click();
		const rows = page.locator('[data-testid="transparency-panel-rows"]');
		await expect(rows).toBeVisible();
		await expect(rows).toContainText("user-prompt-submit");
		await expect(rows).toContainText("thinking");
		await expect(rows).toContainText("selected: xhigh (applied)");
		await expect(rows).toContainText("consulted 1");

		await page.locator('[data-testid="transparency-panel-row-toggle"]').first().click();
		await expect(rows).toContainText("builtin.thinking-router");
		await expect(rows).toContainText("applied: yes");
		await expect(rows).toContainText("matched deterministic rule 'ultrathink'");
	});
});
