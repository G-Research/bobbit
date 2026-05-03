/**
 * Archived session footer model — Part 2.
 *
 * On archived-session WebSocket auth, the server now pushes a `state` frame
 * with the persisted model so the footer shows the actual model the session
 * ran on, not the client-side `claude-opus-4-6` placeholder default seeded by
 * `RemoteAgent`.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Archived session footer model", () => {
	test("shows persisted model (not claude-opus-4-6 placeholder) on first connect", async ({ page }) => {
		// 1. Create session and wait for ready.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// 2. Open app, navigate to session.
		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// 3. Set a non-default model via the page's existing WebSocket. Mock
		// agent accepts any provider/modelId in `set_model`, and the server
		// persists `modelProvider`/`modelId` on the session row via
		// `persistSessionModel`. We use a model id that's neither the mock
		// default ("mock-model") nor the client placeholder ("claude-opus-4-6").
		await page.evaluate(() => {
			const s = (window as any).__bobbitState;
			if (!s?.remoteAgent) throw new Error("remoteAgent not available on window.__bobbitState");
			s.remoteAgent.setModel({ provider: "anthropic", id: "claude-sonnet-4-20250514" });
		});

		// Wait for the footer to reflect the new model so we know set_model was
		// processed and persistSessionModel ran on the server.
		await expect(page.locator('[data-testid="footer-model-id"]'))
			.toHaveText("claude-sonnet-4-20250514", { timeout: 10_000 });

		// 4. Send a message to cement an event-buffer entry, then archive.
		await sendMessage(page, "hello before archive");
		await waitForAgentResponse(page);
		await waitForSessionStatus(sessionId, "idle");

		const termResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(termResp.ok).toBe(true);

		// 5. Reload to clear all client-side state, then navigate back to the
		// archived session. The footer must show the persisted model
		// immediately on first WS connect \u2014 no `get_state` round-trip.
		await page.reload();
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);

		// Wait for archived-blob marker so we know the page has loaded the
		// session in archived mode.
		await expect(page.locator(".bobbit-blob--archived")).toBeVisible({ timeout: 10_000 });

		// 6. Footer must show the persisted model, NOT the placeholder.
		const footerModel = page.locator('[data-testid="footer-model-id"]');
		await expect(footerModel).toBeVisible({ timeout: 10_000 });
		await expect(footerModel).toHaveText("claude-sonnet-4-20250514");
		await expect(footerModel).not.toHaveText("claude-opus-4-6");

		// 7. Footer model picker must remain read-only (existing archived-session
		// invariant). Archived sessions don't render the prompt textarea — they
		// show the "Continue in New Session" affordance instead.
		await expect(page.locator("textarea")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Continue in New Session/i })).toBeVisible();

		await deleteSession(sessionId).catch(() => {});
	});
});
