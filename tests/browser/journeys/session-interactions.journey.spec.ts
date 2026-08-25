import {
	apiFetch,
	createSession,
	createSessionViaUI,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

/**
 * Ported from the retired legacy session-interactions E2E spec. This journey
 * keeps the cross-session continuity assertions together: a UI-created chat is
 * sent, another session is selected, and the original transcript survives both
 * switching back and a hard reload before deletion is reflected in the UI.
 */
test.describe("Journey: Session interactions", () => {
	test("create, send, switch, reload, and delete a session", async ({ page }) => {
		const created = new Set<string>();
		const prompt = "Hello from canonical session interaction journey";

		try {
			await openApp(page);
			const uiSessionId = await createSessionViaUI(page);
			created.add(uiSessionId);

			await sendMessage(page, prompt);
			await waitForAgentResponse(page);
			await waitForSessionStatus(uiSessionId, "idle");
			await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible();

			const apiSessionId = await createSession();
			created.add(apiSessionId);
			await waitForSessionStatus(apiSessionId, "idle");

			await navigateToHash(page, `#/session/${apiSessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page).toHaveURL(new RegExp(`#\\/session\\/${apiSessionId}$`));

			await navigateToHash(page, `#/session/${uiSessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

			await page.reload();
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

			await deleteSession(uiSessionId);
			created.delete(uiSessionId);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toBe("#/");
			await expect(page.locator(`[data-session-id="${uiSessionId}"]`)).toHaveCount(0, { timeout: 15_000 });

			const sessionsResponse = await apiFetch("/api/sessions");
			expect(sessionsResponse.ok).toBe(true);
			const sessions = ((await sessionsResponse.json()).sessions ?? []) as Array<{ id: string }>;
			expect(sessions.some((session) => session.id === uiSessionId)).toBe(false);
		} finally {
			await Promise.all([...created].map((id) => deleteSession(id)));
		}
	});
});
